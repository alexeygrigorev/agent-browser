import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRecordings } from '../src/recordings.js';

const ffmpeg = process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg';
let image;
try {
  image = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { windowsHide: true, timeout: 10000 });
} catch {}
const mediaTest = (name, fn) => test(name, { skip: !image && 'FFmpeg is not installed' }, fn);

test('validates recording requests before capturing or creating files', async () => {
  const recorder = createRecordings({ capture: async () => { throw new Error('Should not capture'); } });
  await assert.rejects(recorder.start({ tabId: 1 }), /browserId/);
  await assert.rejects(recorder.start({ browserId: 'main', tabId: '1' }), /tabId/);
  await assert.rejects(recorder.start({ browserId: 'main', tabId: 1, fps: 0 }), /fps/);
  await assert.rejects(recorder.stop({ id: 'missing' }), /No active recording/);
  await recorder.close();
  await assert.rejects(recorder.start({ browserId: 'main', tabId: 1 }), /closed/);
});

mediaTest('records decodable real-time WebM and bounds concurrent screenshot capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-recording-'));
  let capturing = 0;
  let maxCapturing = 0;
  let captures = 0;
  const recorder = createRecordings({ capture: async (browserId, tabId) => {
    assert.equal(browserId, 'main');
    assert.equal(tabId, 7);
    maxCapturing = Math.max(maxCapturing, ++capturing);
    captures++;
    await delay(250);
    capturing--;
    return { data: image.toString('base64') };
  } });
  try {
    const recording = await recorder.start({ browserId: 'main', tabId: 7, path: join(directory, 'recording.webm'), fps: 5 });
    assert.equal(recording.format, 'webm');
    assert.equal(recorder.list()[0].id, recording.id);
    await delay(1200);
    const result = await recorder.stop({ id: recording.id });
    assert.ok(result.bytes > 100);
    assert.ok(result.duration >= 1 && result.duration < 3, `duration ${result.duration}`);
    assert.ok(result.frames >= 5 && result.frames <= 9, `frames ${result.frames}`);
    assert.ok(captures >= 2);
    assert.equal(maxCapturing, 1);
    assert.deepEqual(recorder.list(), []);
    const bytes = await readFile(result.path);
    assert.equal(bytes.subarray(0, 4).toString('hex'), '1a45dfa3');
    // Decode all frames, detecting corrupt/incomplete media rather than only checking its header.
    execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', result.path, '-f', 'null', '-'], { windowsHide: true, timeout: 10000 });
  } finally {
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

mediaTest('custom paths are exclusive and close finalizes every active recording', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-recording-'));
  const outputPath = join(directory, 'existing.webm');
  const recorder = createRecordings({ capture: async () => ({ data: image.toString('base64') }) });
  try {
    await writeFile(outputPath, 'keep me');
    await assert.rejects(recorder.start({ browserId: 'main', tabId: 1, path: outputPath }), /EEXIST/);
    assert.equal(await readFile(outputPath, 'utf8'), 'keep me');
    const first = await recorder.start({ browserId: 'main', tabId: 1, path: join(directory, 'one.webm') });
    const second = await recorder.start({ browserId: 'orin', tabId: 2, path: join(directory, 'two.webm') });
    await delay(250);
    await recorder.close();
    assert.equal(recorder.list().length, 0);
    for (const recording of [first, second]) execFileSync(ffmpeg, ['-v', 'error', '-xerror', '-i', recording.path, '-f', 'null', '-'], { windowsHide: true, timeout: 10000 });
  } finally {
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('missing FFmpeg errors are reported by start without unhandled rejections', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-recording-'));
  const previous = process.env.AGENT_BROWSER_FFMPEG;
  process.env.AGENT_BROWSER_FFMPEG = join(directory, 'nonexistent-ffmpeg');
  const recorder = createRecordings({ capture: async () => ({ data: '/9j/2Q==' }) });
  try {
    await assert.rejects(recorder.start({ browserId: 'main', tabId: 1, path: join(directory, 'failed.webm') }), /FFmpeg/);
    assert.deepEqual(recorder.list(), []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_BROWSER_FFMPEG;
    else process.env.AGENT_BROWSER_FFMPEG = previous;
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

mediaTest('capture failures remain observable at stop and leave no unhandled rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-recording-'));
  let captures = 0;
  const recorder = createRecordings({ capture: async () => {
    if (captures++) throw new Error('Browser disconnected');
    return { data: image.toString('base64') };
  } });
  try {
    const { id } = await recorder.start({ browserId: 'main', tabId: 1, path: join(directory, 'failure.webm') });
    await delay(300);
    assert.equal(recorder.list()[0].state, 'failed');
    await assert.rejects(recorder.stop({ id }), /Browser disconnected/);
  } finally {
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});

mediaTest('encoder failures report bounded diagnostic output through stop', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-recording-'));
  const recorder = createRecordings({ capture: async () => ({ data: '/9j/2Q==' }) });
  try {
    const { id } = await recorder.start({ browserId: 'main', tabId: 1, path: join(directory, 'invalid.webm') });
    await assert.rejects(recorder.stop({ id }), /FFmpeg exited|pipe|stream/i);
    assert.deepEqual(recorder.list(), []);
  } finally {
    await recorder.close();
    await rm(directory, { recursive: true, force: true });
  }
});
