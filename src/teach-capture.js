import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ffmpegPath = () => process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg';

// Lists DirectShow audio capture devices. FFmpeg prints them on stderr and
// exits non-zero because "dummy" is not a real input.
export function parseDshowAudioDevices(output) {
  const devices = [];
  let section = null;
  for (const line of output.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) { section = 'audio'; continue; }
    if (/DirectShow video devices/i.test(line)) { section = 'video'; continue; }
    if (/Alternative name/i.test(line)) continue;
    const match = line.match(/"([^"]+)"(?:\s+\((audio|video|none)\))?/);
    if (!match) continue;
    const kind = match[2] || section;
    if (kind === 'audio' && !devices.includes(match[1])) devices.push(match[1]);
  }
  return devices;
}

async function listDshowAudio() {
  try {
    const { stderr } = await run(ffmpegPath(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true, timeout: 15000 });
    return parseDshowAudioDevices(stderr);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('FFmpeg is not installed or not on PATH (set AGENT_BROWSER_FFMPEG)');
    return parseDshowAudioDevices(`${error.stderr || ''}`);
  }
}

async function registryValue(key) {
  try {
    const { stdout } = await run('reg', ['query', key, '/v', 'Value'], { windowsHide: true, timeout: 5000 });
    return stdout.match(/Value\s+REG_SZ\s+(\S+)/)?.[1] || null;
  } catch { return null; }
}

// Explains, as exactly as Windows lets a user-scope process tell, why no
// microphone is available.
export async function diagnoseWindowsMicrophone({ query = registryValue } = {}) {
  const store = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
  const [machine, user, desktopApps] = await Promise.all([query(`HKLM\\${store}`), query(`HKCU\\${store}`), query(`HKCU\\${store}\\NonPackaged`)]);
  const settings = `machine=${machine || 'unset'}, user=${user || 'unset'}, desktop apps=${desktopApps || 'unset'}`;
  if (machine === 'Deny') return `Windows microphone access is turned off for this device (${settings}). Turn on Settings > Privacy & security > Microphone > "Microphone access" (needs an administrator).`;
  if (user === 'Deny') return `Windows microphone access is turned off for this user (${settings}). Turn on Settings > Privacy & security > Microphone > "Microphone access".`;
  if (desktopApps === 'Deny') return `Windows blocks desktop apps from the microphone (${settings}). Turn on Settings > Privacy & security > Microphone > "Let desktop apps access your microphone".`;
  return `No microphone capture device is visible to FFmpeg/DirectShow, while Windows privacy settings allow microphone use (${settings}). Plug in or enable a microphone (Settings > System > Sound > Input), then start a new session.`;
}

// Chooses the FFmpeg input for the microphone, or explains why there is none.
export async function microphoneInput({ mic = process.env.AGENT_BROWSER_MIC, platform = process.platform, listDevices = listDshowAudio, diagnose = diagnoseWindowsMicrophone } = {}) {
  if (platform === 'win32') {
    const devices = await listDevices();
    if (mic) {
      const device = devices.find(name => name === mic) || devices.find(name => name.toLowerCase().includes(mic.toLowerCase()));
      if (!device) return { error: `Microphone "${mic}" was not found. Available audio devices: ${devices.length ? devices.join('; ') : 'none'}` };
      return { device, args: ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${device}`] };
    }
    if (!devices.length) return { error: await diagnose() };
    return { device: devices[0], args: ['-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${devices[0]}`] };
  }
  if (platform === 'darwin') return { device: mic || ':default', args: ['-f', 'avfoundation', '-i', mic || ':default'] };
  return { device: mic || 'default', args: ['-f', 'pulse', '-i', mic || 'default'] };
}

// Screen video for the whole desktop at a low frame rate; screenshots for
// actions are cut from it afterwards.
export function screenInput({ platform = process.platform, display = process.env.DISPLAY, fps = 3 } = {}) {
  if (platform === 'win32') return { device: 'desktop (gdigrab)', args: ['-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1', '-i', 'desktop'] };
  if (platform === 'linux' && display) return { device: `X11 ${display}`, args: ['-f', 'x11grab', '-framerate', String(fps), '-draw_mouse', '1', '-i', display] };
  return { error: platform === 'linux' ? 'No X11 display (DISPLAY is not set)' : `Screen recording is not supported on ${platform}` };
}
export const audioOutput = ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
export const videoOutput = ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-crf', '32', '-pix_fmt', 'yuv420p', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2'];

// Runs one FFmpeg capture (microphone, a file played in real time, or the
// screen). FFmpeg's progress output tells when the first sample was captured,
// so the start can be placed on the session clock. A capture can never start
// before FFmpeg itself; that bound matters for -re file input, whose reported
// time runs ahead of the wall clock.
export function startCapture({ input, output, outputArgs = audioOutput, now = Date.now, spawnImpl = spawn, readyTimeout = 8000 }) {
  const spawnedAt = now();
  const child = spawnImpl(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', ...input, ...outputArgs,
    '-progress', 'pipe:1', '-stats_period', '0.5', '-n', output], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const state = { child, startedAt: null, stderr: '', exited: false, code: null, samples: 0 };
  let buffered = '';
  let outTime = null;
  child.stdout.on('data', chunk => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'out_time_us' && /^[0-9]+$/.test(value)) outTime = Number(value);
      if (key === 'progress' && outTime !== null) {
        // The earliest arrival minus captured duration is the tightest bound.
        const start = Math.max(spawnedAt, now() - outTime / 1000);
        if (outTime > 0 && state.samples < 20) { state.startedAt = state.startedAt === null ? start : Math.min(state.startedAt, start); state.samples++; }
        outTime = null;
      }
    }
  });
  child.stderr.on('data', chunk => { state.stderr = (state.stderr + chunk.toString()).slice(-4000); });
  state.closed = new Promise(resolve => {
    child.once('error', error => { state.stderr ||= error.code === 'ENOENT' ? 'FFmpeg is not installed or not on PATH (set AGENT_BROWSER_FFMPEG)' : error.message; state.exited = true; resolve(); });
    child.once('close', code => { state.exited = true; state.code = code; resolve(); });
  });
  state.ready = new Promise(resolve => {
    const timer = setInterval(() => { if (state.startedAt !== null || state.exited) { clearInterval(timer); clearTimeout(limit); resolve(); } }, 50);
    const limit = setTimeout(() => { clearInterval(timer); resolve(); }, readyTimeout);
  });
  state.stop = async () => {
    if (!state.exited) {
      child.stdin.write('q');
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 10000);
      await state.closed;
      clearTimeout(timer);
    }
    return state;
  };
  child.stdin.on('error', () => {});
  return state;
}
