const ENDPOINT = 'ws://127.0.0.1:19333/extension';
let socket;
let enabled = false;
let status = 'Disconnected';
let heartbeat;
let reconnectTimer;
let handshakeTimer;
let retryDelay = 1000;
let browserId;
let browser;
let generation = 0;
let activeGeneration = 0;
let commandQueue = Promise.resolve();
const attached = new Set();
const initializing = new Map();
const startup = chrome.storage.local.get(['enabled', 'paused', 'connectionError', 'browserId']).then(async config => {
  browserId = config.browserId || crypto.randomUUID();
  if (!config.browserId) await chrome.storage.local.set({ browserId });
  browser = { id: browserId, connected: false };
  await chrome.storage.local.remove('token');
  enabled = config.paused !== true && (config.enabled !== false || !!config.connectionError);
  if (enabled && config.connectionError) {
    await chrome.storage.local.set({ enabled: true });
    await chrome.storage.local.remove('connectionError');
  }
  if (!enabled) status = 'Paused';
  if (enabled) connect();
});

async function attach(tabId) {
  if (!attached.has(tabId)) {
    if (!initializing.has(tabId)) initializing.set(tabId, chrome.debugger.attach({ tabId }, '1.3').then(() => attached.add(tabId)).finally(() => initializing.delete(tabId)));
    await initializing.get(tabId);
  }
}
async function cdp(tabId, method, params = {}) {
  if (!enabled || activeGeneration !== generation) throw new Error('Browser access was disconnected');
  await attach(tabId);
  if (!enabled || activeGeneration !== generation) throw new Error('Browser access was disconnected');
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
async function evaluate(tabId, expression) {
  const response = await cdp(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}
async function pageCall(tabId, fn, params) {
  return evaluate(tabId, `(${fn.toString()})(${JSON.stringify(params)})`);
}

async function upload(tabId, { selector, files }) {
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required');
  if (!Array.isArray(files) || !files.length || files.some(file => typeof file !== 'string' || !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(file))) throw new Error('files must contain absolute paths on the browser machine');
  const { root } = await cdp(tabId, 'DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`No element matches ${selector}`);
  const { node } = await cdp(tabId, 'DOM.describeNode', { nodeId });
  const attributes = {};
  for (let index = 0; index < (node.attributes || []).length; index += 2) attributes[node.attributes[index]] = node.attributes[index + 1];
  if (node.localName !== 'input' || attributes.type?.toLowerCase() !== 'file') throw new Error('Upload target must be an input[type=file]');
  if (files.length > 1 && !Object.hasOwn(attributes, 'multiple')) throw new Error('Upload target does not accept multiple files');
  await cdp(tabId, 'DOM.setFileInputFiles', { nodeId, files });
  const { object } = await cdp(tabId, 'DOM.resolveNode', { nodeId });
  const result = await cdp(tabId, 'Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: `function () {
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return { files: Array.from(this.files, file => ({ name: file.name, size: file.size, type: file.type })) };
    }`, returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

// Runs in the page, with no access to extension secrets or privileges.
function snapshot({ maxLength = 50000 } = {}) {
  const selector = element => {
    if (element.id) return '#' + CSS.escape(element.id);
    const path = [];
    while (element && element !== document.documentElement) {
      const tag = element.localName;
      const siblings = [...element.parentElement.children].filter(item => item.localName === tag);
      path.unshift(tag + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(element) + 1})` : ''));
      element = element.parentElement;
    }
    return 'html > ' + path.join(' > ');
  };
  const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
    .filter(element => element.getClientRects().length)
    .slice(0, 500).map(element => ({ selector: selector(element), tag: element.localName,
      text: (element.innerText || element.getAttribute('aria-label') || element.getAttribute('placeholder') || '').slice(0, 300),
      type: element.getAttribute('type'), href: element.getAttribute('href') }));
  return { title: document.title, url: location.href, text: (document.body?.innerText || '').slice(0, Math.min(maxLength, 200000)), elements };
}
function targetAction({ selector, action, text, clear = true }) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`No element matches ${selector}`);
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  if (action === 'click') {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  if (clear) {
    if (element.isContentEditable) element.textContent = '';
    else {
      const setter = Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
      if (!setter) throw new Error('Target is not a text input');
      setter.call(element, '');
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }
  return true;
}

async function dispatch(method, params = {}) {
  if (method === 'tabs.list') return (await chrome.tabs.query({})).map(({ id, windowId, title, url, active, status }) => ({ id, windowId, title, url, active, status }));
  if (method === 'tabs.create') return chrome.tabs.create({ url: params.url || 'about:blank', active: params.active ?? true });
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw new Error('tabId must be an integer');
  if (method === 'tabs.close') { await chrome.tabs.remove(tabId); return { closed: true }; }
  if (method === 'tabs.navigate') return chrome.tabs.update(tabId, { url: params.url });
  if (method === 'page.upload') return upload(tabId, params);
  if (method === 'page.snapshot') return pageCall(tabId, snapshot, params);
  if (method === 'page.evaluate') {
    if (typeof params.expression !== 'string') throw new Error('expression must be a string');
    return evaluate(tabId, params.expression);
  }
  if (method === 'page.click') {
    const point = params.selector ? await pageCall(tabId, targetAction, { ...params, action: 'click' }) : params;
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Provide selector or x and y coordinates');
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return { clicked: true };
  }
  if (method === 'page.type') {
    if (typeof params.text !== 'string') throw new Error('text must be a string');
    if (params.selector) await pageCall(tabId, targetAction, { ...params, action: 'type' });
    await cdp(tabId, 'Input.insertText', { text: params.text });
    return { typed: true };
  }
  if (method === 'page.key') {
    const keys = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32 };
    if (typeof params.key !== 'string') throw new Error('key must be a string');
    const key = { key: params.key, code: params.code || params.key, windowsVirtualKeyCode: keys[params.key] || (params.key.length === 1 ? params.key.toUpperCase().charCodeAt(0) : 0), modifiers: params.modifiers || 0 };
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyDown', ...(params.key === 'Enter' ? { text: '\r' } : params.key.length === 1 && !params.modifiers ? { text: params.key } : {}) });
    await cdp(tabId, 'Input.dispatchKeyEvent', { ...key, type: 'keyUp' });
    return { pressed: true };
  }
  if (method === 'page.scroll') return pageCall(tabId, ({ x = 0, y = 600 }) => { window.scrollBy(x, y); return { x: scrollX, y: scrollY }; }, params);
  if (method === 'page.screenshot') {
    let clip;
    if (params.fullPage) {
      const layout = await cdp(tabId, 'Page.getLayoutMetrics');
      const size = layout.cssContentSize || layout.contentSize;
      clip = { x: size.x, y: size.y, width: size.width, height: size.height, scale: 1 };
    }
    return cdp(tabId, 'Page.captureScreenshot', { format: params.format || 'png', ...(params.quality === undefined ? {} : { quality: params.quality }), ...(clip ? { clip } : {}), captureBeyondViewport: !!params.fullPage });
  }
  if (method === 'cdp.send') {
    if (typeof params.method !== 'string') throw new Error('CDP method must be a string');
    return cdp(tabId, params.method, params.params || {});
  }
  throw new Error(`Unknown method: ${method}`);
}

