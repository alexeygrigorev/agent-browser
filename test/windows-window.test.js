import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';
import { createBrowserNames } from '../src/browser-names.js';
import { createWindowController, matchChromeWindow } from '../src/windows-window.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('matchChromeWindow prefers newly created HWNDs and minimized title matches', () => {
  const existing = [
    { hwnd: 100, title: 'Inbox - Google Chrome', minimized: false },
    { hwnd: 200, title: 'Finom - Google Chrome', minimized: true }
  ];
  assert.equal(matchChromeWindow([...existing, { hwnd: 300, title: 'about:blank - Google Chrome', minimized: false }], { beforeHwnds: [100, 200] }).hwnd, 300);
  assert.equal(matchChromeWindow(existing, { title: 'Finom', minimizedOnly: true }).hwnd, 200);
  assert.equal(matchChromeWindow([{ hwnd: 100, title: 'Inbox - Google Chrome', minimized: false }], { title: 'Inbox', minimizedOnly: true }), null);
});

test('createWindowController degrades gracefully off Windows and runs Win32 helper on win32', async () => {
  const linux = createWindowController({ platform: 'linux' });
  assert.equal(linux.supported, false);
  assert.deepEqual(await linux.listChromeWindows(), { supported: false, platform: 'linux', foreground: null, windows: [] });
  assert.deepEqual(await linux.placeWindowBehind(123), { supported: false, platform: 'linux', ok: false });

  const calls = [];
  const win = createWindowController({
    platform: 'win32',
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (calls.length === 1) {
        return {
          stdout: JSON.stringify({
            supported: true,
            foreground: { hwnd: 999, title: 'Terminal' },
            windows: [{ hwnd: 444, pid: 10, title: 'Example - Google Chrome', minimized: true }]
          })
        };
      }
      return {
        stdout: JSON.stringify({
          ok: true,
          hwnd: 444,
          wasMinimized: true,
          minimized: false,
          foregroundBefore: { hwnd: 999, title: 'Terminal' },
          foregroundAfter: { hwnd: 999, title: 'Terminal' },
          focusPreserved: true
        })
      };
    }
  });
  const result = await win.restoreWindowBehind({ title: 'Example', minimizedOnly: true });
  assert.equal(result.ok, true);
  assert.equal(result.hwnd, 444);
  assert.equal(result.focusPreserved, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'powershell.exe');
});

async function connectFakeExtension(port, handler) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  await new Promise(resolve => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', protocol: 1, browserId: 'orin-id', version: '0.1.0' }));
  await new Promise(resolve => ws.once('message', resolve));
  ws.on('message', async raw => {
    const message = JSON.parse(raw);
    if (!message.id || !message.method) return;
    try {
      const result = await handler(message.method, message.params || {});
      ws.send(JSON.stringify({ id: message.id, result }));
    } catch (error) {
      ws.send(JSON.stringify({ id: message.id, error: error.message }));
    }
  });
  return ws;
}

test('bridge windows.background creates and places behind without focus, and auto-restores WINDOW_MINIMIZED', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-browser-win-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let winState = 'minimized';
  let placedBehindCalls = 0;
  const windowController = {
    supported: true,
    platform: 'win32',
    async listChromeWindows() {
      return {
        supported: true,
        foreground: { hwnd: 777, title: 'Alexey Editor' },
        windows: [{ hwnd: 101, pid: 1, title: 'Existing - Google Chrome', minimized: winState === 'minimized' }]
      };
    },
    async restoreWindowBehind({ beforeHwnds, title, minimizedOnly }) {
      placedBehindCalls++;
      if (minimizedOnly) winState = 'normal';
      return {
        supported: true,
        ok: true,
        hwnd: beforeHwnds ? 202 : 101,
        wasMinimized: !!minimizedOnly,
        minimized: false,
        foregroundBefore: { hwnd: 777, title: 'Alexey Editor' },
        foregroundAfter: { hwnd: 777, title: 'Alexey Editor' },
        focusPreserved: true
      };
    }
  };
  const bridge = createBridge({ port: 0, names: createBrowserNames({ path: join(dir, 'names.json') }), windowController });
  const address = await bridge.listen();
  t.after(() => bridge.close());

  const ws = await connectFakeExtension(address.port, (method, params) => {
    if (method === 'windows.list') return [{ id: 1, type: 'normal', state: winState, focused: false, activeTabId: 7, activeTabTitle: 'Existing' }];
    if (method === 'windows.create') {
      assert.equal(params.focused, false);
      assert.equal(params.state, 'normal');
      return { windowId: 2, tabId: 20, state: 'normal', focused: false, url: params.url, title: 'Example' };
    }
    if (method === 'windows.restore') return { windowId: 1, state: winState, focused: false, activeTabId: 7, activeTabTitle: 'Existing' };
    if (method === 'page.snapshot') {
      if (winState === 'minimized') throw new Error('WINDOW_MINIMIZED: Tab 7 is in a minimized Chrome window');
      return { title: 'Existing', url: 'https://example.com', text: 'ok', elements: [] };
    }
    throw new Error(`Unexpected ${method}`);
  });
  t.after(() => ws.close());

  const client = createClient({ port: address.port });
  const created = await client.call('windows.background', { url: 'https://example.com' });
  assert.equal(created.action, 'created');
  assert.equal(created.windowId, 2);
  assert.equal(created.tabId, 20);
  assert.equal(created.focused, false);
  assert.equal(created.focusPreserved, true);
  assert.equal(created.foregroundBefore.title, 'Alexey Editor');
  assert.equal(created.foregroundAfter.title, 'Alexey Editor');

  // Auto-restore on WINDOW_MINIMIZED during page.snapshot
  assert.equal(winState, 'minimized');
  const snap = await client.call('page.snapshot', { tabId: 7 });
  assert.equal(snap.text, 'ok');
  assert.equal(winState, 'normal');
  assert.equal(placedBehindCalls, 2);

  // Explicit restore when already normal returns already_normal
  const already = await client.call('windows.background', { restore: true });
  assert.equal(already.action, 'already_normal');
  assert.equal(already.focusPreserved, true);
});

test('bridge explains stale extension when window commands return tabId must be an integer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-browser-stale-win-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bridge = createBridge({ port: 0, names: createBrowserNames({ path: join(dir, 'names.json') }) });
  const address = await bridge.listen();
  t.after(() => bridge.close());

  const ws = await connectFakeExtension(address.port, () => {
    throw new Error('tabId must be an integer');
  });
  t.after(() => ws.close());

  const client = createClient({ port: address.port });
  await assert.rejects(client.call('windows.list'), /Loaded Chrome extension predates windows\.list.*extension reload/);
  await assert.rejects(client.call('windows.background', { restore: true }), /Loaded Chrome extension predates windows\.list.*extension reload/);
});
