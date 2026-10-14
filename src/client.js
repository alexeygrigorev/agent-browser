import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const tokenPath = join(homedir(), '.agent-browser', 'token');

export async function getToken({ create = false, path = tokenPath } = {}) {
  if (process.env.AGENT_BROWSER_TOKEN) return process.env.AGENT_BROWSER_TOKEN;
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) throw new Error('No bridge token found. Run agent-browser-bridge serve first.');
    await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString('hex');
    try { await writeFile(path, token + '\n', { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code === 'EEXIST') return (await readFile(path, 'utf8')).trim(); throw error; }
    return token;
  }
}

export function getPort(value = process.env.AGENT_BROWSER_PORT || '19333') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

export function createClient({ token, port = getPort(), timeout = 40000 } = {}) {
  if (!token) throw new Error('Bridge token is required');
  async function request(path, body) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (error) { throw new Error(`Cannot reach browser bridge: ${error.message}`, { cause: error }); }
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || `Bridge HTTP ${response.status}`);
    return payload;
  }
  return {
    status: () => request('/status'),
    async call(method, params = {}) {
      if (typeof method !== 'string' || !method) throw new Error('Method is required');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Params must be a JSON object');
      const payload = await request('/command', { method, params });
      return Object.hasOwn(payload, 'result') ? payload.result : payload;
    }
  };
}
