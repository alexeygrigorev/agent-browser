import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function setup({ beforeCommand = async () => {}, config = { enabled: true, token: 'a'.repeat(32) } } = {}) {
  const calls = [];
  const stored = { ...config };
  let listener;
  let socket;
  let alarm;
  let connections = 0;
  const chrome = {
    storage: { local: {
      get: async () => ({ ...stored }), set: async value => Object.assign(stored, value),
      remove: async key => { delete stored[key]; }
    } },
    debugger: {
      attach: async target => calls.push(['attach', target]),
      detach: async target => calls.push(['detach', target]),
      sendCommand: async (target, method, params) => {
        calls.push([method, target, params]);
        await beforeCommand(method);
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 1200, height: 4000 } };
        if (method === 'Runtime.evaluate') {
          const value = params.expression.includes('function snapshot') ? { title: 'Page', text: 'Signed in', elements: [] }
            : params.expression.includes('"action":"click"') ? { x: 25, y: 40 } : 'evaluated';
          return { result: { value } };
        }
        return { data: 'image' };
      }, onDetach: { addListener() {} }
    },
    tabs: { query: async () => [{ id: 7, title: 'Signed in', url: 'https://example.com', active: true }],
      create: async params => params, update: async (tabId, params) => ({ tabId, ...params }), remove: async () => {} },
    alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
    runtime: { id: 'extension-id', onMessage: { addListener(fn) { listener = fn; } } }
  };
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; socket = this; connections++; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({ chrome, WebSocket, setInterval: () => 1, clearInterval() {} });
  vm.runInContext(await readFile(new URL('./background.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, stored, socket,
    alarm: () => alarm({ name: 'reconnect' }),
    connections: () => connections,
    command: async (method, params = {}) => {
      await socket.onmessage({ data: JSON.stringify({ id: 'test', method, params }) });
      return socket.sent.at(-1);
    },
    message: value => new Promise(resolve => listener(value, { id: 'extension-id' }, resolve))
  };
}

test('first install automatically introduces itself to the fixed loopback bridge without tokens', async () => {
  const { socket, message } = await setup({ config: {} });
  socket.onopen();
  assert.equal(socket.url, 'ws://127.0.0.1:19333/extension');
  assert.deepEqual(socket.sent[0], { type: 'hello', protocol: 1 });
  assert.equal((await message({ type: 'status' })).enabled, true);
});

test('lists tabs, dispatches CDP once attached and reports invalid commands', async () => {
  const { calls, command } = await setup();
  assert.equal((await command('tabs.list')).result[0].id, 7);
  assert.equal((await command('page.evaluate', { tabId: 7, expression: 'document.title' })).result, 'evaluated');
  assert.equal((await command('page.screenshot', { tabId: 7 })).result.data, 'image');
  assert.equal(calls.filter(([method]) => method === 'attach').length, 1);
  assert.match((await command('page.click', { tabId: 7 })).error, /selector or x and y/);
  assert.match((await command('unknown', { tabId: 7 })).error, /Unknown method/);
});

test('disconnect revokes access, erases token, and detaches tabs', async () => {
  const { calls, stored, socket, command, message } = await setup();
  await command('page.screenshot', { tabId: 7 });
  const response = await message({ type: 'disconnect' });
  assert.equal(response.enabled, false);
  assert.equal(stored.enabled, false);
  assert.equal(stored.token, undefined);
  assert.equal(socket.readyState, 3);
  assert.equal(calls.filter(([method]) => method === 'detach').length, 1);
  const before = calls.length;
  await command('page.screenshot', { tabId: 7 });
  assert.equal(calls.length, before);
});

test('snapshot, selector click and typing dispatch the expected browser operations', async () => {
  const { calls, command } = await setup();
  assert.equal((await command('page.snapshot', { tabId: 7 })).result.text, 'Signed in');
  assert.equal((await command('page.click', { tabId: 7, selector: '#submit' })).result.clicked, true);
  const mouseEvents = calls.filter(([method]) => method === 'Input.dispatchMouseEvent');
  assert.equal(mouseEvents.length, 2);
  assert.equal(mouseEvents[0][2].type, 'mousePressed');
  assert.equal(mouseEvents[1][2].type, 'mouseReleased');
  assert.equal(mouseEvents[0][2].x, 25);
  assert.equal(mouseEvents[0][2].y, 40);
  assert.equal((await command('page.type', { tabId: 7, selector: '#name', text: 'Hello "world"' })).result.typed, true);
  const insert = calls.find(([method]) => method === 'Input.insertText');
  assert.equal(insert[2].text, 'Hello "world"');
  assert.ok(calls.some(([method, , params]) => method === 'Runtime.evaluate' && params.expression.includes('"selector":"#name"')));
});

test('disconnect cancels queued work and the remaining steps of an in-flight click', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { calls, command, message } = await setup({ beforeCommand: method => method === 'Input.dispatchMouseEvent' ? blocked : undefined });
  const click = command('page.click', { tabId: 7, x: 10, y: 20 });
  await new Promise(resolve => setImmediate(resolve));
  const queued = command('page.type', { tabId: 7, text: 'must not type' });
  await message({ type: 'disconnect' });
  release();
  await Promise.all([click, queued]);
  assert.equal(calls.filter(([method]) => method === 'Input.dispatchMouseEvent').length, 1);
  assert.equal(calls.filter(([method]) => method === 'Input.insertText').length, 0);
  assert.equal(calls.filter(([method]) => method === 'attach').length, 1);
});

test('full-page screenshots request document dimensions', async () => {
  const { calls, command } = await setup();
  await command('page.screenshot', { tabId: 7, fullPage: true });
  const capture = calls.find(([method]) => method === 'Page.captureScreenshot')[2];
  assert.equal(capture.clip.height, 4000);
  assert.equal(capture.clip.width, 1200);
  assert.equal(capture.captureBeyondViewport, true);
});

for (const reason of ['Another Chrome profile is already connected']) {
  test(`policy rejection shows "${reason}" and stops automatic retries`, async () => {
    const { socket, message, stored, alarm, connections } = await setup();
    await socket.onclose({ code: 1008, reason });
    const state = await message({ type: 'status' });
    assert.equal(state.enabled, false);
    assert.ok(state.status.includes(reason));
    assert.match(state.status, /click Connect to retry/);
    assert.equal(stored.enabled, false);
    assert.equal(stored.token, undefined);
    assert.equal(stored.connectionError, state.status);
    await alarm();
    assert.equal(connections(), 1);
    await message({ type: 'connect' });
    assert.equal(connections(), 2);
    assert.equal(stored.connectionError, undefined);
  });
}

test('transient network closure continues automatic retries', async () => {
  const { socket, message, alarm, connections } = await setup();
  await socket.onclose({ code: 1006, reason: '' });
  const state = await message({ type: 'status' });
  assert.equal(state.enabled, true);
  assert.match(state.status, /retrying automatically/);
  await alarm();
  assert.equal(connections(), 2);
});

test('persisted disconnect opts out of startup connection', async () => {
  const { connections, message, alarm, stored } = await setup({ config: { enabled: false, token: 'legacy' } });
  assert.equal(connections(), 0);
  assert.equal(stored.token, undefined);
  await alarm();
  assert.equal(connections(), 0);
  await message({ type: 'connect' });
  assert.equal(connections(), 1);
  assert.equal(stored.enabled, true);
  assert.equal(stored.token, undefined);
});