function connect() {
  if (!enabled || socket) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  status = 'Connecting…';
  const ws = socket = new WebSocket(ENDPOINT);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, browserId }));
  ws.onmessage = async event => {
    if (socket !== ws || !enabled) return;
    let message;
    try { message = JSON.parse(event.data); } catch { ws.close(); return; }
    if (message.type === 'ready') {
      clearTimeout(handshakeTimer);
      retryDelay = 1000;
      status = 'Connected — browser control enabled';
      browser = { ...browser, ...message.browser, connected: true };
      return;
    }
    if (message.type === 'browser') {
      browser = { ...browser, ...message.browser };
      return;
    }
    if (message.type === 'pong') return;
    if (!enabled || !message.id || typeof message.method !== 'string') return;
    const requestedGeneration = generation;
    try {
      const work = commandQueue.then(() => {
        if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
        activeGeneration = requestedGeneration;
        return dispatch(message.method, message.params);
      });
      commandQueue = work.catch(() => {});
      const result = await work;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, result: result ?? null }));
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, error: error.message }));
    }
  };
  ws.onerror = () => { status = 'Bridge unavailable; retrying automatically'; };
  ws.onclose = event => {
    if (socket !== ws) return;
    socket = undefined;
    browser = { ...browser, connected: false };
    generation++;
    clearInterval(heartbeat);
    clearTimeout(handshakeTimer);
    if (!enabled) { status = 'Paused'; return; }
    if (event?.code === 1008) {
      const reason = event.reason || 'Bridge rejected the connection';
      status = `Connection rejected: ${reason}; retrying automatically`;
    } else status = 'Bridge disconnected; retrying automatically';
    reconnectTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 5000);
  };
  handshakeTimer = setTimeout(() => {
    if (socket !== ws) return;
    ws.onclose({ code: 1006 });
    ws.close();
  }, 10000);
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
}
async function disconnect() {
  enabled = false;
  generation++;
  await chrome.storage.local.set({ enabled: false, paused: true });
  await chrome.storage.local.remove('token');
  await chrome.storage.local.remove('connectionError');
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  socket?.close();
  socket = undefined;
  browser = { ...browser, connected: false };
  status = 'Paused';
  await Promise.allSettled([...initializing.values()]);
  await Promise.allSettled([...attached].map(tabId => chrome.debugger.detach({ tabId })));
  attached.clear();
}
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId));
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  await startup;
  if (name === 'reconnect' && enabled && !socket) connect();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    await startup;
    if (message.type === 'disconnect') await disconnect();
    if (message.type === 'connect') {
      await disconnect();
      enabled = true;
      retryDelay = 1000;
      await chrome.storage.local.set({ enabled: true, paused: false });
      connect();
    }
    reply({ enabled, status, browser });
  })().catch(error => reply({ enabled, status: error.message, browser }));
  return true;
});
