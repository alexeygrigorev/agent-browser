export function getPort(value = process.env.AGENT_BROWSER_PORT || '19333') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

export function createClient({ port = getPort(), timeout = 40000 } = {}) {
  async function request(path, body) {
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
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
