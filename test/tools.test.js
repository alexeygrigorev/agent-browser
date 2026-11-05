import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT, importPKCS8 } from 'jose';
import { WebSocket } from 'ws';
import { createToolsServer } from '../src/tools/server.js';
import { ensureIdentity } from '../src/tools/identity.js';
import { createClient } from '../src/client.js';
import { serverUrl } from '../src/tools/cli.js';
import { hash, secret } from '../src/tools/auth.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };
const cookie = response => response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-tools-')); let time = Date.now(); let nonce, identity = { sub: 'person-a', email: 'a@datatalks.club', email_verified: true, token_use: 'id' };
  const controllerIdentity = await ensureIdentity(join(dir, 'controller-key.json'));
  const { privateKey, publicKey } = await generateKeyPair('RS256'); const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  let issuer;
  const oidc = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/jwks.json') { res.end(JSON.stringify({ keys: [jwk] })); return; }
    const token = await new SignJWT({ nonce, ...identity }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(issuer).setAudience('tools-client').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    res.end(JSON.stringify({ id_token: token }));
  });
  issuer = `http://127.0.0.1:${await listen(oidc)}`;
  const tools = await createToolsServer({ file: join(dir, 'state.json'), origin: 'https://tools.example', clientId: 'tools-client', issuer, authBase: issuer, now: () => time, onAudit: () => {} });
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
    const r = await fetch(base + '/api/auth/device', { method: 'POST', body: JSON.stringify({ role, device, certificate: controllerIdentity.certificate, label: '<test label>' }) }); assert.equal(r.status, 200); return r.json();
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
  return { dir, tools, base, browserLogin, start, approve, poll, credential, sockets, controllerIdentity, time: () => time, advance: ms => { time += ms; } };
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

test('unsolicited OAuth callbacks do not write state and are rate limited', async t => {
  const f = await fixture(t); let response;
  for (let i = 0; i < 121; i++) response = await fetch(f.base + '/auth/callback?state=unknown&code=invented', { redirect: 'manual' });
  assert.equal(response.status, 429);
  await assert.rejects(readFile(join(f.dir, 'state.json')), error => error.code === 'ENOENT');
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

test('short-lived controller tokens renew only with their device key; replay and revoked grants fail', async t => {
  const f = await fixture(t); const c = await f.credential(); assert.equal(c.expires_in, 900);
  const key = await importPKCS8(f.controllerIdentity.key, 'ES256');
  const proof = await new SignJWT({ htm: 'POST', htu: 'https://tools.example/api/auth/refresh', grant_hash: hash(c.refresh_token), jti: secret() }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt' }).setIssuedAt(Math.floor(f.time() / 1000)).sign(key);
  const refresh = async p => { const r = await fetch(f.base + '/api/auth/refresh', { method: 'POST', headers: { DPoP: p }, body: JSON.stringify({ refresh_token: c.refresh_token }) }); return { status: r.status, body: await r.json() }; };
  assert.equal((await refresh('')).status, 401);
  const renewed = await refresh(proof); assert.equal(renewed.status, 200); assert.equal(renewed.body.expires_in, 900);
  assert.equal((await refresh(proof)).status, 401);
  await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${renewed.body.access_token}` } });
  assert.equal((await refresh(proof)).status, 401);
  assert.equal((await fetch(f.base + '/api/auth/me', { headers: { Authorization: `Bearer ${c.access_token}` } })).status, 401);
});

test('gateway authenticates roles and owners; plaintext browser routes remain disabled', async t => {
  const f = await fixture(t); const a = (await f.browserLogin()).cookie;
  const controller = await f.credential('controller', a); const publisher = await f.credential('daemon', a);
  const wsUrl = f.base.replace('http:', 'ws:');
  const daemon = new WebSocket(wsUrl + '/browser/daemon', { headers: { Authorization: `Bearer ${publisher.access_token}` } }); f.sockets.push(daemon);
  await once(daemon, 'message');
  const baseUrl = f.base + '/browser/desktop';
  assert.equal((await fetch(baseUrl + '/status')).status, 401);
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${publisher.access_token}` } })).status, 401);
  assert.equal((await fetch(baseUrl + '/status', { headers: { Authorization: `Bearer ${controller.access_token}` } })).status, 404);
  async function rejectSocket(token, route, status) {
    const ws = new WebSocket(wsUrl + route, { headers: { Authorization: `Bearer ${token}` } }); f.sockets.push(ws);
    const [error] = await once(ws, 'error'); assert.match(error.message, new RegExp(String(status)));
  }
  const b = (await f.browserLogin({ sub: 'person-b', email: 'b@datatalks.club' })).cookie; const other = await f.credential('controller', b);
  await rejectSocket(other.access_token, '/browser/desktop/tunnel', 503);
  await rejectSocket(controller.access_token, '/browser/daemon', 401);
  await rejectSocket(publisher.access_token, '/browser/desktop/tunnel', 401);
  const closed = once(daemon, 'close'); await fetch(f.base + '/api/auth/logout', { method: 'POST', headers: { Authorization: `Bearer ${publisher.access_token}` } }); await closed;
  await rejectSocket(controller.access_token, '/browser/desktop/tunnel', 503);
  assert.throws(() => createClient({ baseUrl, autoStart: true }), /cannot autostart/);
  assert.throws(() => serverUrl('http://tools.example'), /HTTPS/);
});
