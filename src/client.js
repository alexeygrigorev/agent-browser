import { launchBridge } from './launcher.js';
import { setTimeout as delay } from 'node:timers/promises';
import { stat, open, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export function getPort(value = process.env.AGENT_BROWSER_PORT || '19333') {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535');
  return port;
}

export function createClient({ port = getPort(), timeout = 40000, autoStart = false, waitForConnection = autoStart, connectTimeout = 35000, launcher = launchBridge, browser = process.env.AGENT_BROWSER_NAME } = {}) {
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
  const readiness = new Map();
  async function ensureReady(selectedBrowser, bridgeOnly = false) {
    if (!waitForConnection) return;
    const target = bridgeOnly ? undefined : selectedBrowser;
    const key = JSON.stringify([bridgeOnly, target]);
    if (!readiness.has(key)) readiness.set(key, waitForBrowser(target, bridgeOnly).finally(() => { readiness.delete(key); }));
    await readiness.get(key);
  }
  async function validateFile(path) {
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Upload must be a regular file: ${path}`);
    if (info.size > 64 * 1024 * 1024) throw new Error(`Upload exceeds 64 MiB: ${path}`);
  }
  async function stageFile(path, options = {}) {
    await validateFile(path);
    const selectedBrowser = options.browser ?? browser;
    if (selectedBrowser !== undefined && (typeof selectedBrowser !== 'string' || !selectedBrowser.trim())) throw new Error('Browser must be a non-empty nickname or ID');
    await ensureReady(selectedBrowser, true);
    const query = new URLSearchParams({ name: basename(path) });
    if (selectedBrowser !== undefined) query.set('browser', selectedBrowser);
    const response = await fetch(`http://127.0.0.1:${port}/files?${query}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: createReadStream(path), duplex: 'half', signal: AbortSignal.timeout(timeout)
    });
    const payload = await response.json();
    if (!response.ok || payload.error) throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || `Upload HTTP ${response.status}`);
    return payload;
  }
  const statusPath = browser => browser === undefined ? '/status' : `/status?browser=${encodeURIComponent(browser)}`;
  async function waitForBrowser(selectedBrowser, bridgeOnly = false) {
    const deadline = Date.now() + connectTimeout;
    let launched = false;
    do {
      try {
        const status = await request(statusPath(selectedBrowser), undefined, Math.max(1, Math.min(2000, deadline - Date.now())));
        if (typeof status?.connected !== 'boolean') throw new Error('Unexpected browser bridge status response');
        if (bridgeOnly || status.connected) return;
      } catch (error) {
        // Only an absent listener justifies launching. HTTP, protocol and timeout
        // failures belong to the running bridge and must not spawn another one.
        const code = error.cause?.cause?.code;
        if (code === 'ECONNREFUSED') {
          if (!autoStart) throw new Error('Browser bridge is unavailable. Check the SSH tunnel or start the local bridge.', { cause: error });
          if (!launched) { launched = true; await launcher(port); }
        } else if (!['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE'].includes(code)) {
          throw error;
        }
      }
      if (Date.now() < deadline) await delay(Math.min(200, deadline - Date.now()));
    } while (Date.now() < deadline);
    throw new Error(`Chrome${selectedBrowser === undefined ? '' : ` (${selectedBrowser})`} did not connect to the browser bridge. Open Chrome and check that the extension is enabled and not paused.`);
  }
  const client = {
    stageFile,
    async saveDownload(id, output, options = {}) {
      if (!Number.isInteger(id) || id < 0 || typeof output !== 'string' || !output.trim()) throw new Error('Download save requires a non-negative integer ID and output path');
      const selectedBrowser = options.browser ?? browser;
      if (selectedBrowser !== undefined && (typeof selectedBrowser !== 'string' || !selectedBrowser.trim())) throw new Error('Browser must be a non-empty nickname or ID');
      const path = resolve(output);
      // Acquire the destination exclusively before any network activity. Cleanup
      // is only permitted once this invocation has created the file.
      const file = await open(path, 'wx');
      let complete = false;
      try {
        await ensureReady(selectedBrowser);
        const query = new URLSearchParams();
        if (selectedBrowser !== undefined) query.set('browser', selectedBrowser);
        const response = await fetch(`http://127.0.0.1:${port}/downloads/${id}/file${query.size ? `?${query}` : ''}`, { signal: AbortSignal.timeout(timeout) });
        if (!response.ok) {
          const payload = await response.json();
          throw new Error(typeof payload.error === 'string' ? payload.error : payload.error?.message || `Download HTTP ${response.status}`);
        }
        if (!response.body) throw new Error('Download response has no file body');
        await pipeline(Readable.fromWeb(response.body), file.createWriteStream());
        complete = true;
        return { id, path, bytes: (await stat(path)).size };
      } finally {
        await file.close();
        if (!complete) await unlink(path).catch(() => {});
      }
    },
    async upload(tabId, selector, files, options = {}) {
      if (!Number.isInteger(tabId) || typeof selector !== 'string' || !selector.trim() || !Array.isArray(files) || !files.length || files.some(path => typeof path !== 'string' || !path)) throw new Error('Upload requires tabId, selector and one or more file paths');
      await Promise.all(files.map(validateFile));
      const staged = [];
      for (const path of files) staged.push(await stageFile(path, options));
      return client.call('page.upload', { tabId, selector, files: staged.map(file => file.path) }, options);
    },
    status: () => request(statusPath(browser)),
    async call(method, params = {}, options = {}) {
      if (typeof method !== 'string' || !method) throw new Error('Method is required');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Params must be a JSON object');
      const selectedBrowser = options.browser ?? browser;
      if (selectedBrowser !== undefined && (typeof selectedBrowser !== 'string' || !selectedBrowser.trim())) throw new Error('Browser must be a non-empty nickname or ID');
      await ensureReady(selectedBrowser, ['browsers.list', 'recording.list', 'recording.stop'].includes(method));
      const payload = await request('/command', { method, params, ...(selectedBrowser === undefined ? {} : { browser: selectedBrowser }) });
      return Object.hasOwn(payload, 'result') ? payload.result : payload;
    }
  };
  return client;
}
