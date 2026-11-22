import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createBrowserNames } from './browser-names.js';
import { createRecordings } from './recordings.js';
import { createFiles } from './files.js';
import { createTeach } from './teach.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { extensionDir as defaultExtensionDir, gitHead, localCode, packageVersion } from './extension-code.js';
import { createWindowController } from './windows-window.js';

export function createBridge({ port = 19333, timeout = 30000, reloadTimeout = 25000, onDiagnostic = () => {}, names = createBrowserNames(), files = createFiles(), teachOptions = {}, extensionDir = defaultExtensionDir, windowController = createWindowController() } = {}) {
  const browsers = new Map();
  const pending = new Map();
  const reconnects = new Map();
  const reloads = new Set();
  const activeRequests = new Map();
  // The code this bridge process started with; a later pull only takes effect after a restart.
  const bridgeInfo = { version: packageVersion(), git: gitHead() };
  // Compares the code the extension reports with this bridge's extension directory.
  async function describeExtension(hello) {
    const version = typeof hello.version === 'string' ? hello.version.slice(0, 40) : null;
    const code = typeof hello.code?.sha256 === 'string' && /^[a-f0-9]{64}$/.test(hello.code.sha256) ? hello.code.sha256 : null;
    const expected = code ? await localCode(hello.code.files, extensionDir) : null;
    return { version, code, expected, current: code ? (expected ? code === expected : null) : false };
  }
  const extensionInfo = browser => {
    const head = gitHead();
    return { browser: metadata(browser), extension: browser.extension, capabilities: { safeReload: true }, bridge: { ...bridgeInfo, ...(head && head !== bridgeInfo.git ? { checkout: head, restartNeeded: true } : {}) } };
  };
  const waitForReconnect = (id, previous) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reconnects.get(id)?.delete(done); reject(new Error(`Extension did not reconnect within ${reloadTimeout / 1000}s after reloading; check that Developer mode is on in chrome://extensions (Chrome disables unpacked extensions on reload without it) and that the extension shows no errors`)); }, reloadTimeout);
    const done = browser => { if (browser === previous) return; clearTimeout(timer); reconnects.get(id).delete(done); resolve(browser); };
    if (!reconnects.has(id)) reconnects.set(id, new Set());
    reconnects.get(id).add(done);
  });
  async function reloadExtension(browser, { onlyIfIdle = false } = {}) {
    if (reloads.has(browser.id)) throw new Error('Extension reload is already in progress; reconnect after it finishes');
    if (onlyIfIdle && (activeRequests.get(browser.id) || [...pending.values()].some(entry => entry.browserId === browser.id) || recordings.list().some(item => item.browserId === browser.id) || (teach.status().state !== 'idle' && teach.status().browserId === browser.id))) {
      throw new Error('Browser is busy; extension was not reloaded. Retry connect after its active commands or recordings finish.');
    }
    reloads.add(browser.id);
    try {
    const before = browser.extension;
    const reconnected = waitForReconnect(browser.id, browser);
    reconnected.catch(() => {});
    let response;
    // The worker may close its socket before the reply arrives; the reconnect still proves the reload.
    try { response = await send(browser, 'extension.reload', {}); }
    catch (error) { if (!/disconnected/.test(error.message)) throw error; }
    if (response?.error) {
      const message = typeof response.error === 'string' ? response.error : response.error.message;
      if (/Unknown method/.test(message)) throw new Error('This extension predates extension reload. Reload it once in chrome://extensions (or restart Chrome); later updates can use extension reload.');
      throw new Error(message);
    }
    const after = await reconnected;
    return { reloaded: true, before, ...extensionInfo(after) };
    } finally { reloads.delete(browser.id); }
  }
  // Local clients and disposable test bridges may use different loopback ports.
  const localHost = req => /^127\.0\.0\.1(?::([1-9][0-9]{0,4}))?$/.test(req.headers.host || '') && Number((req.headers.host || '').split(':')[1] || 80) <= 65535;
  const metadata = browser => ({ id: browser.id, name: browser.name || null, connected: true });
  const select = selector => {
    const connected = [...browsers.values()];
    if (selector) {
      const match = connected.find(b => b.id === selector || b.name === selector.toLowerCase());
      if (!match) throw new Error(`Browser is not connected: ${selector}`);
      return match;
    }
    if (!connected.length) throw new Error('Connect the Chrome extension first');
    if (connected.length > 1) throw new Error('Multiple browsers are connected; select a browser by nickname or ID');
    return connected[0];
  };
  const send = (browser, method, params) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out; action may have executed')); }, timeout);
    pending.set(id, { resolve, reject, timer, browserId: browser.id });
    browser.ws.send(JSON.stringify({ method, params, id }));
  });
  const unwrap = response => {
    if (response?.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
    return response?.result;
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitWindowNormal(browser, windowId, attempts = 8) {
    for (let i = 0; i < attempts; i++) {
      const list = unwrap(await send(browser, 'windows.list', {}));
      const win = list.find(w => w.id === windowId);
      if (!win || win.state !== 'minimized') return win;
      await sleep(75);
    }
    const list = unwrap(await send(browser, 'windows.list', {}));
    return list.find(w => w.id === windowId);
  }
  async function restoreMinimizedWithoutFocus(browser, target) {
    if (!windowController?.supported) return null;
    const nativeResult = await windowController.restoreWindowBehind({ title: target.activeTabTitle, minimizedOnly: true }).catch(() => null);
    if (!nativeResult?.ok) return nativeResult;
    const refreshed = await waitWindowNormal(browser, target.id ?? target.windowId);
    return { ...nativeResult, refreshed };
  }
  async function handleBackgroundWindow(browser, params = {}) {
    if (params.restore || params.windowId !== undefined) {
      const list = unwrap(await send(browser, 'windows.list', {}));
      const target = params.windowId !== undefined
        ? list.find(w => w.id === params.windowId)
        : list.find(w => w.type === 'normal' && w.state === 'minimized') || list.find(w => w.type === 'normal');
      if (!target) {
        if (params.windowId !== undefined) throw new Error(`No Chrome window with id ${params.windowId}`);
      } else if (target.state !== 'minimized') {
        return { action: 'already_normal', windowId: target.id, tabId: target.activeTabId, state: target.state, focused: !!target.focused, focusPreserved: true };
      } else {
        const nativeResult = await restoreMinimizedWithoutFocus(browser, target);
        let refreshed = nativeResult?.refreshed;
        if (!refreshed || refreshed.state === 'minimized') {
          const fallback = unwrap(await send(browser, 'windows.restore', { windowId: target.id }));
          refreshed = { id: fallback.windowId, state: fallback.state, focused: fallback.focused, activeTabId: fallback.activeTabId };
        }
        return {
          action: 'restored',
          windowId: refreshed.id ?? target.id,
          tabId: refreshed.activeTabId ?? target.activeTabId,
          state: refreshed.state || 'normal',
          focused: !!refreshed.focused,
          focusPreserved: nativeResult?.focusPreserved ?? true,
          ...(nativeResult?.hwnd ? { hwnd: nativeResult.hwnd } : {}),
          ...(nativeResult?.foregroundBefore ? { foregroundBefore: nativeResult.foregroundBefore, foregroundAfter: nativeResult.foregroundAfter } : {})
        };
      }
    }
    const before = windowController?.supported ? await windowController.listChromeWindows().catch(() => null) : null;
    const beforeHwnds = before?.windows?.map(w => w.hwnd);
    const created = unwrap(await send(browser, 'windows.create', {
      url: params.url || 'about:blank',
      focused: false,
      state: 'normal',
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.height !== undefined ? { height: params.height } : {}),
      ...(params.left !== undefined ? { left: params.left } : {}),
      ...(params.top !== undefined ? { top: params.top } : {})
    }));
    let nativeResult = null;
    if (windowController?.supported) {
      for (let attempt = 0; attempt < 4; attempt++) {
        nativeResult = await windowController.restoreWindowBehind({ beforeHwnds, title: created.title, minimizedOnly: false }).catch(() => null);
        if (nativeResult?.ok) break;
        await sleep(100);
      }
    }
    const fgBefore = before?.foreground || nativeResult?.foregroundBefore;
    const fgAfter = nativeResult?.foregroundAfter || fgBefore;
    const focusPreserved = fgBefore && fgAfter ? fgBefore.hwnd === fgAfter.hwnd : (nativeResult?.focusPreserved ?? true);
    return {
      action: 'created',
      ...created,
      focused: false,
      focusPreserved,
      ...(nativeResult?.hwnd ? { hwnd: nativeResult.hwnd } : {}),
      ...(fgBefore ? { foregroundBefore: fgBefore, foregroundAfter: fgAfter } : {})
    };
  }
  const recordings = createRecordings({ capture: async (browserId, tabId) => {
    const response = await send(select(browserId), 'page.screenshot', { tabId, format: 'jpeg', quality: 75 });
    if (response.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
    return response.result;
  } });
  const teach = createTeach({ ...teachOptions, send: async (browserId, method, params) => {
    const response = await send(select(browserId), method, params);
    if (response.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
    return response.result;
  } });
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (!localHost(req) || req.headers.origin || req.headers['sec-fetch-site']) return reply(res, 403, { error: 'Only local agent processes may call this bridge' });
    let activeBrowserId;
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/status' && req.method === 'GET') {
        let connected = browsers.size > 0;
        if (url.searchParams.has('browser')) { try { select(url.searchParams.get('browser')); } catch { connected = false; } }
        return reply(res, 200, { connected });
      }
      if (url.pathname === '/files' && req.method === 'POST') {
        if (url.searchParams.has('browser')) select(url.searchParams.get('browser'));
        return reply(res, 201, await files.stage(req, url.searchParams.get('name')));
      }
      if (/^\/downloads\/[0-9]+\/file$/.test(url.pathname) && req.method === 'GET') {
        const browser = select(url.searchParams.get('browser') || undefined);
        const response = await send(browser, 'downloads.info', { id: Number(url.pathname.split('/')[2]) });
        if (response.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
        const item = response.result;
        if (!item || item.state !== 'complete' || !item.exists || typeof item.filename !== 'string') return reply(res, 409, { error: 'Download is not complete or its saved file no longer exists' });
        const info = await stat(item.filename);
        if (!info.isFile()) throw new Error('Saved download is not a regular file');
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(item.filename))}`, 'Cache-Control': 'no-store' });
        await pipeline(createReadStream(item.filename), res);
        return;
      }
      if (req.url !== '/command' || req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { reply(res, 413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!command || typeof command !== 'object' || typeof command.method !== 'string' || !command.method || !command.params || typeof command.params !== 'object' || Array.isArray(command.params) || (command.browser !== undefined && (typeof command.browser !== 'string' || !command.browser))) return reply(res, 400, { error: 'Expected method, params object, and optional browser name or ID' });
      if (command.method === 'browsers.list') {
        const saved = await names.list();
        const result = [...browsers.values()].map(metadata);
        for (const item of saved) if (!browsers.has(item.id)) result.push({ ...item, connected: false });
        return reply(res, 200, { result });
      }
      if (command.method === 'recording.stop') {
        const record = recordings.list().find(r => r.id === command.params.id);
        if (command.browser && record && select(command.browser).id !== record.browserId) return reply(res, 400, { error: 'Recording belongs to a different browser' });
        return reply(res, 200, { result: await recordings.stop(command.params) });
      }
      // Stopping must work even after Chrome went away.
      if (command.method === 'teach.stop') return reply(res, 200, { result: await teach.stop({ ...command.params, browserId: command.browser }) });
      if (command.method === 'teach.status') return reply(res, 200, { result: teach.status() });
      if (command.method === 'recording.list') {
        const result = recordings.list();
        return reply(res, 200, { result: command.browser ? result.filter(r => r.browserId === select(command.browser).id) : result });
      }
      let browser;
      try { browser = select(command.browser); }
      catch (error) { return reply(res, 503, { error: error.message }); }
      if (command.method === 'browser.info') return reply(res, 200, { result: metadata(browser) });
      if (command.method === 'extension.info') return reply(res, 200, { result: extensionInfo(browser) });
      if (command.method === 'extension.reload') return reply(res, 200, { result: await reloadExtension(browser, command.params) });
      if (reloads.has(browser.id)) throw new Error('Extension reload is in progress; no browser action was sent. Retry after reconnecting.');
      activeBrowserId = browser.id;
      activeRequests.set(browser.id, (activeRequests.get(browser.id) || 0) + 1);
      if (command.method === 'browser.rename') {
        browser.name = await names.rename(browser.id, command.params.name);
        browser.ws.send(JSON.stringify({ type: 'browser', browser: metadata(browser) }));
        return reply(res, 200, { result: metadata(browser) });
      }
      if (command.method === 'teach.start') return reply(res, 200, { result: await teach.start({ ...command.params, browserId: browser.id }) });
      if (command.method === 'recording.start') return reply(res, 200, { result: await recordings.start({ ...command.params, browserId: browser.id }) });
      if (command.method === 'windows.background') return reply(res, 200, { result: await handleBackgroundWindow(browser, command.params) });
      if (command.method === 'page.upload') await files.validate(command.params.files);
      let response = await send(browser, command.method, command.params);
      if (typeof response?.error === 'string' && response.error.startsWith('WINDOW_MINIMIZED:') && windowController?.supported && Number.isInteger(command.params?.tabId)) {
        const info = await send(browser, 'windows.restore', { tabId: command.params.tabId, checkOnly: true }).then(unwrap).catch(() => null);
        if (info?.windowId !== undefined) {
          const restored = await restoreMinimizedWithoutFocus(browser, info);
          if (restored?.ok && restored.refreshed?.state !== 'minimized') {
            response = await send(browser, command.method, command.params);
          }
        }
      }
      reply(res, 200, response);
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else reply(res, error.statusCode || (error instanceof SyntaxError ? 400 : 502), { error: error.message });
    } finally {
      if (activeBrowserId) {
        const remaining = (activeRequests.get(activeBrowserId) || 1) - 1;
        if (remaining) activeRequests.set(activeBrowserId, remaining); else activeRequests.delete(activeBrowserId);
      }
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    if (!localHost(req) || req.url !== '/extension' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      onDiagnostic({ event: 'connection_rejected', reason: 'Expected /extension and a Chrome extension origin' });
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let browser;
      let initializing = false;
      const helloTimer = setTimeout(() => ws.close(1008, 'Extension handshake required'), 5000);
      ws.on('message', async raw => {
        try {
          const message = JSON.parse(raw);
          if (!browser) {
            if (initializing) return ws.close(1008, 'Handshake still in progress');
            if (!(message.type === 'hello' && message.protocol === 1) && message.type !== 'auth') return ws.close(1008, 'Unsupported extension protocol');
            const legacyId = `extension:${origin.slice('chrome-extension://'.length)}`;
            const id = message.browserId || legacyId;
            if (typeof id !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(id)) return ws.close(1008, 'Invalid browser ID');
            if (browsers.has(id)) return ws.close(1008, 'This browser is already connected');
            initializing = true;
            const extension = await describeExtension(message);
            let name = await names.get(id);
            if (!name && id !== legacyId && !browsers.has(legacyId) && await names.get(legacyId)) name = await names.migrate(legacyId, id);
            if (ws.readyState !== WebSocket.OPEN) return;
            if (browsers.has(id)) return ws.close(1008, 'This browser is already connected');
            browser = { ws, id, name, origin, extension };
            browsers.set(id, browser);
            clearTimeout(helloTimer);
            onDiagnostic({ event: 'connected', browser: metadata(browser), extension });
            if (extension.current === false) onDiagnostic({ event: 'extension_mismatch', browser: metadata(browser), extension, bridge: bridgeInfo });
            for (const done of reconnects.get(id) || []) done(browser);
            ws.send(JSON.stringify({ type: 'ready', browser: metadata(browser) })); return;
          }
          if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
          if (message.type === 'teach-event') { await teach.ingest(browser.id, message).catch(error => onDiagnostic({ event: 'teach_write_failed', error: error.message })); return; }
          const entry = pending.get(message.id);
          if (entry?.browserId === browser.id) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
        } catch { ws.close(1008, 'Invalid message'); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(helloTimer);
        if (!browser || browsers.get(browser.id) !== browser) return;
        browsers.delete(browser.id);
        onDiagnostic({ event: 'disconnected', browserId: browser.id });
        for (const [id, entry] of pending) if (entry.browserId === browser.id) { clearTimeout(entry.timer); entry.reject(new Error('Browser disconnected; action may have executed')); pending.delete(id); }
      });
    });
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }),
    async close() {
      try { await Promise.all([recordings.close(), teach.close()]); }
      finally { for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
    }
  };
}
