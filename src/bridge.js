import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createBrowserNames } from './browser-names.js';
import { createRecordings } from './recordings.js';
import { createFiles } from './files.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';

export function createBridge({ port = 19333, timeout = 30000, onDiagnostic = () => {}, names = createBrowserNames(), files = createFiles() } = {}) {
  const browsers = new Map();
  const pending = new Map();
  // SSH reverse forwards may use a different loopback port on the remote host.
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
  const recordings = createRecordings({ capture: async (browserId, tabId) => {
    const response = await send(select(browserId), 'page.screenshot', { tabId, format: 'jpeg', quality: 75 });
    if (response.error) throw new Error(typeof response.error === 'string' ? response.error : response.error.message);
    return response.result;
  } });
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    if (!localHost(req) || req.headers.origin || req.headers['sec-fetch-site']) return reply(res, 403, { error: 'Only local agent processes may call this bridge' });
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
      if (command.method === 'recording.list') {
        const result = recordings.list();
        return reply(res, 200, { result: command.browser ? result.filter(r => r.browserId === select(command.browser).id) : result });
      }
      let browser;
      try { browser = select(command.browser); }
      catch (error) { return reply(res, 503, { error: error.message }); }
      if (command.method === 'browser.info') return reply(res, 200, { result: metadata(browser) });
      if (command.method === 'browser.rename') {
        browser.name = await names.rename(browser.id, command.params.name);
        browser.ws.send(JSON.stringify({ type: 'browser', browser: metadata(browser) }));
        return reply(res, 200, { result: metadata(browser) });
      }
      if (command.method === 'recording.start') return reply(res, 200, { result: await recordings.start({ ...command.params, browserId: browser.id }) });
      if (command.method === 'page.upload') await files.validate(command.params.files);
      reply(res, 200, await send(browser, command.method, command.params));
    } catch (error) {
      if (res.headersSent) res.destroy(error);
      else reply(res, error.statusCode || (error instanceof SyntaxError ? 400 : 502), { error: error.message });
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
            let name = await names.get(id);
            if (!name && id !== legacyId && !browsers.has(legacyId) && await names.get(legacyId)) name = await names.migrate(legacyId, id);
            if (ws.readyState !== WebSocket.OPEN) return;
            if (browsers.has(id)) return ws.close(1008, 'This browser is already connected');
            browser = { ws, id, name, origin };
            browsers.set(id, browser);
            clearTimeout(helloTimer);
            onDiagnostic({ event: 'connected', browser: metadata(browser) });
            ws.send(JSON.stringify({ type: 'ready', browser: metadata(browser) })); return;
          }
          if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
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
      try { await recordings.close(); }
      finally { for (const ws of wss.clients) ws.terminate(); wss.close(); await new Promise(resolve => server.close(resolve)); }
    }
  };
}
