import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function setup({ beforeCommand = async () => {}, config = { enabled: true, token: 'a'.repeat(32) }, sessionConfig = {}, initialGroups = [], uploadNode = { localName: 'input', attributes: ['type', 'file', 'multiple', ''] } } = {}) {
  const calls = [];
  const stored = { ...config };
  let listener;
  let socket;
  let alarm;
  let connections = 0;
  let generatedIds = 0;
  let timerId = 0;
  const timers = new Map();
  const session = { ...sessionConfig };
  const tabs = new Map([
    [7, { id: 7, windowId: 1, title: 'Signed in', url: 'https://example.com', active: true, groupId: -1 }],
    [8, { id: 8, windowId: 1, title: 'Other', url: 'https://example.org', active: false, groupId: -1 }],
    [9, { id: 9, windowId: 2, title: 'Second window', url: 'https://example.net', active: false, groupId: -1 }]
  ]);
  const nativeGroups = new Map(initialGroups.map(group => [group.id, { ...group }]));
  let groupId = 100;
  let groupRemoved;
  const downloads = new Map([[11, { id: 11, url: 'https://example.com/file.txt', filename: 'C:\\Downloads\\file.txt', state: 'in_progress', exists: true, bytesReceived: 4, totalBytes: 12, mime: 'text/plain' }]]);
  const chrome = {
    storage: { local: {
      get: async () => ({ ...stored }), set: async value => Object.assign(stored, value),
      remove: async key => { delete stored[key]; }
    }, session: { get: async () => ({ ...session }), set: async value => Object.assign(session, structuredClone(value)) } },
    debugger: {
      attach: async target => calls.push(['attach', target]),
      detach: async target => calls.push(['detach', target]),
      sendCommand: async (target, method, params) => {
        calls.push([method, target, params]);
        await beforeCommand(method);
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
        if (method === 'DOM.querySelector') return { nodeId: 2 };
        if (method === 'DOM.describeNode') return { node: uploadNode };
        if (method === 'DOM.resolveNode') return { object: { objectId: 'upload-input' } };
        if (method === 'Runtime.callFunctionOn') return { result: { value: { files: [{ name: 'report.txt', size: 12, type: 'text/plain' }] } } };
        if (method === 'Page.getLayoutMetrics') return { cssContentSize: { x: 0, y: 0, width: 1200, height: 4000 } };
        if (method === 'Runtime.evaluate') {
          const value = params.expression.includes('function snapshot') ? { title: 'Page', text: 'Signed in', elements: [] }
            : params.expression.includes('"action":"click"') ? { x: 25, y: 40 } : 'evaluated';
          return { result: { value } };
        }
        return { data: 'image' };
      }, onDetach: { addListener() {} }
    },
    tabs: {
      get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return { ...tabs.get(id) }; },
      query: async query => [...tabs.values()].filter(tab => query.groupId === undefined || tab.groupId === query.groupId).map(tab => ({ ...tab })),
      create: async params => { const tab = { id: 20, windowId: 1, groupId: -1, ...params }; tabs.set(tab.id, tab); return { ...tab }; },
      update: async (id, params) => { Object.assign(tabs.get(id), params); return { ...tabs.get(id) }; },
      remove: async id => { tabs.delete(id); },
      group: async params => {
        calls.push(['tabs.group', params]);
        const id = params.groupId ?? groupId++;
        if (!nativeGroups.has(id)) nativeGroups.set(id, { id, windowId: params.createProperties.windowId, title: '', color: 'grey', collapsed: false });
        for (const tabId of params.tabIds) tabs.get(tabId).groupId = id;
        return id;
      },
      ungroup: async ids => {
        calls.push(['tabs.ungroup', ids]);
        for (const id of ids) {
          const previous = tabs.get(id).groupId;
          tabs.get(id).groupId = -1;
          if (![...tabs.values()].some(tab => tab.groupId === previous)) { nativeGroups.delete(previous); groupRemoved?.({ id: previous }); }
        }
      }
    },
    tabGroups: {
      get: async id => { if (!nativeGroups.has(id)) throw new Error('Group closed'); return { ...nativeGroups.get(id) }; },
      update: async (id, params) => { calls.push(['tabGroups.update', id, params]); Object.assign(nativeGroups.get(id), params); return { ...nativeGroups.get(id) }; },
      onRemoved: { addListener(fn) { groupRemoved = fn; } }
    },
    downloads: {
      download: async params => { calls.push(['downloads.download', params]); return 11; },
      search: async query => {
        calls.push(['downloads.search', query]);
        return query.id === undefined ? [...downloads.values()].filter(item => !query.state || item.state === query.state).slice(0, query.limit) : [downloads.get(query.id)].filter(Boolean);
      }
    },
    alarms: { create() {}, onAlarm: { addListener(fn) { alarm = fn; } } },
    runtime: { id: 'extension-id', onMessage: { addListener(fn) { listener = fn; } } }
  };
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 1; this.sent = []; socket = this; connections++; }
    send(value) { this.sent.push(JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const context = vm.createContext({ chrome, WebSocket, crypto: { randomUUID: () => { generatedIds++; return randomUUID(); } }, setInterval: () => 1, clearInterval() {},
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(await readFile(new URL('./background.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return { calls, stored, socket, downloads, tabs, nativeGroups, session,
    currentSocket: () => socket,
    timers,
    runTimer: async delay => {
      const entry = [...timers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected timer for ${delay}ms`);
      timers.delete(entry[0]);
      await entry[1].fn();
    },
    alarm: () => alarm({ name: 'reconnect' }),
    connections: () => connections,
    generatedIds: () => generatedIds,
    command: async (method, params = {}) => {
      await socket.onmessage({ data: JSON.stringify({ id: 'test', method, params }) });
      return socket.sent.at(-1);
    },
    message: value => new Promise(resolve => listener(value, { id: 'extension-id' }, resolve))
  };
}

test('first install automatically introduces itself to the fixed loopback bridge without tokens', async () => {
  const { socket, message, stored } = await setup({ config: {} });
  socket.onopen();
  assert.equal(socket.url, 'ws://127.0.0.1:19333/extension');
  assert.deepEqual(socket.sent[0], { type: 'hello', protocol: 1, browserId: stored.browserId });
  assert.match(stored.browserId, /^[a-f0-9-]{36}$/);
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
  test(`policy rejection shows "${reason}" and retries automatically`, async () => {
    const { socket, message, stored, runTimer, connections } = await setup();
    await socket.onclose({ code: 1008, reason });
    const state = await message({ type: 'status' });
    assert.equal(state.enabled, true);
    assert.ok(state.status.includes(reason));
    assert.match(state.status, /retrying automatically/);
    assert.equal(stored.enabled, true);
    assert.equal(stored.token, undefined);
    await runTimer(1000);
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

test('retry backoff caps at five seconds and resets after ready', async () => {
  const { currentSocket, runTimer, connections } = await setup();
  for (const delay of [1000, 2000, 4000, 5000, 5000]) {
    await currentSocket().onclose({ code: 1006 });
    await runTimer(delay);
  }
  assert.equal(connections(), 6);
  await currentSocket().onmessage({ data: JSON.stringify({ type: 'ready' }) });
  await currentSocket().onclose({ code: 1006 });
  await runTimer(1000);
  assert.equal(connections(), 7);
});

test('handshake watchdog retries a stuck socket automatically', async () => {
  const { runTimer, connections, socket } = await setup();
  await runTimer(10000);
  assert.equal(socket.readyState, 3);
  await runTimer(1000);
  assert.equal(connections(), 2);
});

test('explicit pause cancels scheduled reconnect and watchdog', async () => {
  const { socket, message, timers, alarm, connections, stored } = await setup();
  await socket.onclose({ code: 1006 });
  await message({ type: 'disconnect' });
  assert.equal(timers.size, 0);
  assert.equal(stored.paused, true);
  await alarm();
  assert.equal(connections(), 1);
});

test('old policy failure auto-recovers but explicit pause remains respected', async () => {
  const legacy = await setup({ config: { enabled: false, connectionError: 'Another profile connected' } });
  assert.equal(legacy.connections(), 1);
  assert.equal(legacy.stored.enabled, true);
  assert.equal(legacy.stored.connectionError, undefined);
  const paused = await setup({ config: { enabled: false, paused: true, connectionError: 'Old failure' } });
  assert.equal(paused.connections(), 0);
  assert.equal((await paused.message({ type: 'status' })).status, 'Paused');
});

test('browser identity persists through reconnects and service-worker restarts', async () => {
  const first = await setup({ config: {} });
  const browserId = first.stored.browserId;
  assert.equal(first.generatedIds(), 1);
  await first.socket.onclose({ code: 1006 });
  await first.runTimer(1000);
  first.currentSocket().onopen();
  assert.equal(first.currentSocket().sent[0].browserId, browserId);
  assert.equal(first.generatedIds(), 1);
  const restarted = await setup({ config: first.stored });
  restarted.socket.onopen();
  assert.equal(restarted.socket.sent[0].browserId, browserId);
  assert.equal(restarted.generatedIds(), 0);
});

test('runtime status tracks ready metadata, nickname updates and disconnected state', async () => {
  const { socket, message, stored } = await setup();
  await socket.onmessage({ data: JSON.stringify({ type: 'ready', browser: { id: stored.browserId, name: 'main', connected: true } }) });
  let state = await message({ type: 'status' });
  assert.equal(state.browser.name, 'main');
  assert.equal(state.browser.id, stored.browserId);
  assert.equal(state.browser.connected, true);
  await socket.onmessage({ data: JSON.stringify({ type: 'browser', browser: { id: stored.browserId, name: 'work', connected: true } }) });
  state = await message({ type: 'status' });
  assert.equal(state.browser.name, 'work');
  await socket.onclose({ code: 1006 });
  state = await message({ type: 'status' });
  assert.equal(state.browser.name, 'work');
  assert.equal(state.browser.connected, false);
});

test('old bridges can acknowledge connection without browser metadata', async () => {
  const { socket, message, stored } = await setup();
  await socket.onmessage({ data: JSON.stringify({ type: 'ready' }) });
  const state = await message({ type: 'status' });
  assert.equal(state.browser.id, stored.browserId);
  assert.equal(state.browser.connected, true);
  assert.match(state.status, /browser control enabled/);
});

test('uploads browser-machine files through the selected input without duplicating native change events', async () => {
  const { command, calls } = await setup();
  const result = await command('page.upload', { tabId: 7, selector: '#files', files: ['C:\\files\\report.txt'] });
  assert.equal(result.result.files[0].name, 'report.txt');
  const setFiles = calls.find(([method]) => method === 'DOM.setFileInputFiles')[2];
  assert.equal(setFiles.nodeId, 2);
  assert.equal(setFiles.files[0], 'C:\\files\\report.txt');
  const events = calls.find(([method]) => method === 'Runtime.callFunctionOn')[2];
  assert.equal(events.objectId, 'upload-input');
  assert.doesNotMatch(events.functionDeclaration, /dispatchEvent|new Event/);
  assert.match((await command('page.upload', { tabId: 7, selector: '#files', files: ['relative.txt'] })).error, /absolute paths/);
});

test('rejects uploads to non-file controls and single-file controls with multiple paths', async () => {
  const invalid = await setup({ uploadNode: { localName: 'input', attributes: ['type', 'text'] } });
  assert.match((await invalid.command('page.upload', { tabId: 7, selector: '#name', files: ['/tmp/report.txt'] })).error, /input\[type=file\]/);
  assert.equal(invalid.calls.some(([method]) => method === 'DOM.setFileInputFiles'), false);
  const single = await setup({ uploadNode: { localName: 'input', attributes: ['type', 'file'] } });
  assert.match((await single.command('page.upload', { tabId: 7, selector: '#file', files: ['/tmp/one', '/tmp/two'] })).error, /multiple files/);
});

test('downloads return native saved paths, support bounded filtering, and avoid save dialogs', async () => {
  const { command, calls } = await setup();
  const result = await command('downloads.start', { url: 'https://example.com/file.txt', filename: 'agent/file.txt' });
  assert.equal(result.result.filename, 'C:\\Downloads\\file.txt');
  const options = calls.find(([method]) => method === 'downloads.download')[1];
  assert.equal(options.saveAs, false);
  assert.equal(options.conflictAction, 'uniquify');
  assert.equal(options.filename, 'agent/file.txt');
  assert.equal((await command('downloads.info', { id: 11 })).result.id, 11);
  assert.equal((await command('downloads.list', { state: 'in_progress', limit: 5 })).result.length, 1);
  assert.match((await command('downloads.list', { limit: 101 })).error, /limit/);
  assert.match((await command('downloads.start', { url: 'file:///etc/passwd' })).error, /http, https, or data/);
  assert.match((await command('downloads.info', { id: 99 })).error, /No download/);
});

test('waiting for downloads does not block page commands and reports completion', async () => {
  const { command, downloads, runTimer, socket } = await setup();
  const waiting = command('downloads.wait', { id: 11 });
  await new Promise(resolve => setImmediate(resolve));
  const tabs = await command('tabs.list');
  assert.equal(tabs.result[0].id, 7);
  downloads.get(11).state = 'complete';
  await runTimer(200);
  await waiting;
  assert.ok(socket.sent.some(message => message.result?.state === 'complete'));
});

test('download interruption includes the saved path and pause revokes pending waits', async () => {
  const { command, downloads, message, runTimer } = await setup();
  downloads.get(11).state = 'interrupted';
  downloads.get(11).error = 'NETWORK_FAILED';
  const interrupted = await command('downloads.wait', { id: 11 });
  assert.match(interrupted.error, /NETWORK_FAILED/);
  assert.match(interrupted.error, /Downloads/);
  assert.match((await command('downloads.wait', { id: 11, timeoutMs: 30000 })).error, /timeoutMs/);
  downloads.get(11).state = 'in_progress';
  const waiting = command('downloads.wait', { id: 11 });
  await new Promise(resolve => setImmediate(resolve));
  await message({ type: 'disconnect' });
  await runTimer(200);
  await waiting;
});

test('read-only tab listing leaves tabs untouched and CDP control visibly groups its tab', async () => {
  const { command, calls, socket, session, stored } = await setup();
  assert.equal((await command('tabs.list')).result[0].managed, false);
  assert.equal(calls.some(([method]) => method === 'tabs.group'), false);
  await socket.onmessage({ data: JSON.stringify({ type: 'ready', browser: { name: 'main' } }) });
  await command('page.snapshot', { tabId: 7 });
  const group = (await command('groups.list')).result[0];
  assert.equal(group.title, '🤖 Agent · main');
  assert.equal(group.color, 'blue');
  const tab = (await command('tabs.list')).result.find(tab => tab.id === 7);
  assert.equal(tab.groupId, group.id);
  assert.equal(tab.managed, true);
  assert.equal(session.managedGroups[0].ownerId, stored.browserId);
});

test('created and navigated tabs share an owned group per window', async () => {
  const { command, calls } = await setup();
  const created = await command('tabs.create', { url: 'https://example.com/new' });
  assert.equal(created.result.groupId, 100);
  await command('tabs.navigate', { tabId: 7, url: 'https://example.com/changed' });
  await command('groups.manage', { tabId: 9 });
  const groups = (await command('groups.list')).result;
  assert.equal(groups.length, 2);
  assert.equal(groups[0].windowId, 1);
  assert.equal(groups[1].windowId, 2);
  const grouped = calls.filter(([method]) => method === 'tabs.group');
  assert.equal(grouped[1][1].groupId, 100);
});

test('release ungroups and detaches only a managed tab, with a new group after the old one closes', async () => {
  const { command, calls, tabs, nativeGroups } = await setup();
  nativeGroups.set(55, { id: 55, windowId: 1, title: 'Personal', color: 'red' });
  tabs.get(8).groupId = 55;
  assert.equal((await command('groups.release', { tabId: 8 })).result.released, false);
  await command('page.snapshot', { tabId: 7 });
  assert.equal((await command('groups.release', { tabId: 7 })).result.released, true);
  assert.ok(calls.some(([method]) => method === 'detach'));
  assert.equal((await command('tabs.list')).result.find(tab => tab.id === 7).managed, false);
  assert.equal((await command('groups.list')).result.length, 0);
  await command('groups.manage', { tabId: 7 });
  assert.equal((await command('groups.list')).result[0].id, 101);
  assert.equal(nativeGroups.get(55).title, 'Personal');
});

test('browser nickname changes rename owned automatic labels while preserving custom and human titles', async () => {
  const { command, socket, nativeGroups } = await setup();
  nativeGroups.set(55, { id: 55, windowId: 1, title: 'Personal', color: 'red' });
  await command('groups.manage', { tabId: 7 });
  await command('groups.manage', { tabId: 9, title: 'My workflow', color: 'green' });
  await socket.onmessage({ data: JSON.stringify({ type: 'browser', browser: { name: 'orin' } }) });
  await new Promise(resolve => setImmediate(resolve));
  const groups = (await command('groups.list')).result;
  assert.equal(groups.find(group => group.windowId === 1).title, '🤖 Agent · orin');
  assert.equal(groups.find(group => group.windowId === 2).title, 'My workflow');
  assert.equal(groups.find(group => group.windowId === 2).color, 'green');
  assert.equal(nativeGroups.get(55).title, 'Personal');
  assert.match((await command('groups.manage', { tabId: 7, color: 'invalid' })).error, /color/);
});

test('session-owned groups survive worker restart and title-matching human groups are never hijacked', async () => {
  const browserId = randomUUID();
  const owned = await setup({ config: { browserId }, sessionConfig: { managedGroups: [{ id: 44, windowId: 1, ownerId: browserId, autoLabel: true }] }, initialGroups: [{ id: 44, windowId: 1, title: '🤖 Agent · browser', color: 'blue' }] });
  await owned.command('groups.manage', { tabId: 7 });
  assert.equal(owned.tabs.get(7).groupId, 44);
  const fresh = await setup({ config: { browserId }, initialGroups: [{ id: 44, windowId: 1, title: '🤖 Agent · browser', color: 'blue' }] });
  fresh.tabs.get(7).groupId = 44;
  fresh.tabs.get(8).groupId = 44;
  await fresh.command('groups.manage', { tabId: 7 });
  assert.equal(fresh.tabs.get(7).groupId, 100);
  assert.equal(fresh.tabs.get(8).groupId, 44);
  assert.equal(fresh.nativeGroups.get(44).title, '🤖 Agent · browser');
  const stale = await setup({ config: { browserId }, sessionConfig: { managedGroups: [{ id: 99, windowId: 1, ownerId: browserId, autoLabel: true }] } });
  await stale.command('groups.manage', { tabId: 7 });
  assert.equal(stale.tabs.get(7).groupId, 100);
});
