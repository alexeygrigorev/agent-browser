import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export function createBridge({ port = 19333, timeout = 30000, onDiagnostic = () => {} } = {}) {
  let browser;
  const pending = new Map();
  const localHost = req => req.headers.host === `127.0.0.1:${server.address()?.port}`;
  const reply = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    // Trust local agent processes, but reject website calls and DNS rebinding.
    if (!localHost(req) || req.headers.origin || req.headers['sec-fetch-site']) return reply(res, 403, { error: 'Only local agent processes may call this bridge' });
    if (req.url === '/status' && req.method === 'GET') return reply(res, 200, { connected: browser?.readyState === WebSocket.OPEN });
    if (req.url !== '/command' || req.method !== 'POST') return reply(res, 404, { error: 'Not found' });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) { reply(res, 413, { error: 'Request too large' }); return; }
        chunks.push(chunk);
      }
      const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!command || typeof command !== 'object' || typeof command.method !== 'string' || !command.method || !command.params || typeof command.params !== 'object' || Array.isArray(command.params)) return reply(res, 400, { error: 'Expected method and params object' });
      if (browser?.readyState !== WebSocket.OPEN) return reply(res, 503, { error: 'Connect the Chrome extension first' });
      const id = randomUUID();
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timed out; action may have executed')); }, timeout);
        pending.set(id, { resolve, reject, timer });
        browser.send(JSON.stringify({ method: command.method, params: command.params, id }));
      });
      reply(res, 200, result);
    } catch (error) { reply(res, error instanceof SyntaxError ? 400 : 502, { error: error.message }); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const origin = req.headers.origin || '';
    if (!localHost(req) || req.url !== '/extension' || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      onDiagnostic({ event: 'connection_rejected', reason: 'Expected /extension and a Chrome extension origin' });
      socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      let ready = false;
      const helloTimer = setTimeout(() => ws.close(1008, 'Extension handshake required'), 5000);
      ws.on('message', raw => {
        try {
          const message = JSON.parse(raw);
          if (!ready) {
            // Accept the earlier extension's greeting during an in-place upgrade.
            // Its obsolete token is ignored; all local agents are trusted.
            if (!(message.type === 'hello' && message.protocol === 1) && message.type !== 'auth') return ws.close(1008, 'Unsupported extension protocol');
            if (browser) {
              onDiagnostic({ event: 'connection_rejected', reason: 'Another Chrome profile is already connected' });
              return ws.close(1008, 'Another Chrome profile is already connected');
            }
            ready = true; clearTimeout(helloTimer); browser = ws;
            onDiagnostic({ event: 'connected' });
            ws.send(JSON.stringify({ type: 'ready' })); return;
          }
          if (message.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
          const entry = pending.get(message.id);
          if (entry) { clearTimeout(entry.timer); pending.delete(message.id); entry.resolve(message); }
        } catch { ws.close(1008, 'Invalid message'); }
      });
      ws.on('error', () => {});
      ws.on('close', () => {
        clearTimeout(helloTimer);
        if (browser !== ws) return;
        browser = undefined;
        onDiagnostic({ event: 'disconnected' });
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
