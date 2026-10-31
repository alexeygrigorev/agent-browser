import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { parseDshowAudioDevices, diagnoseWindowsMicrophone, microphoneInput, startAudioCapture } from '../src/teach-audio.js';
import { createTeach, sessionId } from '../src/teach.js';
import { buildTimeline, renderMarkdown, processBundle, syncTarget } from '../src/teach-process.js';
import { teachParams } from '../src/teach-cli.js';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'teach-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');

test('parses DirectShow audio devices in old and new FFmpeg formats', () => {
  const modern = '[dshow @ 0001] "Integrated Webcam" (video)\n[dshow @ 0001]   Alternative name "@device_pnp_x"\n[dshow @ 0001] "Microphone (Realtek(R) Audio)" (audio)\n[dshow @ 0001]   Alternative name "@device_cm_y"';
  assert.deepEqual(parseDshowAudioDevices(modern), ['Microphone (Realtek(R) Audio)']);
  const legacy = '[dshow @ 01] DirectShow video devices\n[dshow @ 01]  "Cam"\n[dshow @ 01] DirectShow audio devices\n[dshow @ 01]  "Headset Mic (USB)"\n[dshow @ 01]     Alternative name "@device_cm_z"';
  assert.deepEqual(parseDshowAudioDevices(legacy), ['Headset Mic (USB)']);
  assert.deepEqual(parseDshowAudioDevices('dummy: Immediate exit requested\n'), []);
});

test('explains a missing microphone from Windows privacy settings', async () => {
  const values = { NonPackaged: 'Deny' };
  const reason = await diagnoseWindowsMicrophone({ query: async key => key.endsWith('NonPackaged') ? values.NonPackaged : 'Allow' });
  assert.match(reason, /Let desktop apps access your microphone/);
  assert.match(reason, /desktop apps=Deny/);
  const noDevice = await diagnoseWindowsMicrophone({ query: async () => 'Allow' });
  assert.match(noDevice, /No microphone capture device is visible/);
  const missing = await microphoneInput({ platform: 'win32', listDevices: async () => [], diagnose: async () => 'privacy says no' });
  assert.deepEqual(missing, { error: 'privacy says no' });
  const chosen = await microphoneInput({ platform: 'win32', mic: 'headset', listDevices: async () => ['Mic A', 'Headset Mic (USB)'] });
  assert.deepEqual(chosen.args, ['-f', 'dshow', '-audio_buffer_size', '50', '-i', 'audio=Headset Mic (USB)']);
  assert.match((await microphoneInput({ platform: 'win32', mic: 'nope', listDevices: async () => ['Mic A'] })).error, /Available audio devices: Mic A/);
});

test('places the audio start on the session clock from FFmpeg progress', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  let args;
  let clock = 10000;
  const capture = startAudioCapture({ input: ['-f', 'dshow', '-i', 'audio=Mic'], output: 'out.wav', now: () => clock, spawnImpl: (file, list) => { args = list; return child; } });
  assert.ok(args.includes('-progress') && args.at(-1) === 'out.wav');
  clock = 10700; child.stdout.write('out_time_us=500000\nprogress=continue\n');
  clock = 11300; child.stdout.write('out_time_us=1000000\nprogress=continue\n');
  await capture.ready;
  assert.equal(capture.startedAt, 10200);
  const ahead = new EventEmitter();
  ahead.stdout = new PassThrough(); ahead.stderr = new PassThrough(); ahead.stdin = new PassThrough();
  clock = 20000;
  const file = startAudioCapture({ input: [], output: 'x.wav', now: () => clock, spawnImpl: () => ahead });
  clock = 20700; ahead.stdout.write('out_time_us=1200000\nprogress=continue\n');
  await file.ready;
  assert.equal(file.startedAt, 20000, 'audio cannot start before FFmpeg was spawned');
  let quit = '';
  child.stdin.on('data', data => { quit += data; });
  const stopped = capture.stop();
  setImmediate(() => child.emit('close', 0));
  await stopped;
  assert.equal(quit, 'q');
  assert.equal(capture.code, 0);
});

