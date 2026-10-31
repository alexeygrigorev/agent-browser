import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';
import { localCode } from '../src/extension-code.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;

async function fixture(t, timeout = 2000, options = {}) {
  const bridge = createBridge({ port: 0, timeout, ...options });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => bridge.close());
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options,
  });
  const command = (method = 'tabs.list', params = {}) => request('/command', {
    method: 'POST', body: JSON.stringify({ method, params }),
  });
  async function connect(hello = { type: 'hello', protocol: 1 }) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin });
    await once(ws, 'open');
    const response = Promise.race([
      once(ws, 'message').then(([raw]) => JSON.parse(raw)),
      once(ws, 'close').then(([code]) => ({ closed: code })),
    ]);
    ws.send(JSON.stringify(hello));
    return { ws, response: await response };
  }
  return { base, request, command, connect };
}

test('local agents need no token; browser origins, fetch metadata, and rebound hosts are rejected', async t => {
  const { request, base } = await fixture(t);
  assert.equal((await request('/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/status', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/status`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  const forwardedStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${base}/status`, { headers: { Host: '127.0.0.1:19334' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(forwardedStatus, 200, 'SSH forward can use a different loopback port');
  assert.equal((await request('/command', { method: 'POST', headers: { Origin: 'null' }, body: '{}' })).status, 403);
  assert.deepEqual(await (await request('/status')).json(), { connected: false });
});

test('WebSocket requires an extension origin and supported protocol', async t => {
  const { base, connect } = await fixture(t);
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin: 'https://evil.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /socket hang up|Unexpected server response/);
  assert.equal((await connect({ type: 'hello', protocol: 999 })).response.closed, 1008);
});

test('already installed extensions can transition without their obsolete pairing token', async t => {
  const { connect, request } = await fixture(t);
  assert.equal((await connect({ type: 'auth' })).response.type, 'ready');
  assert.deepEqual(await (await request('/status')).json(), { connected: true });
});

test('reports missing browser and rejects malformed commands', async t => {
  const { command, request } = await fixture(t);
  assert.equal((await command()).status, 503);
  for (const body of ['{', '{}', 'null', '{"method":"","params":{}}', '{"method":"tabs.list","params":[]}']) {
    assert.equal((await request('/command', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/unknown')).status, 404);
});

test('preserves UTF-8 text when a character spans HTTP chunks', async t => {
  const { connect, base } = await fixture(t);
  const { ws } = await connect();
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    ws.send(JSON.stringify({ id: message.id, result: message.params.text }));
  });
  const value = 'Grüße 世界 🌍';
  const body = Buffer.from(JSON.stringify({ method: 'page.type', params: { tabId: 1, text: value } }));
  const split = body.indexOf(Buffer.from('ü')) + 1;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/command`, { method: 'POST' }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks))));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 30);
  });
  assert.equal(response.result, value);
});

test('roundtrips commands and extension errors, and rejects duplicate browsers', async t => {
  const { connect, command, request } = await fixture(t);
  const { ws, response } = await connect();
  assert.equal(response.type, 'ready');
  assert.deepEqual(await (await request('/status')).json(), { connected: true });
  assert.equal((await connect()).response.closed, 1008);
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    ws.send(JSON.stringify(message.method === 'bad'
      ? { id: message.id, error: { message: 'Unsupported method' } }
      : { id: message.id, result: [{ id: 123, title: 'Existing logged-in tab' }] }));
  });
  const success = await command();
  assert.equal(success.status, 200);
  assert.deepEqual((await success.json()).result, [{ id: 123, title: 'Existing logged-in tab' }]);
  assert.equal((await (await command('bad')).json()).error.message, 'Unsupported method');
});

test('pending commands fail on disconnect', async t => {
  const { connect, command } = await fixture(t);
  const { ws } = await connect();
  ws.once('message', () => ws.close());
  const response = await command();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /disconnected.*may have executed/);
});

test('pending commands time out without retrying actions', async t => {
  const { connect, command } = await fixture(t, 30);
  await connect();
  const response = await command();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /timed out.*may have executed/);
});

test('malformed extension messages close the connection', async t => {
  const { connect } = await fixture(t);
  const { ws } = await connect();
  const closed = once(ws, 'close');
  ws.send('{');
  assert.equal((await closed)[0], 1008);
});

const codeFiles = ['manifest.json', 'background.js'];
const hello = async (browserId, sha256) => ({ type: 'hello', protocol: 1, browserId, version: '0.1.0', code: { sha256: sha256 ?? await localCode(codeFiles), files: codeFiles } });

test('extension handshake proves which code is live and flags a mismatch with the bridge checkout', async t => {
  const diagnostics = [];
  const { command, connect } = await fixture(t, 2000, { onDiagnostic: event => diagnostics.push(event) });
  await connect(await hello('current'));
  const info = (await (await command('extension.info')).json()).result;
  assert.equal(info.extension.current, true);
  assert.equal(info.extension.code, await localCode(codeFiles));
  assert.equal(info.extension.version, '0.1.0');
  assert.match(info.bridge.git ?? '', /^([a-f0-9]{40})?$/);
  assert.equal(diagnostics.some(event => event.event === 'extension_mismatch'), false);

  await connect(await hello('stale', 'f'.repeat(64)));
  const mismatch = diagnostics.find(event => event.event === 'extension_mismatch');
  assert.equal(mismatch.browser.id, 'stale');
  assert.equal(mismatch.extension.code, 'f'.repeat(64));
  assert.equal(mismatch.extension.expected, await localCode(codeFiles));

  await connect({ type: 'hello', protocol: 1, browserId: 'legacy-worker' });
  assert.deepEqual(diagnostics.filter(event => event.event === 'extension_mismatch').at(-1).extension, { version: null, code: null, expected: null, current: false });
});

test('extension file lists cannot escape the extension directory', async () => {
  assert.equal(await localCode(['../package.json']), null);
  assert.equal(await localCode(['missing.js']), null);
  assert.equal(await localCode([]), null);
});

test('extension reload waits for the reloaded worker to reconnect and reports its new code', async t => {
  const { command, connect } = await fixture(t);
  const old = await connect(await hello('reloading', 'a'.repeat(64)));
  old.ws.on('message', async raw => {
    const message = JSON.parse(raw);
    if (message.method !== 'extension.reload') return;
    old.ws.send(JSON.stringify({ id: message.id, result: { reloading: true } }));
    old.ws.close();
    await once(old.ws, 'close');
    await connect(await hello('reloading'));
  });
  const result = (await (await command('extension.reload')).json()).result;
  assert.equal(result.reloaded, true);
  assert.equal(result.before.code, 'a'.repeat(64));
  assert.equal(result.before.current, false);
  assert.equal(result.extension.code, await localCode(codeFiles));
  assert.equal(result.extension.current, true);
});

test('extension reload explains the one manual reload an older extension needs, and times out cleanly', async t => {
  const { command, connect, request } = await fixture(t, 2000, { reloadTimeout: 200 });
  const old = await connect({ type: 'hello', protocol: 1, browserId: 'old-worker' });
  old.ws.on('message', raw => {
    const message = JSON.parse(raw);
    old.ws.send(JSON.stringify({ id: message.id, error: `Unknown method: ${message.method}` }));
  });
  const response = await command('extension.reload');
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /predates extension reload.*chrome:\/\/extensions/);

  const stuck = await connect(await hello('stuck'));
  stuck.ws.on('message', raw => stuck.ws.send(JSON.stringify({ id: JSON.parse(raw).id, result: { reloading: true } })));
  const timedOut = await request('/command', { method: 'POST', body: JSON.stringify({ method: 'extension.reload', params: {}, browser: 'stuck' }) });
  assert.match((await timedOut.json()).error, /did not reconnect within 0.2s/);
});
