import { setTimeout as delay } from 'node:timers/promises';

export const teachUsage = `Usage: teach start [--name <text>] [--mic <device>] [--no-audio] [--audio-file <path>]
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
  while (rest.length) {
    const flag = rest.shift();
    if (action === 'start' && flag === '--name') params.name = take(flag);
    else if (action === 'start' && flag === '--mic') params.mic = take(flag);
    else if (action === 'start' && flag === '--audio-file') params.audioFile = take(flag);
    else if (action === 'start' && flag === '--no-audio') params.audio = false;
    else if (['stop', 'process'].includes(action) && flag === '--no-transcribe') params.transcribe = false;
    else if (['stop', 'process'].includes(action) && flag === '--no-sync') params.sync = false;
    else if (['stop', 'process'].includes(action) && flag === '--sync') params.sync = take(flag);
    else throw new Error(teachUsage);
  }
  if (!['start', 'stop', 'status', 'process'].includes(action)) throw new Error(teachUsage);
  return { action, params };
}

const print = value => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function waitForProcessing(client, id, { interval = 2000, log = console.error } = {}) {
  let last = '';
  for (;;) {
    const status = await client.call('teach.status', { id });
    if (status.state !== 'processing') return status;
    const line = 'Transcribing and building the timeline…';
    if (line !== last) { log(line); last = line; }
    await delay(interval);
  }
}

export async function runTeach(client, args, options = {}) {
  const { action, params } = teachParams(args);
  if (action === 'status') { print(await client.call('teach.status', {})); return; }
  if (action === 'start') {
    const result = await client.call('teach.start', params);
    print(result);
    console.error(`\nRecording "${result.id}" into ${result.dir}`);
    console.error(result.audio?.status === 'recording' ? `Microphone: ${result.audio.device}` : `WARNING: no audio — ${result.audio?.reason}`);
    console.error('Stop with: teach stop');
    return;
  }
  const started = await client.call(action === 'stop' ? 'teach.stop' : 'teach.process', params);
  console.error(`Stopped "${started.id}" (${started.events} events, ${started.screenshots} screenshots, audio ${started.audio?.status}).`);
  const final = await waitForProcessing(client, started.id, options);
  print(final);
  if (final.state === 'failed') throw new Error(`Processing failed: ${final.error}`);
  const result = final.result || {};
  for (const note of result.notes || []) console.error(`Note: ${note}`);
  console.error(`\nBundle: ${final.dir}\nTimeline: ${result.timeline}${result.synced ? `\nSynced to: ${result.synced}` : ''}`);
}
