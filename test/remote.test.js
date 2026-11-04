import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createGateway, remoteSshArgs, validateProfile } from '../src/remote.js';
import { createClient } from '../src/client.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
test('gateway rejects anonymous/wrong-origin access and streams authenticated commands and files', async () => {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/downloads/')) { res.end('file bytes'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url === '/status' ? { connected: true } : { result: { ok: true } }));
  });
  const token = randomBytes(32).toString('base64url');
  const gateway = createGateway({ token, bridgePort: await listen(upstream) });
  const port = await listen(gateway);
  const url = `http://127.0.0.1:${port}`;
  try {
    for (const path of ['/status', '/command', '/files', '/downloads/1/file']) {
      assert.equal((await fetch(url + path)).status, 401);
      assert.equal((await fetch(url + path, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    }
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await fetch(url + '/status', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 401);
    assert.equal((await fetch(url + '/extension', { headers })).status, 404);
    const client = createClient({ port, token });
    assert.deepEqual(await client.status(), { connected: true });
    assert.deepEqual(await client.call('page.click', { tabId: 7, x: 10, y: 20 }), { ok: true });
    assert.equal(JSON.parse(seen.at(-1).body).params.tabId, 7);
    const bytes = Buffer.alloc(128 * 1024, 97);
    await fetch(url + '/files?name=test.txt', { method: 'POST', headers, body: bytes });
    assert.equal(seen.at(-1).body.length, bytes.length);
    assert.equal(await (await fetch(url + '/downloads/1/file', { headers })).text(), 'file bytes');
    assert.ok(seen.every(request => request.auth === undefined), 'gateway must not leak its credential to the bridge');
    assert.equal(seen.length, 4, 'rejected requests never reach the bridge');
  } finally { await close(gateway); await close(upstream); }
});
test('remote SSH pins hosts, uses key authentication and loopback-only forwarding', () => {
  const profile = { host: 'publish@relay', port: 19335, remotePort: 19334, gatewayPort: 19334, tokenFile: '/private/token', identityFile: '/private/key' };
  const args = remoteSshArgs(profile, 'publish');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('127.0.0.1:19334:127.0.0.1:19334'));
  assert.ok(remoteSshArgs(profile, 'connect').includes('127.0.0.1:19335:127.0.0.1:19334'));
  for (const host of ['-oProxyCommand=bad', 'host;cmd', 'host with space']) assert.throws(() => validateProfile({ ...profile, host }));
  assert.throws(() => validateProfile({ ...profile, remotePort: 0 }));
  assert.throws(() => createGateway({ token: 'weak' }));
});
