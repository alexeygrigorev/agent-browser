import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { WebSocket } from 'ws';
import { createToolsServer } from '../src/tools/server.js';
import { connectDaemon } from '../src/tools/daemon.js';
import { createClient } from '../src/client.js';
import { serverUrl } from '../src/tools/cli.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const cookie = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-tools-')); let time = Date.now(); let nonce, identity = { sub: 'person-a', email: 'a@datatalks.club', email_verified: true, token_use: 'id' };
  const { privateKey, publicKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  let issuer;
  const oidc = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/jwks.json') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    const token = await new SignJWT({ nonce, ...identity }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('tools-client').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    res.end(JSON.stringify({ id_token: token }));
  });
  issuer = `http://127.0.0.1:${await listen(oidc)}`;
  const tools = await createToolsServer({ file: join(dir, 'state.json'), origin: 'https://tools.example', clientId: 'tools-client', issuer, authBase: issuer, now: () => time });
  const base = `http://127.0.0.1:${(await tools.listen(0)).port}`;
  const sockets = [];
  t.after(async () => { for (const s of sockets) s.terminate(); await tools.close(); await close(oidc); await rm(dir, { recursive: true, force: true }); });
  async function browserLogin(overrides = {}) {
    identity = { sub: 'person-a', email: 'a@datatalks.club', email_verified: true, token_use: 'id', ...overrides };
    const start = await fetch(base + '/auth/login', { redirect: 'manual' }); const target = new URL(start.headers.get('location')); nonce = target.searchParams.get('nonce');
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
    const callback = `/auth/callback?state=${target.searchParams.get('state')}&code=fresh-code`;
    const response = await fetch(base + callback, { headers: { Cookie: cookie(start) }, redirect: 'manual' });
    return { cookie: cookie(response), response, callback, binding: cookie(start) };
  }
  async function start(role = 'controller', device = 'desktop') {
    const r = await fetch(base + '/api/auth/device', { method: 'POST', body: JSON.stringify({ role, device, label: '<test label>' }) }); assert.equal(r.status, 200); return r.json();
  }
  async function approve(grant, session, approve = true, badOrigin = false) {
    const preview = await (await fetch(base + `/device?code=${grant.user_code}`, { headers: { Cookie: session }, redirect: 'manual' })).text();
    assert.ok(preview.includes('&lt;test label&gt;'));
    const csrf = /name="csrf" value="([^"]+)"/.exec(preview)?.[1];
    return fetch(base + '/api/auth/device/approve', { method: 'POST', headers: { Cookie: session, Origin: badOrigin ? 'https://evil.example' : 'https://tools.example' }, body: new URLSearchParams({ code: grant.user_code, csrf, ...(approve ? { approve: 'yes' } : { deny: 'yes' }) }) });
  }
  async function poll(grant) {
    const r = await fetch(base + '/api/auth/device/token', { method: 'POST', body: JSON.stringify({ device_code: grant.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) }); return { status: r.status, body: await r.json() };
  }
  async function credential(role = 'controller', session) {
    const s = session || (await browserLogin()).cookie; const grant = await start(role); assert.equal((await approve(grant, s)).status, 200); return (await poll(grant)).body;
  }
  return { dir, tools, base, browserLogin, start, approve, poll, credential, sockets, advance: ms => { time += ms; } };
}

test('shared browser SSO checks signed identity, transaction binding, nonce and domain', async t => {
  const f = await fixture(t); const login = await f.browserLogin();
  assert.equal(login.response.headers.get('location'), '/browser'); assert.match(login.cookie, /__Host-tools-session=/);
  const replay = await fetch(f.base + login.callback, { headers: { Cookie: login.binding }, redirect: 'manual' }); assert.equal(replay.headers.get('location'), '/auth/error');
  for (const invalid of [{ email: 'a@evil.example' }, { email_verified: false }, { token_use: 'access' }, { nonce: 'wrong-nonce' }]) {
    const result = await f.browserLogin(invalid); assert.equal(result.response.headers.get('location'), '/auth/error');
  }
  const raw = await readFile(join(f.dir, 'state.json'), 'utf8'); assert.ok(!raw.includes(login.cookie.split('=')[1]), 'sessions are stored as hashes');
});

