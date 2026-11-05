import tls from 'node:tls';
import http from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { byteChannel } from './channel.js';
import { fingerprint } from './identity.js';

export function pairedFetch({ server, device, token, identity, daemonCertificate }) {
  if (!daemonCertificate) throw new Error('Desktop certificate is not paired. Run auth pair with its independently verified certificate.');
  const expected = fingerprint(daemonCertificate);
  return async (url, options = {}) => {
    const target = new URL(url); const prefix = `/browser/${device}`;
    if (target.origin !== new URL(server).origin || !target.pathname.startsWith(prefix + '/')) throw new Error('Paired endpoint mismatch');
    const wsUrl = new URL(`${prefix}/tunnel`, server); wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 65536, perMessageDeflate: false, handshakeTimeout: 15000 });
    ws.on('error', () => {});
    await once(ws, 'open');
    const channel = byteChannel({ send: data => new Promise((resolve, reject) => ws.send(data, e => e ? reject(e) : resolve())), close: () => ws.close(), pause: () => ws.pause(), resume: () => ws.resume() });
    ws.on('message', data => channel.receive(data)); ws.on('close', () => channel.destroy());
    const secure = tls.connect({ socket: channel, ca: daemonCertificate, cert: identity.certificate, key: identity.key, servername: 'agent-browser.local', rejectUnauthorized: true, minVersion: 'TLSv1.3' });
    secure.on('error', () => {});
    const abort = () => { secure.destroy(options.signal?.reason || new Error('Request aborted')); ws.terminate(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) abort();
      await once(secure, 'secureConnect');
      if (fingerprint(secure.getPeerCertificate().raw) !== expected) throw new Error('Desktop certificate pin mismatch');
      const agent = new http.Agent({ keepAlive: false }); agent.createConnection = () => secure;
      return await new Promise((resolve, reject) => {
        const request = http.request({ hostname: 'agent-browser.local', path: target.pathname.slice(prefix.length) + target.search, method: options.method || 'GET', headers: Object.fromEntries(Object.entries(options.headers || {}).filter(([key]) => key.toLowerCase() !== 'authorization')), agent }, response => {
          const finish = () => { agent.destroy(); secure.destroy(); channel.destroy(); ws.terminate(); options.signal?.removeEventListener('abort', abort); };
          response.once('end', finish);
          response.once('error', finish);
          resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers }));
        });
        request.on('error', e => { agent.destroy(); abort(); reject(e); });
        if (options.body && typeof options.body !== 'string' && !Buffer.isBuffer(options.body)) Readable.from(options.body).on('error', e => request.destroy(e)).pipe(request);
        else request.end(options.body);
      });
    } catch (error) { abort(); options.signal?.removeEventListener('abort', abort); throw error; }
  };
}