test('names sessions by UTC time and a slug', () => {
  assert.equal(sessionId('N26: find transactions!', new Date('2026-10-31T10:11:12.345Z')), '20261031-101112-n26-find-transactions');
  assert.equal(sessionId('', new Date('2026-10-31T10:11:12Z')), '20261031-101112');
});

function fakeCapture({ fail } = {}) {
  return ({ now }) => {
    const capture = { startedAt: fail ? null : now() + 150, exited: !!fail, code: fail ? 1 : null, stderr: fail ? 'Could not open audio device' : '', ready: Promise.resolve() };
    capture.stop = async () => { capture.code ??= 0; capture.exited = true; return capture; };
    return capture;
  };
}

test('records a teach session bundle: events, screenshots, audio offset and manifest', async t => {
  const root = await temp(t);
  const sent = [];
  let clock = Date.parse('2026-10-31T09:00:00Z');
  let processed;
  const teach = createTeach({ root, now: () => clock, send: async (browserId, method, params) => { sent.push([browserId, method, params]); return method === 'teach.start' ? { tabs: [{ tabId: 3, url: 'https://example.com/' }] } : { stopped: true }; },
    findMicrophone: async () => ({ device: 'Mic', args: ['-f', 'dshow', '-i', 'audio=Mic'] }), captureAudio: fakeCapture(), process: async (dir, options) => { processed = [dir, options]; return { dir, notes: [] }; } });
  const started = await teach.start({ browserId: 'b1', name: 'Demo walk' });
  assert.equal(started.state, 'recording');
  assert.deepEqual(started.audio, { status: 'recording', device: 'Mic', file: 'audio.wav', startOffsetMs: 150 });
  assert.deepEqual(sent[0], ['b1', 'teach.start', { sessionId: started.id, t0: clock }]);
  await assert.rejects(teach.start({ browserId: 'b1' }), /already recording/);
  const t0 = clock;
  await teach.ingest('b1', { type: 'teach-event', sessionId: started.id, event: { kind: 'click', ts: t0 + 1234, tabId: 3, element: { tag: 'a', name: 'More' } }, screenshot: jpeg });
  await teach.ingest('b2', { type: 'teach-event', sessionId: started.id, event: { kind: 'click', ts: t0 + 1300 } });
  await teach.ingest('b1', { type: 'teach-event', sessionId: 'other', event: { kind: 'click', ts: t0 + 1400 } });
  clock = t0 + 5000;
  const stopped = await teach.stop({ sync: false });
  assert.equal(stopped.state, 'processing');
  assert.equal(stopped.durationMs, 5000);
  assert.equal(stopped.audio.status, 'recorded');
  assert.deepEqual(sent[1], ['b1', 'teach.stop', { sessionId: started.id }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(processed, [started.dir, { transcribe: true, sync: false }]);
  assert.equal(teach.status({ id: started.id }).state, 'done');
  const events = (await readFile(join(started.dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.kind), ['session_start', 'click', 'session_stop']);
  assert.equal(events[1].offsetMs, 1234);
  assert.equal(events[1].screenshot, 'screenshots/0001-click.jpg');
  assert.equal(events[1].time, new Date(t0 + 1234).toISOString());
  assert.deepEqual(await readdir(join(started.dir, 'screenshots')), ['0001-click.jpg']);
  const manifest = JSON.parse(await readFile(join(started.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.screenshots, 1);
  assert.equal(manifest.audio.startOffsetMs, 150);
});

test('keeps recording actions when the microphone is unavailable, with the reason', async t => {
  const root = await temp(t);
  const teach = createTeach({ root, send: async () => ({ tabs: [] }), findMicrophone: async () => ({ error: 'Windows blocks desktop apps from the microphone' }), process: async () => ({}) });
  const started = await teach.start({ browserId: 'b1' });
  assert.deepEqual(started.audio, { status: 'unavailable', reason: 'Windows blocks desktop apps from the microphone' });
  await teach.stop({});
  const failing = createTeach({ root, send: async () => ({ tabs: [] }), findMicrophone: async () => ({ device: 'Mic', args: [] }), captureAudio: fakeCapture({ fail: true }), process: async () => ({}) });
  await new Promise(resolve => setTimeout(resolve, 1100)); // distinct second-resolution session id
  const second = await failing.start({ browserId: 'b1' });
  assert.equal(second.audio.status, 'unavailable');
  assert.match(second.audio.reason, /Could not open audio device/);
  await failing.stop({});
});

test('explains an outdated extension and releases the session', async t => {
  const root = await temp(t);
  const teach = createTeach({ root, send: async () => { throw new Error('Unknown method: teach.start'); }, process: async () => ({}) });
  await assert.rejects(teach.start({ browserId: 'b1', audio: false }), /reload the extension at chrome:\/\/extensions/);
  assert.equal(teach.status().state, 'idle');
});

test('stop still finalizes the bundle when the browser is gone', async t => {
  const root = await temp(t);
  let connected = true;
  const teach = createTeach({ root, send: async () => { if (!connected) throw new Error('Browser is not connected: b1'); return { tabs: [] }; }, process: async () => ({ notes: [] }) });
  await teach.start({ browserId: 'b1', audio: false });
  connected = false;
  const stopped = await teach.stop({});
  assert.match(stopped.notes[0], /Browser did not confirm the stop/);
  connected = true;
  const calls = [];
  const fresh = createTeach({ root, send: async (...args) => { calls.push(args); return {}; }, process: async () => ({}) });
  await assert.rejects(fresh.stop({ browserId: 'main' }), /No teach session is recording/);
  assert.deepEqual(calls, [['main', 'teach.stop', {}]], 'a restarted bridge still stops the extension logger');
});

const manifest = { id: 'r1', name: 'Demo', t0: Date.parse('2026-10-31T09:00:00Z'), startedAt: '2026-10-31T09:00:00.000Z', endedAt: '2026-10-31T09:00:20.000Z', durationMs: 20000, screenshots: 1,
  audio: { status: 'recorded', device: 'Mic', file: 'audio.wav', startOffsetMs: 500 } };
const events = [
  { seq: 0, kind: 'session_start', offsetMs: 0, tabs: [] },
  { seq: 1, kind: 'click', offsetMs: 4200, tabId: 3, url: 'https://example.com/', element: { tag: 'a', role: 'link', name: 'More information', selector: 'a' }, screenshot: 'screenshots/0001-click.jpg' },
  { seq: 2, kind: 'tab_opened', offsetMs: 4400, tabId: 4, openerTabId: 3 },
  { seq: 3, kind: 'type', offsetMs: 9000, tabId: 4, value: 'march', element: { tag: 'input', role: 'searchbox', name: 'Search', selector: '#q' } }
];
const transcript = { engine: 'faster-whisper', model: 'small', language: 'en', segments: [{ start: 3, end: 5, text: 'I click here because it opens the details.' }, { start: 12, end: 13, text: 'Done.' }] };

test('merges speech and actions on one clock', () => {
  const timeline = buildTimeline({ manifest, events, transcript });
  assert.deepEqual(timeline.items.map(item => [item.type, item.offsetMs]), [['action', 0], ['speech', 3500], ['action', 4200], ['action', 4400], ['action', 9000], ['speech', 12500]]);
  const click = timeline.items.find(item => item.kind === 'click');
  assert.equal(click.said, 'I click here because it opens the details.');
  assert.equal(click.summary, 'Click link "More information"');
  assert.equal(click.clock, '00:04.2');
  assert.equal(timeline.items.find(item => item.kind === 'type').said, undefined);
  const markdown = renderMarkdown(timeline, { notes: ['example note'] });
  assert.match(markdown, /`00:03.5` \*\*say\*\* “I click here because it opens the details.”/);
  assert.match(markdown, /`00:04.2` \*\*click\*\* Click link "More information" · `a` · tab 3 · example.com\/ · \[screenshot\]\(screenshots\/0001-click.jpg\)/);
  assert.match(markdown, /New tab 4 opened from tab 3/);
  assert.match(markdown, /Type "march" into searchbox "Search"/);
  assert.match(markdown, /- Note: example note/);
});

test('processes a bundle: transcribes, writes the timeline and syncs over scp', async t => {
  const dir = join(await temp(t), 'r1');
  await mkdir(dir);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(join(dir, 'audio.wav'), Buffer.alloc(100));
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'py') await writeFile(args[2], JSON.stringify(transcript));
    return { stdout: '', stderr: '' };
  };
  const result = await processBundle(dir, { python: 'py', run, sync: 'hetzner:tmp/teach-recordings' });
  assert.equal(result.synced, 'hetzner:~/tmp/teach-recordings/r1/');
  assert.deepEqual(calls.map(call => call[0]), ['py', 'ssh', 'scp']);
  assert.ok(calls[0][1].endsWith('teach-transcribe.py'));
  assert.deepEqual(calls[2].slice(-2), [dir, 'hetzner:tmp/teach-recordings/']);
  const timeline = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
  assert.equal(timeline.items.filter(item => item.type === 'speech').length, 2);
  assert.match(await readFile(join(dir, 'timeline.md'), 'utf8'), /# Teach recording: Demo/);

  const failed = await processBundle(dir, { python: 'py', sync: 'hetzner:x', run: async file => { if (file === 'py') { const error = new Error('exit 3'); error.stderr = 'faster-whisper is not installed'; throw error; } if (file === 'scp') { const error = new Error('exit 1'); error.stderr = 'Permission denied'; throw error; } return {}; } });
  assert.match(failed.notes.join('\n'), /Transcription failed: faster-whisper is not installed/);
  assert.match(failed.notes.join('\n'), /Sync to hetzner:x failed: Permission denied/);
  assert.match(await readFile(join(dir, 'timeline.md'), 'utf8'), /Note: Sync to hetzner:x failed/);
});

test('parses sync targets and teach CLI flags', () => {
  assert.equal(syncTarget('off'), null);
  assert.equal(syncTarget('hetzner:tmp/x'), 'hetzner:tmp/x');
  assert.throws(() => syncTarget('nocolon'), /ssh-host/);
  assert.deepEqual(teachParams(['start', '--name', 'N26 report', '--no-audio']), { action: 'start', params: { name: 'N26 report', audio: false } });
  assert.deepEqual(teachParams(['stop', '--no-sync']), { action: 'stop', params: { sync: false } });
  assert.deepEqual(teachParams(['process', 'abc', '--sync', 'h:d']), { action: 'process', params: { id: 'abc', sync: 'h:d' } });
  assert.throws(() => teachParams(['start', '--name']), /--name needs a value/);
  assert.throws(() => teachParams(['stop', '--name', 'x']), /Usage: teach/);
});

async function loadExtensionTeach() {
  const sent = [];
  const listeners = {};
  const calls = [];
  const session = {};
  const add = name => ({ addListener: fn => { listeners[name] = fn; } });
  const tabs = new Map([[3, { id: 3, windowId: 1, url: 'https://example.com/', title: 'Example', active: true }], [5, { id: 5, windowId: 1, url: 'chrome://settings', title: 'Settings', active: false }]]);
  const chrome = {
    storage: { session: { get: async () => ({ ...session }), set: async value => Object.assign(session, value), remove: async key => { delete session[key]; } } },
    scripting: {
      registerContentScripts: async scripts => calls.push(['register', scripts]),
      unregisterContentScripts: async filter => calls.push(['unregister', filter]),
      executeScript: async options => calls.push(['execute', options])
    },
    tabs: {
      get: async id => ({ ...tabs.get(id) }), query: async () => [...tabs.values()].map(tab => ({ ...tab })),
      captureVisibleTab: async (windowId, options) => { calls.push(['capture', windowId, options]); return `data:image/jpeg;base64,${jpeg}`; },
      sendMessage: async (tabId, message) => calls.push(['tabMessage', tabId, message]),
      onCreated: add('tabCreated'), onRemoved: add('tabRemoved'), onActivated: add('tabActivated')
    },
    windows: { onCreated: add('windowCreated'), onRemoved: add('windowRemoved') },
    webNavigation: { onCommitted: add('committed'), onHistoryStateUpdated: add('history'), onCompleted: add('completed') },
    runtime: { id: 'ext', onMessage: add('message') }
  };
  const WebSocket = { OPEN: 1 };
  const context = vm.createContext({ chrome, WebSocket, setTimeout, Date, Promise, JSON, socket: { readyState: 1, send: value => sent.push(JSON.parse(value)) }, browser: { connected: true } });
  vm.runInContext(await readFile(new URL('../extension/teach.js', import.meta.url), 'utf8'), context);
  const settle = () => new Promise(resolve => setTimeout(resolve, 20));
  return { context, sent, listeners, calls, session, settle };
}

test('extension teach logger streams page and tab events with screenshots', async () => {
  const ext = await loadExtensionTeach();
  ext.listeners.message({ type: 'teach-event', event: { kind: 'click', ts: 1 } }, { id: 'ext', tab: { id: 3 }, frameId: 0 });
  await ext.settle();
  assert.equal(ext.sent.length, 0, 'nothing is sent before a session starts');
  const plain = value => JSON.parse(JSON.stringify(value));
  const result = plain(await vm.runInContext('teachDispatch', ext.context)('teach.start', { sessionId: 's1', t0: 100 }));
  assert.deepEqual(result.tabs.map(tab => tab.tabId), [3, 5]);
  assert.deepEqual(plain(ext.session.teach), { id: 's1', t0: 100 });
  const register = plain(ext.calls.find(call => call[0] === 'register')[1][0]);
  assert.equal(register.js[0], 'teach-content.js');
  assert.equal(register.allFrames, true);
  assert.deepEqual(plain(ext.calls.filter(call => call[0] === 'execute').map(call => call[1].target.tabId)), [3], 'only web pages are injected');
  await ext.settle();
  ext.sent.length = 0;
  ext.listeners.message({ type: 'teach-event', event: { kind: 'click', ts: 150, frameUrl: 'https://example.com/', element: { tag: 'button' } } }, { id: 'ext', tab: { id: 3 }, frameId: 0 });
  ext.listeners.tabCreated({ id: 9, openerTabId: 3, pendingUrl: 'https://example.org/' });
  ext.listeners.committed({ frameId: 0, tabId: 3, url: 'https://example.com/next', transitionType: 'link', transitionQualifiers: [] });
  ext.listeners.committed({ frameId: 2, tabId: 3, url: 'https://ads.example/' });
  await new Promise(resolve => setTimeout(resolve, 700)); // captures are spaced 600 ms apart
  const byKind = Object.fromEntries(ext.sent.map(message => [message.event.kind, message]));
  assert.deepEqual(Object.keys(byKind).sort(), ['click', 'navigation', 'tab_opened']);
  assert.equal(byKind.click.sessionId, 's1');
  assert.equal(byKind.click.screenshot, jpeg);
  assert.equal(byKind.click.event.frameUrl, undefined);
  assert.equal(byKind.click.event.title, 'Example');
  assert.equal(byKind.tab_opened.event.openerTabId, 3);
  assert.equal(byKind.navigation.event.transition, 'link');
  const stopped = plain(await vm.runInContext('teachDispatch', ext.context)('teach.stop', { sessionId: 's1' }));
  assert.deepEqual(stopped, { stopped: true, sessionId: 's1' });
  assert.equal(ext.session.teach, undefined);
  assert.ok(ext.calls.some(call => call[0] === 'tabMessage' && call[2].type === 'teach-stop'));
});
