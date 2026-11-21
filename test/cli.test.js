import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

function run(args, input, env = {}, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), ...args], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], cwd
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('simple CLI remembers its profile and tab across real processes and returns action snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'browser-simple-process-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = [];
  let opened = false, value = '', clicked = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = ''; for await (const chunk of req) body += chunk;
    const command = JSON.parse(body); calls.push(command);
    let result;
    const profile = { id: 'stable-main-id', name: 'main', connected: true };
    if (command.method === 'browsers.list') result = [profile];
    else if (command.method === 'browser.info') result = profile;
    else if (command.method === 'extension.info') result = { browser: profile, extension: { current: true }, bridge: {} };
    else if (command.method === 'tabs.list') result = opened ? [{ id: 42, status: 'complete' }] : [];
    else if (command.method === 'tabs.create') { opened = true; assert.equal(command.params.active, false); result = { id: 42 }; }
    else if (command.method === 'page.type') { value = command.params.text; assert.equal(command.params.ref, 'e1'); result = { typed: true }; }
    else if (command.method === 'page.click') { clicked = true; assert.equal(command.params.ref, 'e2'); assert.equal(command.params.mode, 'synthetic'); result = { clicked: true }; }
    else if (command.method === 'page.snapshot') result = { title: 'Fixture', url: 'https://example.test/', text: clicked ? `Saved ${value}` : value, elements: [{ ref: 'e1', tag: 'input' }, { ref: 'e2', tag: 'button', text: 'Save' }] };
    else throw new Error(`Unexpected method ${command.method}`);
    res.end(JSON.stringify({ result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { HOME: directory, USERPROFILE: directory, AGENT_BROWSER_PORT: String(server.address().port), AGENT_BROWSER_NAME: '' };
  for (const args of [['connect', 'main'], ['open', 'https://example.test/'], ['fill', 'e1', 'Grüße "quoted"'], ['click', 'e2']]) {
    const output = await run(['--session', 'process-test', ...args, '--json'], '', env);
    assert.equal(output.code, 0, output.stderr);
    const result = JSON.parse(output.stdout);
    if (args[0] !== 'connect') assert.equal(result.tabId, 42);
    if (args[0] === 'click') assert.equal(result.snapshot.text, 'Saved Grüße "quoted"');
  }
  const saved = JSON.parse(await readFile(join(directory, '.agent-browser', 'sessions', 'process-test.json'), 'utf8'));
  assert.deepEqual(saved, { version: 1, browser: 'stable-main-id', tabId: 42 });
  assert.ok(calls.filter(call => call.method.startsWith('page.')).every(call => call.browser === 'stable-main-id'));
});

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

test('CLI screenshot creates missing parent folders for relative and absolute outputs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-screenshot-dirs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    for await (const chunk of req) void chunk;
    res.end(JSON.stringify({ result: { data: png.toString('base64') } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port) };
  // Native separators: on Windows this is exactly `scratch\\x.png`.
  const relative = ['scratch', 'x.png'].join(sep);
  const first = await run(['--no-autostart', 'screenshot', '42', '--output', relative], '', env, directory);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).path, join(directory, 'scratch', 'x.png'));
  assert.deepEqual(await readFile(join(directory, 'scratch', 'x.png')), png);
  const absolute = join(directory, 'a', 'b', 'c', 'shot.jpg');
  const second = await run(['--no-autostart', 'screenshot', '42', '--output', absolute], '', env);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(await readFile(absolute), png);
});

