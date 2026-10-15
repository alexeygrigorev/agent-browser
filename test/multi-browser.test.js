import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';
import { createBrowserNames } from '../src/browser-names.js';

const origin = `chrome-extension://${'a'.repeat(32)}`;
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-browser-multi-'));
  const path = join(directory, 'names.json');
  let bridge;
  let base;
  async function restart() {
    await bridge?.close();
    bridge = createBridge({ port: 0, timeout: 2000, names: createBrowserNames({ path }) });
    base = `http://127.0.0.1:${(await bridge.listen()).port}`;
  }
  await restart();
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  async function command(method, params = {}, browser) {
    const response = await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ method, params, ...(browser ? { browser } : {}) }) });
    return { status: response.status, ...await response.json() };
  }
  async function connect(browserId, legacy = false) {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}/extension`, { origin });
    await once(ws, 'open');
    const response = new Promise(resolve => {
      const message = raw => { cleanup(); resolve(JSON.parse(raw)); };
      const close = (code, reason) => { cleanup(); resolve({ closed: code, reason: reason.toString() }); };
      const cleanup = () => { ws.off('message', message); ws.off('close', close); };
      ws.once('message', message); ws.once('close', close);
    });
    ws.send(JSON.stringify(legacy ? { type: 'auth' } : { type: 'hello', protocol: 1, ...(browserId ? { browserId } : {}) }));
    return { ws, ready: await response };
  }
  return { restart, command, connect };
}

test('same extension in two profiles has separate persistent nicknames and explicit selection', async t => {
  const { connect, command, restart } = await setup(t);
  const main = await connect('main-id');
  const orin = await connect('orin-id');
  assert.equal(main.ready.browser.id, 'main-id');
  assert.equal(orin.ready.browser.id, 'orin-id');
  assert.equal((await command('tabs.list')).status, 503);
  assert.match((await command('tabs.list')).error, /Multiple browsers/);
  assert.equal((await command('tabs.list', {}, 'missing')).status, 503);
  const mainUpdate = once(main.ws, 'message');
  assert.equal((await command('browser.rename', { name: 'main' }, 'main-id')).result.name, 'main');
  assert.equal(JSON.parse((await mainUpdate)[0]).browser.name, 'main');
  await command('browser.rename', { name: 'orin' }, 'orin-id');
  assert.equal((await command('browser.info', {}, 'main')).result.id, 'main-id');
  assert.equal((await command('browser.info', {}, 'ORIN')).result.id, 'orin-id');
  assert.equal((await command('browsers.list')).result.filter(browser => browser.connected).length, 2);
  await restart();
  const offline = (await command('browsers.list')).result;
  assert.deepEqual(offline.map(({ name, connected }) => ({ name, connected })).sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'main', connected: false }, { name: 'orin', connected: false }]);
  const reconnected = await connect('main-id');
  assert.equal(reconnected.ready.browser.name, 'main');
  assert.equal((await connect('orin-id')).ready.browser.name, 'orin');
  assert.equal((await command('browser.info', {}, 'main')).result.id, 'main-id');
});

test('routes requests by browser and ignores responses spoofed by the other profile', async t => {
  const { connect, command } = await setup(t);
  const main = await connect('main-id');
  const orin = await connect('orin-id');
  const mainMessage = once(main.ws, 'message');
  let settled = false;
  const request = command('page.evaluate', { tabId: 7, expression: 'document.title' }, 'main-id').then(value => { settled = true; return value; });
  const sent = JSON.parse((await mainMessage)[0]);
  assert.equal(sent.params.tabId, 7);
  orin.ws.send(JSON.stringify({ id: sent.id, result: 'wrong-profile' }));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);
  main.ws.send(JSON.stringify({ id: sent.id, result: 'correct-profile' }));
  assert.equal((await request).result, 'correct-profile');
  const orinMessage = once(orin.ws, 'message');
  const otherRequest = command('tabs.list', {}, 'orin-id');
  const otherSent = JSON.parse((await orinMessage)[0]);
  orin.ws.send(JSON.stringify({ id: otherSent.id, result: [{ id: 99 }] }));
  assert.deepEqual((await otherRequest).result, [{ id: 99 }]);
});

test('disconnect rejects only that browser pending commands and preserves the other profile', async t => {
  const { connect, command } = await setup(t);
  const main = await connect('main-id');
  const orin = await connect('orin-id');
  const mainMessage = once(main.ws, 'message');
  const orinMessage = once(orin.ws, 'message');
  const mainRequest = command('tabs.list', {}, 'main-id');
  const orinRequest = command('tabs.list', {}, 'orin-id');
  await mainMessage;
  const sent = JSON.parse((await orinMessage)[0]);
  main.ws.close();
  const failure = await mainRequest;
  assert.equal(failure.status, 502);
  assert.match(failure.error, /Browser disconnected/);
  orin.ws.send(JSON.stringify({ id: sent.id, result: 'still connected' }));
  assert.equal((await orinRequest).result, 'still connected');
  assert.equal((await command('browser.info', {}, 'orin-id')).result.connected, true);
  assert.equal((await command('browser.info', {}, 'main-id')).status, 503);
});

test('legacy clients still connect and duplicates of one installation are rejected', async t => {
  const { connect, command } = await setup(t);
  const legacy = await connect(undefined, true);
  assert.equal(legacy.ready.browser.id, `extension:${'a'.repeat(32)}`);
  assert.equal((await connect(undefined, true)).ready.closed, 1008);
  const modern = await connect('modern-id');
  assert.equal(modern.ready.type, 'ready');
  assert.equal((await connect('modern-id')).ready.closed, 1008);
  assert.equal((await command('browsers.list')).result.filter(browser => browser.connected).length, 2);
});

test('upgrading a legacy installation preserves its nickname without affecting another profile', async t => {
  const { connect, command } = await setup(t);
  const legacy = await connect(undefined, true);
  await command('browser.rename', { name: 'main' }, legacy.ready.browser.id);
  const orin = await connect('orin-id');
  await command('browser.rename', { name: 'orin' }, 'orin-id');
  const closed = once(legacy.ws, 'close');
  legacy.ws.close();
  await closed;
  const upgraded = await connect('upgraded-main-id');
  assert.equal(upgraded.ready.browser.name, 'main');
  assert.equal((await command('browser.info', {}, 'main')).result.id, 'upgraded-main-id');
  assert.equal((await command('browser.info', {}, 'orin')).result.id, 'orin-id');
  const all = (await command('browsers.list')).result;
  assert.equal(all.some(browser => browser.id === legacy.ready.browser.id), false);
  assert.equal(orin.ws.readyState, WebSocket.OPEN);
});
