import { spawn } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { microphoneInput, screenInput } from './teach-capture.js';
import { processBundle, pythonPath } from './teach-process.js';
import { sessionId, teachRoot, validId } from './teach.js';

const readJson = path => readFile(path, 'utf8').then(JSON.parse, () => null);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

function launchRecorder(dir) {
  return new Promise((resolveLaunch, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./teach-recorder.js', import.meta.url)), dir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolveLaunch(child.pid); });
  });
}

// A teach session: the desktop recorder (screen, microphone, input hooks,
// windows) is the core; the browser extension adds URLs, DOM elements and
// tabs when Chrome is connected. Everything shares the clock t0.
export function createTeachSession({ root = teachRoot(), now = Date.now, browserLayer, findMicrophone = microphoneInput, findScreen = screenInput, launch = launchRecorder, process: processImpl = processBundle, python = pythonPath(), readyTimeout = 20000, stopTimeout = 30000 } = {}) {
  const activePath = join(root, 'active.json');

  async function active() {
    const state = await readJson(activePath);
    if (state && state.recorderPid && !alive(state.recorderPid) && !(await readJson(join(state.dir, 'desktop.json')))?.state?.startsWith('stop')) return { ...state, stale: true };
    return state;
  }

  async function start({ name = '', mic, audioFile, audio = true, desktop = true, browser = true } = {}) {
    const current = await active();
    if (current && !current.stale) throw new Error(`A teach session is already recording: ${current.id} (stop it with: teach stop)`);
    if (typeof name !== 'string' || name.length > 120) throw new Error('name must be a string of at most 120 characters');
    const t0 = now();
    const id = sessionId(name, new Date(t0));
    const dir = join(root, id);
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    const config = { t0,
      audio: !audio ? null : audioFile ? { device: `file:${resolve(audioFile)}`, args: ['-re', '-i', resolve(audioFile)] } : await findMicrophone({ mic }),
      screen: desktop ? findScreen() : null,
      hooks: desktop ? { python, script: fileURLToPath(new URL('../scripts/teach-hooks.py', import.meta.url)) } : null };
    await writeFile(join(dir, 'recorder.json'), JSON.stringify(config, null, 2) + '\n');
    const recorderPid = await launch(dir);
    let recorder;
    for (const deadline = now() + readyTimeout; now() < deadline; await wait(200)) {
      recorder = await readJson(join(dir, 'desktop.json'));
      if (recorder && ['recording', 'failed'].includes(recorder.state)) break;
    }
    if (recorder?.state !== 'recording') {
      await writeFile(join(dir, 'stop.request'), '');
      throw new Error(`The desktop recorder did not start: ${recorder?.error || 'no status within ' + readyTimeout / 1000 + ' s'}`);
    }
    let browserState = { status: 'off', reason: 'Not requested (--no-browser)' };
    if (browser && browserLayer) {
      try {
        const result = await browserLayer.start({ id, t0, dir, name });
        browserState = { status: 'recording', browserId: result.browserId };
      } catch (error) { browserState = { status: 'off', reason: error.message }; }
    }
    const state = { id, name, dir, t0, startedAt: new Date(t0).toISOString(), recorderPid, browser: browserState, audio: recorder.audio, screen: recorder.screen, hooks: recorder.hooks };
    await writeFile(activePath, JSON.stringify(state, null, 2) + '\n');
    return { ...state, state: 'recording' };
  }

  async function stop({ transcribe = true, sync, onProgress = () => {} } = {}) {
    const state = await active();
    if (!state) {
      await browserLayer?.stop().catch(() => {});
      throw new Error('No teach session is recording');
    }
    const endedAt = now();
    const notes = [];
    let browser = state.browser;
    if (browser.status === 'recording') {
      try {
        const result = await browserLayer.stop();
        browser = { ...browser, status: 'recorded', events: result.events, screenshots: result.screenshots };
        notes.push(...(result.notes || []));
      } catch (error) { browser = { ...browser, status: 'failed', reason: error.message }; notes.push(`Browser layer: ${error.message}`); }
    }
    await writeFile(join(state.dir, 'stop.request'), '');
    onProgress('Finishing the screen and audio files…');
    let recorder;
    for (const deadline = now() + stopTimeout; now() < deadline; await wait(250)) {
      recorder = await readJson(join(state.dir, 'desktop.json'));
      if (recorder?.state === 'stopped' || recorder?.state === 'failed' || !alive(state.recorderPid)) break;
    }
    if (recorder?.state !== 'stopped') notes.push(`Desktop recorder did not finish cleanly (${recorder?.state || 'no status'}${recorder?.error ? `: ${recorder.error}` : ''})`);
    const manifest = { id: state.id, name: state.name, dir: state.dir, t0: state.t0, startedAt: state.startedAt, endedAt: new Date(endedAt).toISOString(), durationMs: endedAt - state.t0,
      audio: recorder?.audio || state.audio, screen: recorder?.screen || state.screen, hooks: recorder?.hooks || state.hooks, browser, notes };
    await writeFile(join(state.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await unlink(activePath).catch(() => {});
    await unlink(join(state.dir, 'stop.request')).catch(() => {});
    onProgress('Transcribing and building the timeline…');
    return { manifest, result: await processImpl(state.dir, { transcribe, sync }) };
  }

  async function reprocess({ id, transcribe = true, sync } = {}) {
    if (!validId(id)) throw new Error('id must be a recording id');
    const dir = join(root, id);
    const manifest = await readJson(join(dir, 'manifest.json'));
    if (!manifest) throw new Error(`No finished recording ${id} in ${root}`);
    return { manifest, result: await processImpl(dir, { transcribe, sync }) };
  }

  async function status() {
    const state = await active();
    if (!state) return { state: 'idle', root };
    return { ...state, state: state.stale ? 'recorder-gone' : 'recording', recorder: await readJson(join(state.dir, 'desktop.json')) };
  }

  return { start, stop, reprocess, status };
}
