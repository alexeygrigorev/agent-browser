import { createClient } from './client.js';
import { createTeachSession } from './teach-session.js';

export const teachUsage = `Usage: teach start [--name <text>] [--mic <device>] [--no-audio] [--no-desktop] [--no-browser] [--audio-file <path>]
       teach stop [--no-transcribe] [--no-sync | --sync <ssh-host>:<dir>]
       teach status
       teach process <id> [--no-transcribe] [--no-sync | --sync <ssh-host>:<dir>]`;

export function teachParams(args) {
  const [action, ...rest] = args;
  const params = {};
  const take = flag => { if (!rest.length || rest[0].startsWith('--')) throw new Error(`${flag} needs a value\n${teachUsage}`); return rest.shift(); };
  if (action === 'process') {
    if (!rest[0] || rest[0].startsWith('--')) throw new Error(teachUsage);
    params.id = rest.shift();
  }
  const starting = action === 'start', finishing = ['stop', 'process'].includes(action);
  while (rest.length) {
    const flag = rest.shift();
    if (starting && flag === '--name') params.name = take(flag);
    else if (starting && flag === '--mic') params.mic = take(flag);
    else if (starting && flag === '--audio-file') params.audioFile = take(flag);
    else if (starting && flag === '--no-audio') params.audio = false;
    else if (starting && flag === '--no-desktop') params.desktop = false;
    else if (starting && flag === '--no-browser') params.browser = false;
    else if (finishing && flag === '--no-transcribe') params.transcribe = false;
    else if (finishing && flag === '--no-sync') params.sync = false;
    else if (finishing && flag === '--sync') params.sync = take(flag);
    else throw new Error(teachUsage);
  }
  if (!['start', 'stop', 'status', 'process'].includes(action)) throw new Error(teachUsage);
  return { action, params };
}

const print = value => console.log(JSON.stringify(value, null, 2));
const layerLine = (label, layer) => `${label}: ${layer?.status === 'recording' ? `on${layer.device ? ` (${layer.device})` : ''}` : `OFF — ${layer?.reason || 'not requested'}`}`;

export async function runTeach({ port, browser, autoStart }, args, { session } = {}) {
  const { action, params } = teachParams(args);
  // The browser layer is optional, so do not wait long for Chrome.
  const client = createClient({ port, browser, autoStart: autoStart && action === 'start', waitForConnection: true, connectTimeout: 8000 });
  session ??= createTeachSession({ browserLayer: {
    start: values => client.call('teach.start', values),
    stop: () => client.call('teach.stop', {})
  } });
  if (action === 'status') { print(await session.status()); return; }
  if (action === 'start') {
    const result = await session.start(params);
    print(result);
    console.error(`\nRecording "${result.id}" into ${result.dir}`);
    console.error([layerLine('Microphone', result.audio), layerLine('Screen video', result.screen), layerLine('Mouse/keyboard/windows', result.hooks), layerLine('Browser details', result.browser)].join('\n'));
    console.error('Stop with: teach stop');
    return;
  }
  const { manifest, result } = action === 'stop'
    ? await session.stop({ ...params, onProgress: line => console.error(line) })
    : await session.reprocess(params);
  print({ id: manifest.id, dir: manifest.dir, ...result });
  for (const note of [...(manifest.notes || []), ...(result.notes || [])]) console.error(`Note: ${note}`);
  console.error(`\nBundle: ${manifest.dir}\nTimeline: ${result.timeline}${result.synced ? `\nSynced to: ${result.synced}` : ''}`);
}
