import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
    if (req.url === '/status') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ connected: true })); return; }
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
