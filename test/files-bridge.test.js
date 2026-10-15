import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';
import { createFiles } from '../src/files.js';

async function fixture(t, maxBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-file-http-'));
  const bridge = createBridge({ port: 0, files: createFiles({ directory: join(directory, 'uploads'), maxBytes }) });
  const base = `http://127.0.0.1:${(await bridge.listen()).port}`;
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await once(ws, 'open'); const ready = once(ws, 'message'); ws.send(JSON.stringify({ type: 'hello', protocol: 1, browserId: 'file-profile' })); await ready;
  const commands = [];
  const path = join(directory, 'download.txt');
  const bytes = Buffer.from('downloaded bytes\n'); await writeFile(path, bytes);
  let download = { id: 1, filename: path, state: 'complete', exists: true };
  ws.on('message', raw => {
    const message = JSON.parse(raw); if (!message.method) return;
    commands.push(message);
    ws.send(JSON.stringify({ id: message.id, result: message.method === 'downloads.info' ? download : { uploaded: true } }));
  });
  const command = params => fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ method: 'page.upload', params }) });
  return { base, directory, path, bytes, commands, command, setDownload: value => { download = value; } };
}

test('streams uploads to staging and validates all desktop paths before dispatch', async t => {
  const { base, command, commands } = await fixture(t);
  const bytes = Buffer.from([0, 255, 1, 2, 3]);
  const response = await fetch(`${base}/files?name=${encodeURIComponent('données.csv')}&browser=file-profile`, { method: 'POST', body: bytes });
  assert.equal(response.status, 201);
  const staged = await response.json();
  assert.equal(staged.name, 'données.csv'); assert.equal(staged.size, bytes.length);
  assert.deepEqual(await readFile(staged.path), bytes);
  assert.equal((await command({ tabId: 1, selector: '#file', files: [staged.path] })).status, 200);
  assert.equal(commands.length, 1);
  assert.equal((await command({ tabId: 1, selector: '#file', files: [staged.path, `${staged.path}.missing`] })).status, 502);
  assert.equal(commands.length, 1, 'invalid files never reach Chrome');
});

test('rejects invalid, oversized and browser-origin upload streams', async t => {
  const { base } = await fixture(t, 3);
  assert.equal((await fetch(`${base}/files?name=big.txt`, { method: 'POST', body: 'four' })).status, 413);
  assert.equal((await fetch(`${base}/files?name=..%2Fsecret`, { method: 'POST', body: 'ok' })).status, 502);
  assert.equal((await fetch(`${base}/files?name=secret.txt`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: 'ok' })).status, 403);
});

test('retrieves only completed Chrome downloads and preserves their bytes', async t => {
  const { base, bytes, path, setDownload } = await fixture(t);
  const response = await fetch(`${base}/downloads/1/file?browser=file-profile`);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.match(response.headers.get('content-disposition'), /download.txt/);
  setDownload({ id: 1, filename: path, state: 'in_progress', exists: true });
  assert.equal((await fetch(`${base}/downloads/1/file`)).status, 409);
  setDownload({ id: 1, filename: path, state: 'complete', exists: false });
  assert.equal((await fetch(`${base}/downloads/1/file`)).status, 409);
  assert.equal((await fetch(`${base}/downloads/1/file`, { headers: { Origin: 'https://evil.example' } })).status, 403);
});
