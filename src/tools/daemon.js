import http from 'node:http';
import tls from 'node:tls';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { createClient } from '../client.js';
import { createPolicy } from './policy.js';
import { readTrust, ensureIdentity, identityPath, trustPath, fingerprint } from './identity.js';
import { byteChannel } from './channel.js';
import { sendFrame } from './server.js';
import { json, jsonBody, fail } from './auth.js';
import { createAudit } from './audit.js';

export function connectDaemon({ server, token, identity, bridgePort = 19333, trustFile = trustPath(), onReady = () => {}, policyOptions = {}, onAudit }) {
  if (!identity) throw new Error('A local daemon identity is required');
  const audit = createAudit(onAudit); const policy = createPolicy({ bridgePort, audit, ...policyOptions });
  policy.files.cleanup().catch(() => audit('upload_cleanup_failed'));
  const maintenance = setInterval(() => policy.files.cleanup().catch(() => audit('upload_cleanup_failed')), 600000);
  const sockets = new Set();
  const app = http.createServer(async (req, res) => {
    try {
      const cert = req.socket.getPeerCertificate().raw; const id = fingerprint(cert); const grant = (await readTrust(trustFile))[id];
      if (!grant || grant.expires <= Date.now()) throw fail(403, 'Controller pairing revoked or expired');
      const url = new URL(req.url, 'http://localhost'); const browser = url.searchParams.get('browser');
      if (req.method === 'POST' && url.pathname === '/command') {
        const command = await jsonBody(req, 1024 * 1024); const result = await policy.invoke({ ...grant, fingerprint: id }, command); json(res, 200, { result }); return;
      }
      if (req.method === 'GET' && url.pathname === '/status') {
        if (browser && !grant.profiles.includes(browser)) throw fail(403, 'Profile is outside the paired grant');
        const client = createClient({ port: bridgePort, browser: browser || grant.profiles[0] }); json(res, 200, await client.status()); return;
      }
      if (!grant.profiles.includes(browser)) throw fail(403, 'Explicit paired browser profile required');
      if (req.method === 'POST' && url.pathname === '/files') {
        if (grant.mode === 'inspect') throw fail(403, 'Upload capability is not granted');
        const result = await policy.files.stage(req, url.searchParams.get('name')); audit('upload_staged', { fingerprint: id, profile: browser, bytes: result.size }); json(res, 201, result); return;
      }
      if (req.method === 'GET' && /^\/downloads\/[0-9]+\/file$/.test(url.pathname)) {
        // This endpoint only retrieves a Chrome-managed completed download, and
        // requires the paired browser's download-inspection capability.
        const upstream = http.request({ hostname: '127.0.0.1', port: bridgePort, method: 'GET', path: req.url, timeout: 60000 }, async response => {
          res.writeHead(response.statusCode, response.headers); try { await pipeline(response, res); } catch { res.destroy(); }
        });
        upstream.on('error', () => res.destroy()); upstream.on('timeout', () => upstream.destroy()); res.on('close', () => upstream.destroy()); upstream.end(); return;
      }
      throw fail(404, 'Remote operation is not supported');
    } catch (error) { audit('browser_command', { outcome: 'denied' }); if (!res.headersSent) json(res, error.status || error.statusCode || 400, { error: error.message }); else res.destroy(); }
  });
  app.headersTimeout = 10000; app.requestTimeout = 120000;
  const secureServer = tls.createServer({ key: identity.key, cert: identity.certificate, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.3', handshakeTimeout: 10000 }, async socket => {
    socket.on('error', () => {});
    // Self-signed client certificates are authenticated by a local pin, never
    // by the gateway or a caller-supplied identity header.
    try {
      const id = fingerprint(socket.getPeerCertificate().raw); const grant = (await readTrust(trustFile))[id];
      if (!grant || grant.expires <= Date.now()) throw new Error('Unpaired controller');
      sockets.add(socket);
      const timer = setInterval(async () => { const g = (await readTrust(trustFile).catch(() => ({})))[id]; if (!g || g.expires <= Date.now()) socket.destroy(); }, 2000);
      socket.once('close', () => { clearInterval(timer); sockets.delete(socket); });
      socket.on('error', () => {}); audit('controller_authenticated', { fingerprint: id }); app.emit('connection', socket);
    } catch { audit('controller_rejected'); socket.destroy(); }
  });
  secureServer.on('tlsClientError', () => audit('controller_rejected'));
  const url = new URL('/browser/daemon', server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 131072, perMessageDeflate: false, handshakeTimeout: 15000 });
  const channels = new Map();
  ws.on('message', raw => {
    try {
      const m = JSON.parse(raw);
      if (m.type === 'ready') { if (m.protocol !== 2) throw new Error('Unsupported relay protocol'); onReady(m.device); return; }
      if (m.type === 'open') {
        if (channels.size >= 16 || channels.has(m.id) || typeof m.id !== 'string' || m.id.length > 64) throw new Error('Invalid tunnel');
        const channel = byteChannel({ send: data => sendFrame(ws, { type: 'data', id: m.id, data: data.toString('base64') }), close: () => { channels.delete(m.id); sendFrame(ws, { type: 'close', id: m.id }).catch(() => {}); }, pause: () => ws.pause(), resume: () => ws.resume() });
        channels.set(m.id, channel); secureServer.emit('connection', channel);
      } else if (m.type === 'data') channels.get(m.id)?.receive(Buffer.from(m.data, 'base64'));
      else if (m.type === 'close') channels.get(m.id)?.destroy();
      else throw new Error('Invalid relay frame');
    } catch { ws.close(1008, 'Invalid tunnel protocol'); }
  });
  ws.on('error', () => {}); ws.on('close', () => { clearInterval(maintenance); for (const c of channels.values()) c.destroy(); for (const s of sockets) s.destroy(); channels.clear(); });
  return ws;
}
export async function runDaemon({ credentialFile, bridgePort = 19333 }) {
  const { loadCredential } = await import('./cli.js');
  const identity = await ensureIdentity(identityPath('daemon'));
  let stopping = false, ws;
  const stop = () => { stopping = true; ws?.terminate(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      const credential = await loadCredential(credentialFile);
      if (credential.role !== 'daemon') throw new Error('Run auth login --daemon');
      await createClient({ port: bridgePort, autoStart: true, waitForConnection: true }).call('browsers.list');
      ws = connectDaemon({ server: credential.server, token: credential.access_token, identity, bridgePort, onReady: device => console.error(`Desktop daemon connected: ${device}`) });
      let denied = false; ws.on('unexpected-response', (_req, response) => { denied = [401, 403].includes(response.statusCode); response.resume(); ws.terminate(); });
      await new Promise(resolve => ws.once('close', resolve));
      if (denied) throw new Error('Desktop credential rejected; renew with auth login --daemon');
      if (!stopping) { console.error('Desktop daemon disconnected; reconnecting'); await delay(3000); }
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
