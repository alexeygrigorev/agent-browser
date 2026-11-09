import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createToolsServer } from '../src/tools/server.js';
import { connectDaemon } from '../src/tools/daemon.js';
import { ensureIdentity, pairController } from '../src/tools/identity.js';
import { pairedFetch } from '../src/tools/paired-client.js';
import { createClient } from '../src/client.js';
import { createFileGate, createHttpGate, gateFromEnv } from '../src/tools/gate.js';
import { createAlerts } from '../src/tools/alerts.js';
import { hash, secret } from '../src/tools/auth.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); };

test('file gate grants, expires, revokes and fails closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-')); t.after(() => rm(dir, { recursive: true, force: true }));
  let time = 1e12; const gate = createFileGate({ file: join(dir, 'g.json'), now: () => time });
  await assert.rejects(gate.check({ device: 'desktop' }), e => e.status === 403 && /No active Resource Gate grant/.test(e.message));
  const g = await gate.grant('desktop', 600000, 'test');
  assert.equal((await stat(join(dir, 'g.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await gate.check({ device: 'desktop' }), { id: g.id, expires: g.expires });
  await assert.rejects(gate.check({ device: 'other' }), /No active/);
  await assert.rejects(gate.grant('desktop', 24 * 3600000), /between 1 minute and 8 hours/);
  time += 600001; await assert.rejects(gate.check({ device: 'desktop' }), /No active/);
  const g2 = await gate.grant('desktop', 600000); assert.equal(await gate.revoke(g2.id), 1);
  await assert.rejects(gate.check({ device: 'desktop' }), /No active/);
  await (await import('node:fs/promises')).writeFile(join(dir, 'g.json'), '{broken');
  await assert.rejects(gate.check({ device: 'desktop' }), e => e.status === 503);
});

test('http gate maps grants, denials and outages without leaking the token', async () => {
  const calls = []; const mk = (status, body) => createHttpGate({ url: 'https://gate.example/', token: 'SECRET-TOKEN', fetchImpl: async (url, o) => { calls.push([url, o.headers.Authorization]); if (body === 'throw') throw new Error('boom SECRET-TOKEN'); return new Response(JSON.stringify(body), { status }); } });
  const ok = await mk(200, { granted: true, grant_id: 'g1', expires_at: new Date(Date.now() + 60000).toISOString() }).check({ device: 'desktop' });
  assert.equal(ok.id, 'g1'); assert.equal(calls[0][0], 'https://gate.example/v1/check?resource=browser&scope=desktop');
  await assert.rejects(mk(200, { granted: false }).check({ device: 'desktop' }), e => e.status === 403);
  await assert.rejects(mk(200, { granted: true, expires_at: new Date(Date.now() - 1000).toISOString() }).check({ device: 'desktop' }), e => e.status === 403);
  await assert.rejects(mk(500, {}).check({ device: 'desktop' }), e => e.status === 503);
  await assert.rejects(mk(200, 'throw').check({ device: 'desktop' }), e => e.status === 503 && !/SECRET/.test(e.message));
  assert.throws(() => gateFromEnv({}), /never always-on/);
  assert.throws(() => gateFromEnv({ TOOLS_GATE_URL: 'https://x' }), /TOOLS_GATE_TOKEN/);
});

test('alerts are deduplicated and deliver without logging the webhook', async () => {
  const sent = [], sink = [];
  let time = 0; const alert = createAlerts({ webhook: 'https://hook.example/SECRET', fetchImpl: async (u, o) => { sent.push(JSON.parse(o.body).text); return new Response('', { status: 200 }); }, now: () => time, sink: e => sink.push(e) });
  assert.equal(await alert('desktop_offline', 'x'), true); assert.equal(await alert('desktop_offline', 'x'), false);
  time = 700000; assert.equal(await alert('desktop_offline', 'x'), true);
  assert.equal(sent.length, 2); assert.match(sent[0], /desktop_offline/); assert.ok(!JSON.stringify(sink).includes('SECRET'));
  const failing = createAlerts({ webhook: 'https://hook.example/SECRET', fetchImpl: async () => { throw new Error('down'); }, sink: e => sink.push(e) });
  await failing('k', 'm'); assert.ok(sink.some(e => e.event === 'alert_delivery_failed')); assert.ok(!JSON.stringify(sink).includes('SECRET'));
});

test('tunnels need a live gate grant, refuse loudly and alert when the desktop is offline', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gate-e2e-'));
  const daemonIdentity = await ensureIdentity(join(dir, 'daemon.json')), controllerIdentity = await ensureIdentity(join(dir, 'controller.json'));
  const trustFile = join(dir, 'trust.json');
  await pairController({ certificate: controllerIdentity.certificate, profiles: ['orin'], mode: 'inspect', origins: [], file: trustFile });
  const gate = createFileGate({ file: join(dir, 'gate.json') }); const alerts = [];
  const tools = await createToolsServer({ file: join(dir, 'state.json'), origin: 'https://tools.example', clientId: 'test', gate, alert: (k, m) => alerts.push(k), onAudit: () => {} });
  const token = secret(), daemonToken = secret();
  tools.auth.state.grants.synthetic = { expires: Date.now() + 600000 };
  tools.auth.state.credentials[hash(token)] = { owner: 'a', role: 'controller', grantId: 'synthetic', tools: ['browser'], expires: Date.now() + 600000 };
  tools.auth.state.credentials[hash(daemonToken)] = { owner: 'a', device: 'desktop', role: 'daemon', tools: ['browser'], expires: Date.now() + 600000 };
  const base = `http://127.0.0.1:${(await tools.listen(0)).port}`;
  const bridge = http.createServer((req, res) => res.end(JSON.stringify(req.url.startsWith('/status') ? { connected: true } : { result: [{ name: 'orin' }] })));
  const bridgePort = await listen(bridge); let daemon;
  t.after(async () => { daemon?.terminate(); await tools.close(); await close(bridge); await rm(dir, { recursive: true, force: true }); });
  const client = createClient({ baseUrl: base + '/browser/desktop', browser: 'orin', fetchImpl: pairedFetch({ server: base, device: 'desktop', token, identity: controllerIdentity, daemonCertificate: daemonIdentity.certificate }) });
  assert.equal((await (await fetch(base + '/health')).json()).gate, 'file');

  // No grant: refused with a visible reason, even though the desktop is offline (no state leak).
  await assert.rejects(client.call('browsers.list'), /refused \(HTTP 403\): No active Resource Gate grant/);
  assert.deepEqual(alerts, []);

  // Grant but desktop offline: clear 503 and a server-side alert.
  const grant = await gate.grant('desktop', 60000);
  await assert.rejects(client.call('browsers.list'), /refused \(HTTP 503\): Desktop browser \(desktop\) is offline/);
  assert.deepEqual(alerts, ['desktop_offline']);

  // Granted and online: works.
  await new Promise(resolve => { daemon = connectDaemon({ server: base, token: daemonToken, identity: daemonIdentity, trustFile, bridgePort, onReady: resolve, onAudit: () => {} }); });
  assert.deepEqual(await client.call('browsers.list'), [{ name: 'orin' }]);
  const devices = await (await fetch(base + '/browser/devices', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(devices[0].grant.active, true);

  // Revoked: next request is refused again.
  await gate.revoke(grant.id);
  await assert.rejects(client.call('browsers.list'), /refused \(HTTP 403\)/);
  assert.equal((await (await fetch(base + '/browser/devices', { headers: { Authorization: `Bearer ${token}` } })).json())[0].grant.active, false);

});
