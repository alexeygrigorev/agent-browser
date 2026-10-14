import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
