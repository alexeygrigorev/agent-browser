import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { createAuth, json, page, escape, fail } from './auth.js';
import { createAudit } from './audit.js';
import { createAlerts } from './alerts.js';

export async function sendFrame(ws, message) {
  if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 4 * 1024 * 1024) throw new Error('Tunnel unavailable');
  await new Promise((resolve, reject) => ws.send(JSON.stringify(message), e => e ? reject(e) : resolve()));
}
export async function createToolsServer(options) {
  const audit = createAudit(options.onAudit);
  const alert = options.alert || createAlerts({ webhook: options.alertWebhook });
  // Fail closed: without an explicit phone approval gate no controller tunnel is ever opened.
  const gate = options.gate || { check: async () => { throw fail(403, 'Phone approval gate is not configured; browser access is refused'); } };
  const auth = await createAuth({ ...options, gate, audit }); const daemons = new Map(), tunnels = new Map();
  const keyFor = p => `${p.owner}:${p.device}`;
  function closeTunnel(id) {
    const t = tunnels.get(id); if (!t) return; tunnels.delete(id); clearTimeout(t.timer);
    t.controller.close(); sendFrame(t.daemon, { type: 'close', id }).catch(() => {});
    audit('tunnel_closed', { owner: t.principal.owner, device: t.device, bytes: t.bytes });
  }
  function revoked(key) {
    for (const d of daemons.values()) if (d.principal.key === key) d.ws.close(1008, 'Credential revoked');
    for (const [id, t] of tunnels) if (t.principal.key === key) closeTunnel(id);
    audit('credential_revoked');
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, options.origin);
      if (req.headers.origin && req.headers.origin !== options.origin) throw fail(403, 'Cross-origin request denied');
      if (await auth.handle(req, res, url, revoked)) return;
      if (req.method === 'GET' && url.pathname === '/health') { json(res, 200, { ok: true, service: 'dtc-tools', protocol: 2, gate: gate.kind || 'none', devicesOnline: daemons.size }); return; }
      if (req.method === 'GET' && url.pathname === '/') { page(res, 'Your tools', '<a href="/browser">Browser devices</a>'); return; }
      if (req.method === 'GET' && url.pathname === '/browser') {
        const s = auth.session(req); if (!s) { res.writeHead(303, { location: '/auth/login' }); res.end(); return; }
        const devices = [...daemons.values()].filter(d => d.principal.owner === s.owner);
        const credentials = Object.entries(auth.state.credentials).filter(([, c]) => c.owner === s.owner && c.expires > auth.now() && !c.grantId);
        const grants = Object.entries(auth.state.grants || {}).filter(([, c]) => c.owner === s.owner && c.expires > auth.now());
        page(res, 'Browser devices', `<p>Signed in as ${escape(s.email)}.</p><ul>${devices.map(d => `<li>${escape(d.principal.device)} · connected</li>`).join('')}</ul><p>Device login authorizes the gateway connection. Local certificate pairing on the desktop authorizes browser access.</p><a href="/device">Enter a device code</a><h2>Access credentials</h2>${[...credentials, ...grants].map(([id, c]) => `<form method="post" action="/auth/revoke"><p>${escape(c.label)} · ${escape(c.role)} <input type="hidden" name="id" value="${id}"><input type="hidden" name="csrf" value="${escape(s.csrf)}"><button>Revoke</button></p></form>`).join('')}`); return;
      }
      if (req.method === 'GET' && url.pathname === '/browser/devices') { const p = auth.principal(req); const online = [...daemons.values()].filter(d => d.principal.owner === p.owner).map(d => d.principal.device);
        const out = []; for (const name of online) { let grant = null; try { const g = await gate.check({ owner: p.owner, device: name }); grant = { active: true, expires: new Date(g.expires).toISOString() }; } catch (e) { grant = { active: false, reason: e.message }; } out.push({ name, connected: true, grant }); }
        json(res, 200, out); return; }
      if (req.method === 'POST' && url.pathname === '/api/phone-gate/requests') {
        auth.principal(req);
        const body = await (await import('./auth.js')).jsonBody(req);
        const id = String(body.id || randomUUID().slice(0, 12));
        const requester = String(body.requester || '').trim();
        const resource = String(body.resource || 'browser').trim();
        const scope = String(body.scope || 'desktop').trim();
        const reason = String(body.reason || '').trim();
        const ttl_s = Math.min(28800, Math.max(60, Number(body.ttl_s) || 1800));
        if (!requester || !reason) throw fail(400, 'requester and reason are required');
        const item = { id, requester: requester.slice(0, 120), resource: resource.slice(0, 40), scope: scope.slice(0, 40), reason: reason.slice(0, 300), ttl_s, state: 'pending', requestedAt: auth.now(), expires: auth.now() + 900000 };
        auth.state.phoneRequests[id] = item; await auth.save();
        audit('phone_request_created', { id, requester: item.requester, resource: item.resource, scope: item.scope });
        json(res, 201, { ...item, approve_url: `${options.origin}/approve?id=${encodeURIComponent(id)}` }); return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/phone-gate/requests/')) {
        auth.principal(req);
        const id = url.pathname.slice('/api/phone-gate/requests/'.length);
        const item = auth.state.phoneRequests[id];
        if (!item) throw fail(404, 'Request not found');
        json(res, 200, item); return;
      }
      // No plaintext browser-command or file-transfer endpoint remains.
      if (url.pathname.startsWith('/browser/')) auth.principal(req);
      throw fail(404, 'Use the paired TLS browser tunnel');
    } catch (error) {
      audit('http_rejected', { outcome: error.status || 500 });
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Tools request failed' }); else res.destroy();
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 30000; server.maxConnections = 128;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 131072, perMessageDeflate: false });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    let p, device, daemon, grant;
    const refuse = async (status, message) => { audit('tunnel_rejected', { outcome: status }); socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(JSON.stringify({ error: message }))}\r\n\r\n${JSON.stringify({ error: message })}`); };
    try {
      if (req.headers.origin) throw fail(403, 'Browser-origin tunnels are denied');
      if (req.url === '/browser/daemon') {
        p = auth.principal(req, 'daemon');
        if (daemons.has(keyFor(p))) throw fail(409, 'Device already connected');
        if (daemons.size >= 32 || [...daemons.values()].filter(d => d.principal.owner === p.owner).length >= 4) throw fail(429, 'Device limit reached');
      } else {
        const match = /^\/browser\/([a-z][a-z0-9_-]{0,31})\/tunnel$/.exec(req.url);
        if (!match) throw fail(404, 'Unknown tunnel');
        p = auth.principal(req); device = match[1];
        // Gate first so an ungranted caller learns nothing about desktop state.
        try { grant = await gate.check({ owner: p.owner, device }); }
        catch (error) {
          audit('gate_denied', { owner: p.owner, device, outcome: error.status || 503 });
          if ((error.status || 503) >= 500) alert('gate_unavailable', error.message);
          throw error;
        }
        daemon = daemons.get(`${p.owner}:${device}`);
        if (!daemon) { alert('desktop_offline', `Browser access to ${device} was granted but the desktop daemon is offline`); throw fail(503, `Desktop browser (${device}) is offline: the desktop daemon is not connected`); }
        if (tunnels.size >= 16 || [...tunnels.values()].filter(t => t.principal.key === p.key).length >= 4) throw fail(429, 'Tunnel limit reached');
      }
    } catch (error) { await refuse(error.status || 401, error.status ? error.message : 'Unauthorized'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      let alive = true;
      const heartbeat = setInterval(() => {
        if (!alive || !auth.state.credentials[p.key] || p.expires <= auth.now() || p.grantId && !auth.state.grants?.[p.grantId]) { ws.terminate(); return; }
        alive = false; ws.ping();
      }, 10000);
      ws.on('pong', () => { alive = true; }); ws.once('close', () => clearInterval(heartbeat));
      if (daemon) {
        const id = randomUUID(); const t = { controller: ws, daemon: daemon.ws, principal: p, device, bytes: 0, expires: grant.expires, timer: setTimeout(() => closeTunnel(id), Math.min(120000, grant.expires - auth.now())) }; tunnels.set(id, t);
        sendFrame(daemon.ws, { type: 'open', id }).catch(() => closeTunnel(id));
        ws.on('message', (data, binary) => {
          if (!binary || data.length > 65536 || (t.bytes += data.length) > 320 * 1024 * 1024) { closeTunnel(id); return; }
          ws.pause(); sendFrame(daemon.ws, { type: 'data', id, data: data.toString('base64') }).catch(() => closeTunnel(id)).finally(() => ws.resume());
        });
        ws.on('close', () => closeTunnel(id)); audit('tunnel_opened', { owner: p.owner, role: p.role, device, grant: grant.id });
      } else {
        const key = keyFor(p); daemons.set(key, { ws, principal: p });
        ws.on('message', raw => {
          try {
            const m = JSON.parse(raw); const t = tunnels.get(m.id); if (!t || t.daemon !== ws) return;
            if (m.type === 'close') { closeTunnel(m.id); return; }
            if (m.type !== 'data') throw new Error('Invalid tunnel frame');
            const data = Buffer.from(m.data, 'base64'); t.bytes += data.length;
            if (data.length > 65536 || t.bytes > 320 * 1024 * 1024 || t.controller.bufferedAmount > 4 * 1024 * 1024) { closeTunnel(m.id); return; }
            ws.pause(); t.controller.send(data, { binary: true }, error => { if (error) closeTunnel(m.id); ws.resume(); });
          } catch { ws.close(1008, 'Invalid tunnel protocol'); }
        });
        ws.on('close', () => { if (daemons.get(key)?.ws === ws) { daemons.delete(key); alert('desktop_disconnected', `Desktop daemon ${p.device} disconnected`); } for (const [id, t] of tunnels) if (t.daemon === ws) closeTunnel(id); });
        ws.send(JSON.stringify({ type: 'ready', device: p.device, protocol: 2 })); audit('daemon_connected', { owner: p.owner, device: p.device });
      }
    });
  });
  return { server, auth, daemons, tunnels,
    listen: (port = 19336) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve(server.address())); }),
    async close() { for (const [id] of tunnels) closeTunnel(id); for (const d of daemons.values()) d.ws.terminate(); for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