test('CLI click, hover and mouse commands send coordinate and selector input params', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ result: { ok: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port), AGENT_BROWSER_NAME: undefined };
  const commands = [
    [['--browser', 'orin', 'click', '7', '120.5', '64'], { method: 'page.click', params: { tabId: 7, x: 120.5, y: 64 }, browser: 'orin' }],
    [['click', '7', 'button.menu', '--button', 'right', '--count', '2'], { method: 'page.click', params: { tabId: 7, button: 'right', clickCount: 2, selector: 'button.menu' } }],
    [['click', '7', 'li[role=option]', '--text', 'Germany', '--synthetic', '--no-fallback'], { method: 'page.click', params: { tabId: 7, match: 'Germany', mode: 'synthetic', fallback: false, selector: 'li[role=option]' } }],
    [['key', '7', 'ArrowDown', '--count', '3'], { method: 'page.key', params: { tabId: 7, key: 'ArrowDown', count: 3 } }],
    [['key', '7', 'Enter'], { method: 'page.key', params: { tabId: 7, key: 'Enter' } }],
    [['type', '7', 'Ger', '--selector', '#country', '--keys', '--keep'], { method: 'page.type', params: { tabId: 7, text: 'Ger', selector: '#country', keys: true, clear: false } }],
    [['navigate', '7', 'https://mail.google.com/mail/u/0/#all/abc', '--wait-for', 'h2.hP'], { method: 'tabs.navigate', params: { tabId: 7, url: 'https://mail.google.com/mail/u/0/#all/abc', waitFor: 'h2.hP' } }],
    [['hover', '7', '300', '40'], { method: 'page.hover', params: { tabId: 7, x: 300, y: 40 } }],
    [['hover', '7', '#side [aria-label="Open"]'], { method: 'page.hover', params: { tabId: 7, selector: '#side [aria-label="Open"]' } }],
    [['mouse', 'move', '7', '10', '20'], { method: 'page.mouse', params: { tabId: 7, action: 'move', x: 10, y: 20 } }],
    [['mouse', 'down', '7', '--button', 'middle'], { method: 'page.mouse', params: { tabId: 7, action: 'down', button: 'middle' } }],
    [['mouse', 'up', '7', '50', '60'], { method: 'page.mouse', params: { tabId: 7, action: 'up', x: 50, y: 60 } }]
  ];
  for (const [args] of commands) {
    const result = await run(args, '', env);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.deepEqual(requests, commands.map(([, request]) => request));
  for (const args of [['click', '7'], ['click', 'tab', '1', '2'], ['hover', '7', '1', '2', '--button', 'left'], ['mouse', 'move', '7'], ['mouse', 'drag', '7', '1', '2'], ['click', '7', '1', '2', '--count', '0'], ['mouse', 'move', '7', '1', '2', '--button', 'left']]) {
    const result = await run(['--no-autostart', ...args], '', env);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /^Usage: (click|hover|mouse)/);
  }
  assert.equal(requests.length, commands.length);
  for (const [args, usage] of [[['key', '7'], /^Usage: key/], [['key', '7', 'a', '--count', '0'], /^Usage: key/], [['type', '7'], /^Usage: type/], [['type', '7', 'x', '--bogus'], /^Usage: type/], [['navigate', '7'], /^Usage: navigate/], [['click', '7', '1', '2', '--text', 'x'], /^Usage: click/]]) {
    const result = await run(['--no-autostart', ...args], '', env);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, usage);
  }
  assert.equal(requests.length, commands.length);
});

test('CLI download commands preserve filenames and return desktop metadata', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ result: { id: 5, filename: '/desktop/Downloads/report.csv', state: 'complete' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port) };
  for (const args of [['download', 'https://example.com/report.csv', '--filename', 'reports/report.csv'], ['downloads', 'wait', '5']]) {
    const result = await run(args, '', env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).filename, '/desktop/Downloads/report.csv');
  }
  assert.deepEqual(requests, [
    { method: 'downloads.start', params: { url: 'https://example.com/report.csv', filename: 'reports/report.csv' } },
    { method: 'downloads.wait', params: { id: 5 } }
  ]);
});


test('CLI extension info and reload map to bridge methods and reject unknown actions', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) return res.end(JSON.stringify({ connected: true }));
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({ result: { extension: { code: 'c'.repeat(64), current: true } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { AGENT_BROWSER_PORT: String(server.address().port), AGENT_BROWSER_NAME: '' };
  for (const args of [['--browser', 'main', 'extension'], ['--browser', 'main', 'extension', 'info'], ['--browser', 'orin', 'extension', 'reload']]) {
    const result = await run(args, '', env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).extension.current, true);
  }
  assert.deepEqual(requests, [
    { method: 'extension.info', params: {}, browser: 'main' },
    { method: 'extension.info', params: {}, browser: 'main' },
    { method: 'extension.reload', params: {}, browser: 'orin' }
  ]);
  const usage = await run(['--browser', 'main', 'extension', 'restart'], '', env);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /Usage: extension \[info\|reload\]/);
  assert.equal(requests.length, 3);
});
