import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';
import { createBrowserNames } from '../src/browser-names.js';
import { createClient } from '../src/client.js';

const origin = `chrome-extension://${'c'.repeat(32)}`;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-concurrency-'));
  const bridge = createBridge({ port: 0, timeout: 2000, names: createBrowserNames({ path: join(directory, 'names.json') }) });
  const { port } = await bridge.listen();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  const client = createClient({ port, browser: undefined });
  async function connect(id) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'hello', protocol: 1, browserId: id }));
    assert.equal(JSON.parse((await ready)[0]).type, 'ready');
    return ws;
  }
  return { client, connect, port };
}

test('three same-origin Chrome profiles route concurrent out-of-order commands and reject cross-profile responses', async t => {
  const { client, connect } = await fixture(t);
  const profiles = await Promise.all(['main', 'orin', 'third'].map(async name => {
    const id = randomUUID();
    const ws = await connect(id);
    const renamed = await client.call('browser.rename', { name }, { browser: id });
    assert.equal(renamed.name, name);
    return { id, name, ws };
  }));
  const received = profiles.map(profile => once(profile.ws, 'message').then(([raw]) => JSON.parse(raw)));
  const calls = profiles.map(profile => client.call('page.evaluate', { tabId: 7, expression: profile.name }, { browser: profile.name }));
  const commands = await Promise.all(received);
  assert.equal(new Set(commands.map(command => command.id)).size, 3);
  commands.forEach((command, index) => assert.equal(command.params.expression, profiles[index].name));
  // A buggy profile cannot resolve another browser's pending command.
  profiles[2].ws.send(JSON.stringify({ id: commands[0].id, result: 'wrong browser' }));
  for (const index of [2, 1, 0]) profiles[index].ws.send(JSON.stringify({ id: commands[index].id, result: profiles[index].name }));
  assert.deepEqual(await Promise.all(calls), ['main', 'orin', 'third']);
  await assert.rejects(client.call('tabs.list'), /Multiple browsers.*select/);
  const list = await client.call('browsers.list');
  assert.equal(list.filter(browser => browser.connected).length, 3);
});

test('disconnecting one profile fails only its pending commands and UUID reconnect restores its nickname', async t => {
  const { client, connect } = await fixture(t);
  const mainId = randomUUID(), orinId = randomUUID();
  const main = await connect(mainId), orin = await connect(orinId);
  await client.call('browser.rename', { name: 'main' }, { browser: mainId });
  await client.call('browser.rename', { name: 'orin' }, { browser: orinId });
  const mainMessage = once(main, 'message'), orinMessage = once(orin, 'message');
  const failed = assert.rejects(client.call('tabs.list', {}, { browser: 'main' }), /disconnected.*may have executed/);
  const succeeds = client.call('tabs.list', {}, { browser: 'orin' });
  await mainMessage;
  const command = JSON.parse((await orinMessage)[0]);
  const closed = once(main, 'close');
  main.close();
  await closed;
  orin.send(JSON.stringify({ id: command.id, result: ['orin tabs'] }));
  await failed;
  assert.deepEqual(await succeeds, ['orin tabs']);
  assert.equal((await client.call('browser.info', {}, { browser: 'orin' })).connected, true);
  const offline = (await client.call('browsers.list')).find(browser => browser.id === mainId);
  assert.deepEqual(offline, { id: mainId, name: 'main', connected: false });
  await connect(mainId);
  assert.deepEqual(await client.call('browser.info', {}, { browser: 'main' }), { id: mainId, name: 'main', connected: true });
});

test('concurrent client readiness waits independently for each nickname on a shared bridge', async t => {
  const { client, connect, port } = await fixture(t);
  const main = await connect(randomUUID());
  const initial = await client.call('browsers.list');
  await client.call('browser.rename', { name: 'main' }, { browser: initial[0].id });
  const waitingClient = createClient({ port, browser: 'main', waitForConnection: true, connectTimeout: 800 });
  const unavailable = assert.rejects(waitingClient.call('browser.info', {}, { browser: 'orin' }), /Chrome \(orin\).*did not connect/);
  const ready = await waitingClient.call('browser.info');
  assert.equal(ready.name, 'main');
  await unavailable;
  assert.equal(main.readyState, WebSocket.OPEN);
});
