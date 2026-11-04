// Desktop recorder for a teach session, started detached by `teach start` in
// the person's own desktop session: microphone and screen through FFmpeg, and
// mouse, keyboard and window events through scripts/teach-hooks.py, all on
// the session clock t0. It stops when <bundle>/stop.request appears.
//
// Usage: node src/teach-recorder.js <bundle-dir>   (reads recorder.json there)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { audioOutput, startCapture, videoOutput } from './teach-capture.js';

export async function record(dir, { now = Date.now, spawnImpl = spawn, capture = startCapture, pollMs = 300 } = {}) {
  const config = JSON.parse(await readFile(join(dir, 'recorder.json'), 'utf8'));
  const { t0 } = config;
  const status = { state: 'starting', pid: process.pid, audio: { status: 'off' }, screen: { status: 'off' }, hooks: { status: 'off' } };
  // Status readers poll concurrently; never expose a truncated JSON document.
  const save = async () => {
    const temp = join(dir, `desktop.${process.pid}.tmp`);
    await writeFile(temp, JSON.stringify(status, null, 2) + '\n');
    await rename(temp, join(dir, 'desktop.json'));
  };
  let writes = Promise.resolve();
  let seq = 0;
  const log = event => {
    const ts = Number.isFinite(event.ts) ? event.ts : now();
    const line = JSON.stringify({ seq: ++seq, source: 'desktop', ...event, ts, time: new Date(ts).toISOString(), offsetMs: ts - t0 }) + '\n';
    writes = writes.then(() => appendFile(join(dir, 'desktop-events.jsonl'), line));
    return writes;
  };
  await save();

  const captures = {};
  async function begin(name, input, file, outputArgs) {
    if (!input) return;
    if (input.error) { status[name] = { status: 'unavailable', reason: input.error }; return; }
    const item = capture({ input: input.args, output: join(dir, file), outputArgs, now });
    await item.ready;
    if (item.exited || item.startedAt === null) {
      await item.stop();
      status[name] = { status: 'unavailable', device: input.device, reason: `FFmpeg could not record from ${input.device}: ${item.stderr.trim() || `exit ${item.code ?? 'timeout'}`}` };
      return;
    }
    captures[name] = item;
    status[name] = { status: 'recording', device: input.device, file, startOffsetMs: Math.round(item.startedAt - t0) };
  }

  let hooks;
  let hooksReady;
  if (config.hooks) {
    hooks = spawnImpl(config.hooks.python, [config.hooks.script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    hooks.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    hooks.stdin.on('error', () => {});
    hooks.closed = new Promise(resolve => { hooks.once('close', resolve); hooks.once('error', error => { stderr ||= error.message; resolve(); }); });
    hooksReady = new Promise(resolve => {
      const timer = setTimeout(() => resolve({ error: `Input hooks did not start within 15 seconds${stderr ? `: ${stderr.trim()}` : ''}` }), 15000);
      hooks.closed.then(() => { clearTimeout(timer); resolve({ error: `Input hooks exited: ${stderr.trim() || 'no output'}` }); });
      createInterface({ input: hooks.stdout }).on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        if (event.kind === 'hooks_ready') { clearTimeout(timer); resolve({ screen: event.screen }); }
        else if (event.kind === 'hooks_error') { clearTimeout(timer); resolve({ error: event.error }); }
        else log(event);
      });
    });
  }
  await Promise.all([begin('audio', config.audio, 'audio.wav', audioOutput), begin('screen', config.screen, 'screen.mkv', videoOutput)]);
  if (hooksReady) {
    const ready = await hooksReady;
    status.hooks = ready.error ? { status: 'unavailable', reason: ready.error } : { status: 'recording', screen: ready.screen };
  }
  status.state = 'recording';
  await save();

  const deadline = t0 + (config.maxMs || 4 * 60 * 60 * 1000);
  while (!existsSync(join(dir, 'stop.request')) && now() < deadline) await new Promise(resolve => setTimeout(resolve, pollMs));
  status.state = 'stopping';
  if (now() >= deadline) status.note = 'Stopped automatically at the maximum session length';
  if (hooks) { hooks.stdin.end(); const timer = setTimeout(() => hooks.kill(), 5000); await hooks.closed; clearTimeout(timer); }
  for (const [name, item] of Object.entries(captures)) {
    await item.stop();
    if (item.code !== 0 && item.code !== 255) status[name] = { ...status[name], status: 'failed', reason: item.stderr.trim() || `FFmpeg exit ${item.code}` };
    else status[name].status = 'recorded';
  }
  if (status.hooks.status === 'recording') status.hooks.status = 'recorded';
  await writes;
  status.state = 'stopped';
  status.stoppedAt = now();
  await save();
  return status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  record(process.argv[2]).catch(async error => {
    await writeFile(join(process.argv[2], 'desktop.json'), JSON.stringify({ state: 'failed', error: error.message }, null, 2) + '\n').catch(() => {});
    process.exitCode = 1;
  });
}