test('device grants require browser approval, resist CSRF, slow polls, expire, deny and consume once', async t => {
  const f = await fixture(t); const s = (await f.browserLogin()).cookie; const g = await f.start();
  assert.equal((await f.poll(g)).body.error, 'authorization_pending'); assert.equal((await f.poll(g)).body.error, 'slow_down');
  assert.equal((await f.approve(g, s, true, true)).status, 403); assert.equal((await f.approve(g, s)).status, 200);
  f.advance(11000); const result = await f.poll(g); assert.equal(result.body.role, 'controller'); assert.equal(result.body.email, 'a@datatalks.club');
  assert.equal((await f.poll(g)).body.error, 'expired_token');
  const denied = await f.start(); await f.approve(denied, s, false); assert.equal((await f.poll(denied)).body.error, 'access_denied');
  const expired = await f.start(); f.advance(601000); assert.equal((await f.poll(expired)).body.error, 'expired_token');
  assert.ok(!(await readFile(join(f.dir, 'state.json'), 'utf8')).includes(result.body.access_token), 'bearer tokens are stored as hashes');
});

test('authenticated daemon streams commands/files; roles, ownership and revocation fail closed', async t => {
  const f = await fixture(t); const a = (await f.browserLogin()).cookie;
  const controller = await f.credential('controller', a); const publisher = await f.credential('daemon', a);
  const payload = Buffer.alloc(1024 * 1024, 120); let uploaded;
  const bridge = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    if (req.url.startsWith('/files')) { uploaded = Buffer.concat(chunks); res.end(JSON.stringify({ path: '/staged/fixture' })); }
    else if (req.url.startsWith('/downloads/7/file')) res.end(payload);
    else if (req.url === '/status') res.end(JSON.stringify({ connected: true }));
    else { const body = JSON.parse(Buffer.concat(chunks).toString()); res.end(JSON.stringify({ result: body.method === 'browsers.list' ? ['main', 'orin'] : { executed: body.params } })); }
  });
  const bridgePort = await listen(bridge); t.after(() => close(bridge));
  let daemon; await new Promise(resolve => { daemon = connectDaemon({ server: f.base, token: publisher.access_token, bridgePort, onReady: resolve }); f.sockets.push(daemon); });
  const baseUrl = f.base + '/browser/desktop'; const client = createClient({ baseUrl, token: controller.access_token });
  assert.deepEqual(await client.call('browsers.list'), ['main', 'orin']); assert.deepEqual(await client.call('page.click', { tabId: 5, x: 20, y: 30 }), { executed: { tabId: 5, x: 20, y: 30 } });
  const input = join(f.dir, 'upload.txt'); await writeFile(input, payload); await client.stageFile(input); assert.deepEqual(uploaded, payload);
  const output = join(f.dir, 'download.txt'); await client.saveDownload(7, output); assert.deepEqual(await readFile(output), payload);
  assert.equal((await fetch(baseUrl + '/status')).status, 401);
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${publisher.access_token}` } })).status, 401);
  const b = (await f.browserLogin({ sub: 'person-b', email: 'b@datatalks.club' })).cookie; const other = await f.credential('controller', b);
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${other.access_token}` } })).status, 503);
  const badWs = new WebSocket(f.base.replace('http:', 'ws:') + '/browser/daemon', { headers: { Authorization: `Bearer ${controller.access_token}` } }); f.sockets.push(badWs);
  await once(badWs, 'error');
  const closed = once(daemon, 'close');
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${publisher.access_token}` } }); await closed;
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${controller.access_token}` } })).status, 503);
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${controller.access_token}` } });
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${controller.access_token}` } })).status, 401);
  assert.throws(() => createClient({ baseUrl, autoStart: true }), /cannot autostart/);
  assert.throws(() => serverUrl('http://tools.example'), /HTTPS/);
});
