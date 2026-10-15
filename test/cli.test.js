import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), ...args], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('CLI stdin preserves JSON quotes, Unicode, and spaces through a real process', async t => {
  let received;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, undefined);
    if (req.url.startsWith('/status')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ connected: true })); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    received = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const params = { tabId: 42, text: 'Hello "browser" — Grüße with spaces' };
  const result = await run(['call', 'page.type', '--stdin'], JSON.stringify(params), { AGENT_BROWSER_PORT: String(server.address().port) });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(received, { method: 'page.type', params });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true });
});

test('CLI reports malformed stdin before contacting the bridge', async () => {
  const result = await run(['call', 'page.type', '--stdin'], '{broken');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Invalid JSON params/);
  assert.equal(result.stdout, '');
});

test('CLI browser identity and nickname commands honor the global selector', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ result: { id: 'profile-id', name: 'main', connected: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port), AGENT_BROWSER_NAME: '' };
  const info = await run(['--browser', 'profile-id', 'browser'], '', env);
  assert.equal(info.code, 0, info.stderr);
  assert.equal(JSON.parse(info.stdout).name, 'main');
  const rename = await run(['--browser', 'profile-id', 'browser', 'name', 'main'], '', env);
  assert.equal(rename.code, 0, rename.stderr);
  assert.deepEqual(requests, [
    { method: 'browser.info', params: {}, browser: 'profile-id' },
    { method: 'browser.rename', params: { name: 'main' }, browser: 'profile-id' }
  ]);
});

test('CLI exports screenshot bytes to a new file and refuses overwrite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-screenshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ result: { data: png.toString('base64') } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port) };
  const path = join(directory, 'screen.png');
  const first = await run(['--no-autostart', 'screenshot', '42', '--output', path], '', env);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(await readFile(path), png);
  assert.equal(requests[0].params.format, 'png');
  const second = await run(['screenshot', '42', '--output', path], '', env);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /EEXIST/);
});

