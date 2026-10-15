import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createClient, getPort } from '../src/client.js';

test('client needs no authentication, unwraps results, and reports browser errors', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify({ connected: true }));
    const command = JSON.parse(body);
    if (command.method === 'fail') return res.end(JSON.stringify({ error: { message: 'No such tab' } }));
    res.end(JSON.stringify({ id: 'abc', result: { method: command.method, params: command.params } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port });
  assert.deepEqual(await client.status(), { connected: true });
  assert.deepEqual(await client.call('tabs.list'), { method: 'tabs.list', params: {} });
  await assert.rejects(client.call('fail'), /No such tab/);
  await assert.rejects(client.call('tabs.list', []), /JSON object/);
  assert.ok(requests.every(request => request.authorization === undefined));
});

test('ports must be valid TCP ports', () => {
  assert.equal(getPort('19333'), 19333);
  for (const port of ['0', '65536', 'abc', '1.5']) assert.throws(() => getPort(port));
});

test('remote clients never launch a missing bridge when waiting without autostart', async () => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let launches = 0;
  const client = createClient({ port, autoStart: false, waitForConnection: true, launcher: () => { launches++; } });
  await assert.rejects(client.call('tabs.list'), /Check the SSH tunnel/);
  assert.equal(launches, 0);
});

test('browser selection stays outside extension params and supports per-call override', async t => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ result: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, browser: 'main' });
  await client.call('tabs.list');
  await client.call('browser.rename', { name: 'work' }, { browser: 'profile-id' });
  assert.deepEqual(requests, [
    { method: 'tabs.list', params: {}, browser: 'main' },
    { method: 'browser.rename', params: { name: 'work' }, browser: 'profile-id' }
  ]);
  await assert.rejects(client.call('tabs.list', {}, { browser: '' }), /non-empty nickname or ID/);
});

test('automatic readiness waits for Chrome, preserves status observation, and never retries POST', async t => {
  let checks = 0, posts = 0, launches = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify({ connected: ++checks >= 3 }));
    posts++;
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'Action may have executed' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, autoStart: true, launcher: () => { launches++; } });
  assert.deepEqual(await client.status(), { connected: false });
  await assert.rejects(client.call('page.click', { tabId: 1, selector: 'button' }), /may have executed/);
  assert.equal(posts, 1);
  assert.equal(launches, 0);
  assert.equal(checks, 3);
});

test('automatic readiness reports a paused or closed Chrome without sending a command', async t => {
  let posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ connected: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, autoStart: true, connectTimeout: 50 });
  await assert.rejects(client.call('tabs.list'), /Open Chrome.*not paused/);
  assert.equal(posts, 0);
});

test('an HTTP rejection never launches a bridge or sends a command', async t => {
  let launches = 0, posts = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') posts++;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden by running service' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, autoStart: true, launcher: () => { launches++; } });
  await assert.rejects(client.call('tabs.list'), /Forbidden by running service/);
  assert.equal(launches, 0);
  assert.equal(posts, 0);
});

test('readiness probes respect the connection deadline when a listener hangs', async t => {
  let launches = 0;
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = createClient({ port: server.address().port, autoStart: true, connectTimeout: 50, launcher: () => { launches++; } });
  const started = Date.now();
  await assert.rejects(client.call('tabs.list'), /Cannot reach browser bridge/);
  assert.ok(Date.now() - started < 1000);
  assert.equal(launches, 0);
});

test('readiness retries a reset status socket without launching or repeating the command', async t => {
  let checks = 0, posts = 0, launches = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/status' && ++checks === 1) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/status') return res.end(JSON.stringify({ connected: true }));
    posts++;
    res.end(JSON.stringify({ result: 'done' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, autoStart: true, launcher: () => { launches++; } });
  assert.equal(await client.call('page.click', { tabId: 1, selector: 'button' }), 'done');
  assert.equal(checks, 2);
  assert.equal(launches, 0);
  assert.equal(posts, 1);
});

test('readiness separates browser targets while management commands work without Chrome', async t => {
  const probes = [], commands = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/status')) {
      probes.push(req.url);
      const selected = new URL(req.url, 'http://localhost').searchParams.get('browser');
      return res.end(JSON.stringify({ connected: selected === 'orin' }));
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    commands.push(JSON.parse(body));
    res.end(JSON.stringify({ result: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = createClient({ port: server.address().port, browser: 'main', autoStart: true, connectTimeout: 100 });
  assert.deepEqual(await client.status(), { connected: false });
  const offline = assert.rejects(client.call('tabs.list'), /Chrome \(main\)/);
  assert.deepEqual(await client.call('tabs.list', {}, { browser: 'orin' }), []);
  await offline;
  for (const method of ['browsers.list', 'recording.list', 'recording.stop']) assert.deepEqual(await client.call(method), []);
  assert.deepEqual(commands.map(command => command.method), ['tabs.list', 'browsers.list', 'recording.list', 'recording.stop']);
  assert.equal(commands[0].browser, 'orin');
  assert.ok(probes.includes('/status?browser=main'));
  assert.ok(probes.includes('/status?browser=orin'));
  assert.ok(probes.includes('/status'));
});
