import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail, deviceName } from './auth.js';
import { writePrivate } from './private-store.js';

// Resource Gate check for the `browser` resource. Fails closed: anything other
// than an explicit, unexpired grant for the device refuses the tunnel.
// A grant is `{ id, expires }` with `expires` in epoch milliseconds.
export const MAX_GRANT_MS = 8 * 3600 * 1000;

export function createFileGate({ file, now = Date.now }) {
  const read = async () => { try { return JSON.parse(await readFile(file, 'utf8')).grants || []; } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  return {
    kind: 'file',
    async check({ device }) {
      let grants; try { grants = await read(); } catch { throw fail(503, 'Resource Gate grant store is unreadable; browser access is refused'); }
      const active = grants.filter(g => g.device === device && g.expires > now()).sort((a, b) => b.expires - a.expires)[0];
      if (!active) throw fail(403, `No active Resource Gate grant for browser:${device}. Ask Alexey to approve a grant.`);
      return { id: active.id, expires: active.expires };
    },
    async grant(device, ttlMs, label = '') {
      if (!deviceName(device)) throw new Error('Invalid device name');
      if (!Number.isFinite(ttlMs) || ttlMs < 60000 || ttlMs > MAX_GRANT_MS) throw new Error('Grant lifetime must be between 1 minute and 8 hours');
      const grants = (await read()).filter(g => g.expires > now());
      const grant = { id: randomUUID(), device, label: String(label).slice(0, 80), created: now(), expires: now() + ttlMs };
      await writePrivate(file, { grants: [...grants, grant] }); return grant;
    },
    async revoke(id) {
      const grants = await read(); const rest = grants.filter(g => g.id !== id && g.device !== id);
      await writePrivate(file, { grants: rest.filter(g => g.expires > now()) }); return grants.length - rest.length;
    },
    list: async () => (await read()).filter(g => g.expires > now()),
  };
}

// Remote Resource Gate: GET {url}/v1/check?resource=browser&scope=<device> with a
// bearer token; 200 {granted, grant_id, expires_at} where expires_at is ISO time.
export function createHttpGate({ url, token, fetchImpl = fetch, timeout = 5000, now = Date.now }) {
  return {
    kind: 'http',
    async check({ device }) {
      let response, body;
      try {
        response = await fetchImpl(`${url.replace(/\/$/, '')}/v1/check?resource=browser&scope=${encodeURIComponent(device)}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeout) });
        body = await response.json();
      } catch { throw fail(503, 'Resource Gate is unreachable; browser access is refused'); }
      if (!response.ok) throw fail(503, `Resource Gate error (HTTP ${response.status}); browser access is refused`);
      const expires = Date.parse(body?.expires_at);
      if (body?.granted !== true || !Number.isFinite(expires) || expires <= now()) throw fail(403, `No active Resource Gate grant for browser:${device}. Ask Alexey to approve a grant.`);
      return { id: String(body.grant_id || 'gate'), expires };
    },
  };
}

export function gateFromEnv(env = process.env) {
  if (env.TOOLS_GATE_URL) {
    if (!env.TOOLS_GATE_TOKEN) throw new Error('TOOLS_GATE_URL requires TOOLS_GATE_TOKEN');
    return createHttpGate({ url: env.TOOLS_GATE_URL, token: env.TOOLS_GATE_TOKEN });
  }
  if (env.TOOLS_GATE_FILE) return createFileGate({ file: env.TOOLS_GATE_FILE });
  throw new Error('Resource Gate not configured: set TOOLS_GATE_URL (+ TOOLS_GATE_TOKEN) or TOOLS_GATE_FILE. Browser access is never always-on.');
}
