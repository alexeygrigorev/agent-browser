import http from 'node:http';
import { WebSocket } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createClient } from '../client.js';
import { bridgePath, safeHeaders, sendFrame, waitForDrain } from './server.js';

export function connectDaemon({ server, token, bridgePort = 19333, onReady = () => {} }) {
  const url = new URL('/browser/daemon', server); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 256 * 1024, perMessageDeflate: false, handshakeTimeout: 15000 });
  const requests = new Map(); let processing = Promise.resolve();
  ws.on('message', raw => {
    processing = processing.then(async () => {
      const m = JSON.parse(raw);
      if (m.type === 'ready') { onReady(m.device); return; }
      if (m.type === 'request') {
        if (requests.size >= 32 || requests.has(m.id) || !bridgePath(m.method, m.path)) throw new Error('Invalid browser request');
        const local = http.request({ hostname: '127.0.0.1', port: bridgePort, method: m.method, path: m.path, headers: safeHeaders(m.headers || {}), timeout: 115000 }, async response => {
          try {
            await sendFrame(ws, { type: 'response', id: m.id, status: response.statusCode, headers: safeHeaders(response.headers) });
            let bytes = 0;
            for await (const chunk of response) {
              bytes += chunk.length; if (bytes > 256 * 1024 * 1024) throw new Error('Response too large');
              for (let i = 0; i < chunk.length; i += 65536) await sendFrame(ws, { type: 'response-data', id: m.id, data: chunk.subarray(i, i + 65536).toString('base64') });
            }
            await sendFrame(ws, { type: 'response-end', id: m.id });
          } catch { await sendFrame(ws, { type: 'response-error', id: m.id }).catch(() => {}); }
          finally { requests.delete(m.id); }
        });
        local.on('timeout', () => local.destroy(new Error('Desktop bridge timeout')));
        local.on('error', () => { requests.delete(m.id); sendFrame(ws, { type: 'response-error', id: m.id }).catch(() => {}); });
        requests.set(m.id, { local, bytes: 0 });
      } else if (m.type === 'request-data') {
        const item = requests.get(m.id); if (!item) return;
        const data = Buffer.from(m.data, 'base64'); item.bytes += data.length;
        if (item.bytes > 64 * 1024 * 1024) throw new Error('Request too large');
        if (!item.local.write(data)) { ws.pause(); try { await waitForDrain(item.local); } finally { ws.resume(); } }
      } else if (m.type === 'request-end') requests.get(m.id)?.local.end();
      else if (m.type === 'cancel') { requests.get(m.id)?.local.destroy(); requests.delete(m.id); }
      else throw new Error('Invalid server message');
    }).catch(() => ws.close(1008, 'Invalid browser protocol'));
  });
  ws.on('error', () => {});
  ws.on('close', () => { for (const item of requests.values()) item.local.destroy(); requests.clear(); });
  return ws;
}

export async function runDaemon({ credentialFile, bridgePort = 19333 }) {
  let stopping = false, ws;
  const stop = () => { stopping = true; ws?.terminate(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!stopping) {
      const credential = JSON.parse(await readFile(credentialFile, 'utf8'));
      if (credential.role !== 'daemon' || credential.expires <= Date.now()) throw new Error('Run auth login --daemon to renew the desktop credential');
      await createClient({ port: bridgePort, autoStart: true, waitForConnection: true }).call('browsers.list');
      let denied = false;
      ws = connectDaemon({ server: credential.server, token: credential.access_token, bridgePort, onReady: device => console.error(`Desktop daemon connected: ${device}`) });
      ws.on('unexpected-response', (_request, response) => { denied = [401, 403].includes(response.statusCode); response.resume(); ws.terminate(); });
      await new Promise(resolve => ws.once('close', resolve));
      if (denied) throw new Error('Desktop credential was rejected; run auth login --daemon again');
      if (!stopping) { console.error('Desktop daemon disconnected; reconnecting'); await delay(3000); }
    }
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
