import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';

const token = 'test-token-012345678901234567890123456789';
const origin = `chrome-extension://${'a'.repeat(32)}`;

async function fixture(t, timeout = 2000) {
  const bridge = createBridge({ token, port: 0, timeout });
  const address = await bridge.listen();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(() => bridge.close());
  const request = (path, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  const command = (method = 'tabs.list', params = {}) => request('/command', {
    method: 'POST', body: JSON.stringify({ method, params }),
  });
  async function connect(authToken = token) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin });
    await once(ws, 'open');
    const response = Promise.race([
      once(ws, 'message').then(([raw]) => JSON.parse(raw)),
      once(ws, 'close').then(([code]) => ({ closed: code })),
    ]);
    ws.send(JSON.stringify({ type: 'auth', token: authToken }));
    return { ws, response: await response };
  }
  return { base, request, command, connect };
}

test('requires a sufficiently long token', () => {
  assert.throws(() => createBridge({ token: 'short' }), /32/);
});

test('HTTP authentication and browser origins are rejected', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('/status', { headers: { Authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await request('/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.deepEqual(await (await request('/status')).json(), { connected: false });
});

test('WebSocket requires an extension origin and correct authentication', async t => {
  const { base, connect } = await fixture(t);
  const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin: 'https://evil.example' });
  const [error] = await once(ws, 'error');
  assert.match(error.message, /socket hang up|Unexpected server response/);
  assert.equal((await connect('wrong')).response.closed, 1008);
});

test('reports missing browser and rejects malformed commands', async t => {
  const { command, request } = await fixture(t);
  assert.equal((await command()).status, 503);
  for (const body of ['{', '{}', '{"method":"tabs.list","params":[]}']) {
    assert.equal((await request('/command', { method: 'POST', body })).status, 400);
  }
  assert.equal((await request('/unknown')).status, 404);
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
