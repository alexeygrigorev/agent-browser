import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';

function jpeg(result) {
  if (typeof result?.data !== 'string') throw new Error('Screenshot capture did not return base64 JPEG data');
  const frame = Buffer.from(result.data, 'base64');
  if (frame.length < 4 || frame[0] !== 0xff || frame[1] !== 0xd8) throw new Error('Screenshot capture must return a JPEG image');
  return frame;
}

export function createRecordings({ capture }) {
  if (typeof capture !== 'function') throw new Error('A screenshot capture callback is required');
  const active = new Map();
  let closed = false;
  const starts = new Set();
  const metadata = item => ({ id: item.id, path: item.path, format: 'webm', browserId: item.browserId,
    tabId: item.tabId, fps: item.fps, startedAt: item.startedAt });

  async function begin({ browserId, tabId, path, fps = 5 } = {}) {
    if (closed) throw new Error('Recording service is closed');
    if (typeof browserId !== 'string' || !browserId) throw new Error('browserId is required');
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error('tabId must be a non-negative integer');
    if (!Number.isFinite(fps) || fps < 1 || fps > 30) throw new Error('fps must be between 1 and 30');
    if (path !== undefined && (typeof path !== 'string' || !path)) throw new Error('path must be a non-empty string');
    const firstFrame = jpeg(await capture(browserId, tabId));
    if (closed) throw new Error('Recording service is closed');
    const id = randomUUID();
    const outputPath = path ? resolve(path) : join(homedir(), '.agent-browser', 'recordings', `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}.webm`);
    await mkdir(dirname(outputPath), { recursive: true });
    // Reserve the destination exclusively; FFmpeg never opens user paths itself.
    const file = await open(outputPath, 'wx');
    const output = file.createWriteStream();
    const item = { id, path: outputPath, browserId, tabId, fps, startedAt: new Date().toISOString(),
      startTime: performance.now(), latest: firstFrame, capturing: false, stopping: false, frames: 0, stderr: '' };
    let child;
    try {
      child = spawn(process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'mjpeg', '-i', 'pipe:0',
        '-an', '-c:v', 'libvpx-vp9', '-threads', '2', '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p',
        '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-f', 'webm', 'pipe:1'
      ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      output.destroy();
      await file.close().catch(() => {});
      await unlink(outputPath).catch(() => {});
      throw new Error(`Could not start FFmpeg: ${error.message}`);
    }
    item.child = child;
    const fail = error => {
      item.failure ||= error instanceof Error ? error : new Error(String(error));
      clearInterval(item.timer);
      if (!child.stdin.destroyed) child.stdin.end();
    };
    child.stderr.on('data', data => { item.stderr = (item.stderr + data.toString()).slice(-8192); });
    child.stdin.on('error', fail);
    child.on('error', error => fail(new Error(`Could not run FFmpeg: ${error.message}. Install FFmpeg or set AGENT_BROWSER_FFMPEG.`)));
    item.exited = new Promise(resolveExit => child.once('close', (code, signal) => {
      clearInterval(item.timer);
      if (code !== 0) fail(new Error(`FFmpeg exited ${signal || code}${item.stderr ? `: ${item.stderr.trim()}` : ''}`));
      resolveExit();
    }));
    // Observe pipeline failures immediately, even if stop has not yet been called.
    item.written = pipeline(child.stdout, output).catch(error => { fail(error); child.kill(); });
    try {
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
    } catch {
      await Promise.all([item.exited, item.written]);
      await unlink(outputPath).catch(() => {});
      throw item.failure;
    }
    const writeFrame = () => {
      if (item.stopping || item.failure || child.stdin.destroyed) return;
      // Keep just one latest frame; never add another frame while stdin is backed up.
      if (!child.stdin.writableNeedDrain) {
        child.stdin.write(item.latest);
        item.frames++;
      }
    };
    writeFrame();
    item.timer = setInterval(() => {
      writeFrame();
      if (item.stopping || item.failure || item.capturing) return;
      item.capturing = true;
      Promise.resolve().then(() => capture(browserId, tabId)).then(result => {
        if (!item.stopping && !item.failure) item.latest = jpeg(result);
      }).catch(error => { if (!item.stopping) fail(error); }).finally(() => { item.capturing = false; });
    }, 1000 / fps);
    active.set(id, item);
    return metadata(item);
  }

  function start(params) {
    const pending = begin(params);
    starts.add(pending);
    pending.then(() => starts.delete(pending), () => starts.delete(pending));
    return pending;
  }

  async function stop({ id } = {}) {
    const item = active.get(id);
    if (!item) throw new Error(`No active recording: ${id}`);
    if (item.finishing) return item.finishing;
    item.stopping = true;
    clearInterval(item.timer);
    item.finishing = (async () => {
      const endTime = performance.now();
      const timeout = setTimeout(() => {
        item.failure ||= new Error('FFmpeg did not finish within 15 seconds');
        item.child.kill('SIGKILL');
      }, 15000);
      try {
        if (!item.child.stdin.destroyed) item.child.stdin.end();
        await Promise.all([item.exited, item.written]);
        if (item.failure) throw item.failure;
        const { size } = await stat(item.path);
        return { ...metadata(item), bytes: size, duration: (endTime - item.startTime) / 1000, frames: item.frames };
      } finally {
        clearTimeout(timeout);
        active.delete(id);
      }
    })();
    return item.finishing;
  }

  return {
    start, stop,
    list: () => [...active.values()].map(item => ({ ...metadata(item), state: item.failure ? 'failed' : item.stopping ? 'stopping' : 'recording', ...(item.failure ? { error: item.failure.message } : {}) })),
    close: async () => {
      closed = true;
      await Promise.allSettled([...starts]);
      const results = await Promise.allSettled([...active.keys()].map(id => stop({ id })));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Some recordings could not be finalized');
    }
  };
}
