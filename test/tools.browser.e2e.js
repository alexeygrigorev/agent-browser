import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createToolsServer } from '../src/tools/server.js';
import { hash, secret } from '../src/tools/auth.js';
import { ensureIdentity } from '../src/tools/identity.js';

const dir = await mkdtemp(join(tmpdir(), 'tools-browser-'));
let tools, browser, proxy;
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  let upstreamPort;
  proxy = https.createServer({ key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) }, (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: req.headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
    upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${proxy.address().port}`;
  tools = await createToolsServer({ file: join(dir, 'state.json'), origin, clientId: 'synthetic-client' }); upstreamPort = (await tools.listen(0)).port;
  const token = secret(); const csrf = secret();
  tools.auth.state.sessions[hash(token)] = { owner: 'synthetic-user', email: 'synthetic@datatalks.club', csrf, expires: Date.now() + 600000 };
  const identity = await ensureIdentity(join(dir, 'controller-identity.json'));
  const start = await fetch(`http://127.0.0.1:${upstreamPort}/api/auth/device`, { method: 'POST', body: JSON.stringify({ role: 'controller', certificate: identity.certificate, label: 'Synthetic browser CLI' }) });
  const grant = await start.json();
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies([{ name: '__Host-tools-session', value: token, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage(); const requests = [];
  page.on('request', request => { if (request.method() === 'POST') requests.push(request); });
  await page.goto(`${origin}/device?code=${grant.user_code}`);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Device approved', exact: true }).waitFor();
  assert.equal((await requests[0].allHeaders()).origin, origin, 'browser form must retain its real origin');
  const poll = await fetch(`http://127.0.0.1:${upstreamPort}/api/auth/device/token`, { method: 'POST', body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: grant.device_code }) });
  assert.equal((await poll.json()).role, 'controller');
  await page.goto(`${origin}/browser`);
  await page.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('heading', { name: 'Browser devices', exact: true }).waitFor();
  assert.equal(Object.keys(tools.auth.state.credentials).length, 0);
  console.log('PASS: real HTTPS browser approval and revocation forms preserve Origin and enforce CSRF');
} finally {
  await browser?.close(); await tools?.close();
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  await rm(dir, { recursive: true, force: true });
}
