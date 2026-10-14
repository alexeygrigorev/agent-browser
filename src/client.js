import { launchBridge } from './launcher.js';
import { setTimeout as delay } from 'node:timers/promises';

export function getPort(value = process.env.AGENT_BROWSER_PORT || '19333') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

export function createClient({ port = getPort(), timeout = 40000, autoStart = false, connectTimeout = 35000, launcher = launchBridge } = {}) {
  async function request(path, body, requestTimeout = timeout) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeout)
      });
    } catch (error) { throw new Error(`Cannot reach browser bridge: ${error.message}`, { cause: error }); }
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || `Bridge HTTP ${response.status}`);
    return payload;
  }
  let readiness;
  async function waitForBrowser() {
    const deadline = Date.now() + connectTimeout;
    let launched = false;
    do {
      try {
        const status = await request('/status', undefined, Math.max(1, Math.min(2000, deadline - Date.now())));
        if (typeof status?.connected !== 'boolean') throw new Error('Unexpected browser bridge status response');
        if (status.connected) return;
      } catch (error) {
        // Only an absent listener justifies launching. HTTP, protocol and timeout
        // failures belong to the running bridge and must not spawn another one.
        const code = error.cause?.cause?.code;
        if (code === 'ECONNREFUSED') {
          if (!launched) { launched = true; await launcher(port); }
        } else if (!['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) {
          throw error;
        }
      }
      if (Date.now() < deadline) await delay(Math.min(200, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new Error('Chrome did not connect to the browser bridge. Open Chrome and check that the extension is enabled and not paused.');
  }
  return {
    status: () => request('/status'),
    async call(method, params = {}) {
      if (typeof method !== 'string' || !method) throw new Error('Method is required');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Params must be a JSON object');
      if (autoStart) {
        readiness ||= waitForBrowser().finally(() => { readiness = undefined; });
        await readiness;
      }
      const payload = await request('/command', { method, params });
      return Object.hasOwn(payload, 'result') ? payload.result : payload;
    }
  };
}
