import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { microphoneInput, startAudioCapture } from './teach-audio.js';
import { processBundle } from './teach-process.js';

export const teachRoot = () => resolve(process.env.AGENT_BROWSER_TEACH_DIR || join(homedir(), 'teach-recordings'));

export function sessionId(name, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  const slug = String(name || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-').slice(0, 40);
  return slug ? `${stamp}-${slug}` : stamp;
}

// One teach session at a time per bridge. Browser events arrive as pushed
// messages; this module owns everything written to the bundle directory.
export function createTeach({ send, root = teachRoot, now = Date.now, findMicrophone = microphoneInput, captureAudio = startAudioCapture, process: processImpl = processBundle } = {}) {
  let session = null;
  const finished = new Map();

  const manifestOf = item => ({ id: item.id, name: item.name, dir: item.dir, browserId: item.browserId, t0: item.t0,
    startedAt: new Date(item.t0).toISOString(), endedAt: item.endedAt ? new Date(item.endedAt).toISOString() : null,
    durationMs: item.endedAt ? item.endedAt - item.t0 : null, events: item.seq, screenshots: item.screenshots, audio: item.audio });
  const saveManifest = item => writeFile(join(item.dir, 'manifest.json'), JSON.stringify(manifestOf(item), null, 2) + '\n');
  function write(item, record) {
    item.writes = item.writes.then(() => appendFile(join(item.dir, 'events.jsonl'), JSON.stringify(record) + '\n'));
    item.writes.catch(error => { item.writeError ||= error; });
    return item.writes;
  }

  async function start({ browserId, name = '', mic, audioFile, audio = true } = {}) {
    if (session) throw new Error(`A teach session is already recording: ${session.id} (stop it with: teach stop)`);
    if (typeof name !== 'string' || name.length > 120) throw new Error('name must be a string of at most 120 characters');
    const t0 = now();
    const id = sessionId(name, new Date(t0));
    const dir = join(typeof root === 'function' ? root() : root, id);
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    const item = { id, name, dir, browserId, t0, seq: 0, screenshots: 0, writes: Promise.resolve(), audio: { status: 'off', reason: 'Audio was not requested' } };
    session = item;
    try {
      if (audio) {
        const input = audioFile ? { device: `file:${resolve(audioFile)}`, args: ['-re', '-i', resolve(audioFile)] } : await findMicrophone({ mic });
        if (input.error) item.audio = { status: 'unavailable', reason: input.error };
        else {
          const capture = captureAudio({ input: input.args, output: join(dir, 'audio.wav'), now });
          await capture.ready;
          if (capture.exited || capture.startedAt === null) {
            await capture.stop();
            item.audio = { status: 'unavailable', device: input.device, reason: `FFmpeg could not record from ${input.device}: ${capture.stderr.trim() || `exit ${capture.code ?? 'timeout'}`}` };
          } else {
            item.capture = capture;
            item.audio = { status: 'recording', device: input.device, file: 'audio.wav', startOffsetMs: Math.round(capture.startedAt - t0) };
          }
        }
      }
      const result = await send(browserId, 'teach.start', { sessionId: id, t0 });
      await write(item, { seq: 0, kind: 'session_start', ts: t0, time: new Date(t0).toISOString(), offsetMs: 0, name, tabs: result?.tabs || [] });
      await saveManifest(item);
    } catch (error) {
      session = null;
      await item.capture?.stop();
      if (/Unknown method: teach\./.test(error.message)) throw new Error('The Chrome extension does not support teach recording yet. Pull the latest agent-browser and reload the extension at chrome://extensions, then try again.');
      throw error;
    }
    return { ...manifestOf(item), state: 'recording' };
  }

  async function ingest(browserId, message) {
    const item = session;
    if (!item || message.sessionId !== item.id || browserId !== item.browserId || !message.event || typeof message.event !== 'object') return;
    const event = { ...message.event };
    const seq = ++item.seq;
    const ts = Number.isFinite(event.ts) ? event.ts : now();
    const record = { seq, ...event, ts, time: new Date(ts).toISOString(), offsetMs: ts - item.t0 };
    if (typeof message.screenshot === 'string' && message.screenshot) {
      const file = `screenshots/${String(seq).padStart(4, '0')}-${String(event.kind || 'event').replace(/[^\w-]/g, '')}.jpg`;
      item.screenshots++;
      record.screenshot = file;
      item.writes = item.writes.then(() => writeFile(join(item.dir, file), Buffer.from(message.screenshot, 'base64')));
    }
    await write(item, record);
  }

  async function stop({ browserId, transcribe = true, sync } = {}) {
    const item = session;
    if (!item) {
      // A restarted bridge forgets its session while the extension may still log.
      await send(browserId, 'teach.stop', {}).catch(() => {});
      throw new Error('No teach session is recording');
    }
    session = null;
    item.endedAt = now();
    const notes = [];
    try { await send(item.browserId, 'teach.stop', { sessionId: item.id }); }
    catch (error) { notes.push(`Browser did not confirm the stop: ${error.message}`); }
    if (item.capture) {
      const capture = await item.capture.stop();
      item.audio = capture.code === 0 || capture.code === 255 ? { ...item.audio, status: 'recorded' } : { ...item.audio, status: 'failed', reason: capture.stderr.trim() || `FFmpeg exit ${capture.code}` };
    }
    await write(item, { seq: ++item.seq, kind: 'session_stop', ts: item.endedAt, time: new Date(item.endedAt).toISOString(), offsetMs: item.endedAt - item.t0, ...(notes.length ? { notes } : {}) });
    await item.writes.catch(() => {});
    await saveManifest(item);
    const job = { id: item.id, dir: item.dir, state: 'processing', manifest: manifestOf(item), notes };
    finished.set(item.id, job);
    job.done = processImpl(item.dir, { transcribe, sync }).then(result => { Object.assign(job, { state: 'done', result }); }, error => { Object.assign(job, { state: 'failed', error: error.message }); });
    return { ...job.manifest, state: 'processing', notes };
  }

  async function reprocess({ id, transcribe = true, sync } = {}) {
    if (typeof id !== 'string' || !/^[\w.-]+$/.test(id)) throw new Error('id must be a recording id');
    const dir = join(typeof root === 'function' ? root() : root, id);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const job = { id, dir, state: 'processing', manifest, notes: [] };
    finished.set(id, job);
    job.done = processImpl(dir, { transcribe, sync }).then(result => { Object.assign(job, { state: 'done', result }); }, error => { Object.assign(job, { state: 'failed', error: error.message }); });
    return { ...manifest, state: 'processing' };
  }

  function status({ id } = {}) {
    if (session && (!id || id === session.id)) return { ...manifestOf(session), state: 'recording' };
    const job = id ? finished.get(id) : [...finished.values()].at(-1);
    if (!job) return { state: 'idle' };
    const { done, ...rest } = job;
    return rest;
  }

  return {
    start, stop, ingest, status, reprocess,
    active: () => session && { id: session.id, browserId: session.browserId },
    close: async () => { if (session) await stop({ transcribe: false, sync: false }).catch(() => {}); await Promise.allSettled([...finished.values()].map(job => job.done)); }
  };
}
