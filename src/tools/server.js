import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuth, json, page, escape, fail } from './auth.js';

export function bridgePath(method, path) {
  const p = new URL(path, 'http://localhost').pathname;
  return method === 'GET' && (p === '/status' || /^\/downloads\/[0-9]+\/file$/.test(p)) || method === 'POST' && ['/command', '/files'].includes(p);
}
export const safeHeaders = headers => Object.fromEntries(['content-type', 'content-length', 'content-disposition'].filter(k => headers[k] !== undefined).map(k => [k, headers[k]]));
export async function sendFrame(ws, message) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 8 * 1024 * 1024) throw new Error('Daemon disconnected or connection congested; action may have executed');
  await new Promise((resolve, reject) => ws.send(JSON.stringify(message), error => error ? reject(error) : resolve()));
}
export function waitForDrain(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { stream.removeListener('drain', done); stream.removeListener('close', done); stream.removeListener('error', error); };
    const done = () => { cleanup(); resolve(); };
    const error = e => { cleanup(); reject(e); };
    if (stream.destroyed || stream.closed) { resolve(); return; }
    stream.once('drain', done); stream.once('close', done); stream.once('error', error);
  });
}

// Auth is shared at the origin root. Tool adapters live under independent paths;
// adding another tool must explicitly authorize its scope and device owner.
export async function createToolsServer(options) {
  const auth = await createAuth(options);
  const daemons = new Map(), pending = new Map();
  const keyFor = p => `${p.owner}:${p.device}`;
  function abort(id, message, status = 502) {
    const p = pending.get(id); if (!p) return;
    clearTimeout(p.timer); pending.delete(id);
    sendFrame(p.ws, { type: 'cancel', id }).catch(() => {});
    if (!p.res.headersSent) json(p.res, status, { error: message }); else p.res.destroy();
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    try {
      const url = new URL(req.url, options.origin);
      // TLS terminates at a local Caddy. This application only binds loopback.
      if (req.headers.origin && req.headers.origin !== options.origin) throw fail(403, 'Cross-origin requests are not allowed');
      if (await auth.handle(req, res, url, key => {
        for (const d of daemons.values()) if (d.principal.key === key) d.ws.close(1008, 'Credential revoked');
        for (const [id, p] of pending) if (p.credentialKey === key) abort(id, 'Credential revoked', 401);
      })) return;
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true, service: 'dtc-tools', version: 1 }); return; }
      if (req.method === 'GET' && url.pathname === '/') { page(res, 'Your tools', '<p>Connect your browser through a signed-in desktop daemon.</p><a href="/browser">Browser devices</a>'); return; }
      if (req.method === 'GET' && url.pathname === '/browser') {
        const s = auth.session(req); if (!s) { res.writeHead(303, { location: '/auth/login' }); res.end(); return; }
        const devices = [...daemons.values()].filter(d => d.principal.owner === s.owner);
        const credentials = Object.entries(auth.state.credentials).filter(([, c]) => c.owner === s.owner && c.expires > auth.now());
        page(res, 'Browser devices', `<p>Signed in as ${escape(s.email)}.</p>${devices.length ? `<ul>${devices.map(d => `<li><strong>${escape(d.principal.device)}</strong> · connected</li>`).join('')}</ul>` : '<p>No desktop daemon is connected.</p>'}<p>On a controlling machine, run <code>auth login</code>, then approve its device code here.</p><a href="/device">Enter a device code</a><h2>Access credentials</h2><p>Revoke access when a machine no longer needs it.</p>${credentials.map(([id, c]) => `<form method="post" action="/auth/revoke"><p>${escape(c.label)} · ${escape(c.role)}${c.device ? ` · ${escape(c.device)}` : ''} <input type="hidden" name="id" value="${id}"><input type="hidden" name="csrf" value="${escape(s.csrf)}"><button>Revoke</button></p></form>`).join('')}`); return;
      }
      if (req.method === 'GET' && url.pathname === '/browser/devices') {
        const p = auth.principal(req); json(res, 200, [...daemons.values()].filter(d => d.principal.owner === p.owner).map(d => ({ name: d.principal.device, connected: true }))); return;
      }
      const match = /^\/browser\/([a-z][a-z0-9_-]{0,31})(\/.*)$/.exec(url.pathname);
      if (!match) throw fail(404, 'Not found');
      const p = auth.principal(req); const path = match[2] + url.search;
      if (!bridgePath(req.method, path)) throw fail(404, 'Not found');
      const daemon = daemons.get(`${p.owner}:${match[1]}`); if (!daemon) throw fail(503, 'Desktop daemon is offline');
      if (pending.size >= 32) throw fail(429, 'Too many in-flight browser requests');
      const id = randomUUID();
      const item = { res, ws: daemon.ws, credentialKey: p.key, received: 0, timer: setTimeout(() => abort(id, 'Browser request timed out; action may have executed', 504), 120000) };
      pending.set(id, item);
      res.once('close', () => { if (pending.has(id)) abort(id, 'Controller disconnected'); });
      await sendFrame(daemon.ws, { type: 'request', id, method: req.method, path, headers: safeHeaders(req.headers) });
      try {
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length; if (bytes > 64 * 1024 * 1024) throw fail(413, 'Upload exceeds 64 MiB');
          for (let start = 0; start < chunk.length; start += 65536) await sendFrame(daemon.ws, { type: 'request-data', id, data: chunk.subarray(start, start + 65536).toString('base64') });
        }
        await sendFrame(daemon.ws, { type: 'request-end', id });
      } catch (error) { abort(id, error.message, error.status || 502); }
    } catch (error) { if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Tools request failed' }); else res.destroy(); }
  });
  server.headersTimeout = 15000; server.requestTimeout = 120000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    let p;
    try {
      if (req.url !== '/browser/daemon' || req.headers.origin) throw fail(403, 'Invalid daemon endpoint');
      p = auth.principal(req, 'daemon');
      if (daemons.has(keyFor(p))) throw fail(409, 'Device is already connected');
    } catch (error) { socket.end(`HTTP/1.1 ${error.status || 401} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const key = keyFor(p); let alive = true;
      daemons.set(key, { ws, principal: p });
      const heartbeat = setInterval(() => {
        if (!alive || !auth.state.credentials[p.key] || p.expires <= auth.now()) { ws.terminate(); return; }
        alive = false; ws.ping();
      }, 20000);
      ws.on('pong', () => { alive = true; });
      let processing = Promise.resolve();
      ws.on('message', raw => {
        // Serialize frames so backpressure cannot reorder response chunks.
        processing = processing.then(async () => {
          const message = JSON.parse(raw); const item = pending.get(message.id);
          if (!item || item.ws !== ws) return;
          if (message.type === 'response') {
            if (item.res.headersSent || !Number.isInteger(message.status) || message.status < 200 || message.status > 599) throw new Error('Invalid response');
            item.res.writeHead(message.status, { ...safeHeaders(message.headers || {}), 'cache-control': 'no-store' });
          } else if (message.type === 'response-data') {
            const data = Buffer.from(message.data, 'base64'); item.received += data.length;
            if (!item.res.headersSent || item.received > 256 * 1024 * 1024) throw new Error('Response limit exceeded');
            if (!item.res.write(data)) { ws.pause(); try { await waitForDrain(item.res); } finally { ws.resume(); } }
          } else if (message.type === 'response-end') {
            clearTimeout(item.timer); pending.delete(message.id); item.res.end();
          } else if (message.type === 'response-error') abort(message.id, 'Desktop request failed; action may have executed');
          else throw new Error('Invalid daemon message');
        }).catch(() => ws.close(1008, 'Invalid daemon protocol'));
      });
      ws.on('error', () => {});
      ws.on('close', () => { clearInterval(heartbeat); if (daemons.get(key)?.ws === ws) daemons.delete(key); for (const [id, item] of pending) if (item.ws === ws) abort(id, 'Desktop disconnected; action may have executed'); });
      ws.send(JSON.stringify({ type: 'ready', device: p.device }));
    });
  });
  return { server, auth, daemons, listen: (port = 19336) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }),
    async close() { for (const [id] of pending) abort(id, 'Server stopping'); for (const d of daemons.values()) d.ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
