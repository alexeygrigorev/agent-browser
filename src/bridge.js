import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export function createBridge({ token, port = 19333, timeout = 30000 }) {
  if (!token || token.length < 32) throw new Error('Token must have at least 32 characters');
  let browser;
  const pending = new Map();
  const authorized = value => {
    const a = Buffer.from(value || '');
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    // Reject browser-origin HTTP calls, including requests from hostile websites.
    if (req.headers.origin || !authorized(req.headers.authorization?.replace(/^Bearer /, ''))) return reply(res, 403, { error: 'Unauthorized' });
    if (req.url === '/status' && req.method === 'GET') return reply(res, 200, { connected: browser?.readyState === WebSocket.OPEN });
    if (req.url !== '/command' || req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) { reply(res, 413, { error: 'Request too large' }); return; }
      }
      const command = JSON.parse(body);
      if (typeof command.method !== 'string' || !command.params || typeof command.params !== 'object' || Array.isArray(command.params)) return reply(res, 400, { error: 'Expected method and params object' });
      if (browser?.readyState !== WebSocket.OPEN) return reply(res, 503, { error: 'Connect the Chrome extension first' });
      const id = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out; action may have executed')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        browser.send(JSON.stringify({ id, ...command, id }));
      });
      reply(res, 200, result);
    } catch (error) { reply(res, error instanceof SyntaxError ? 400 : 502, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    if (req.url !== '/extension' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      let authenticated = false;
      const authTimer = setTimeout(() => ws.close(1008, 'Authentication required'), 5000);
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw);
          if (!authenticated) {
            if (message.type !== 'auth' || !authorized(message.token) || browser) return ws.close(1008, 'Unauthorized or browser already connected');
            authenticated = true; clearTimeout(authTimer); browser = ws;
            ws.send(JSON.stringify({ type: 'ready' })); return;
          }
          if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
          const entry = pending.get(message.id);
          if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
        } catch { ws.close(1008, 'Invalid message'); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(authTimer);
        if (browser !== ws) return;
        browser = undefined;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Browser disconnected; action may have executed')); }
        pending.clear();
      });
    });
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }),
    close: () => new Promise(resolve => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(resolve); })
  };
}
