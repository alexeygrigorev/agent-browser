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
const managedGroups = new Map();
let groupQueue = Promise.resolve();
const startup = chrome.storage.local.get(['enabled', 'paused', 'connectionError', 'browserId']).then(async config => {
  browserId = config.browserId || crypto.randomUUID();
  if (!config.browserId) await chrome.storage.local.set({ browserId });
  browser = { id: browserId, connected: false };
  const session = await chrome.storage.session.get('managedGroups');
  for (const group of session.managedGroups || []) if (group.ownerId === browserId) managedGroups.set(group.windowId, group);
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
    if (!initializing.has(tabId)) initializing.set(tabId, (async () => {
      const requestedGeneration = activeGeneration;
      await manageTab(tabId);
      if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
      await chrome.debugger.attach({ tabId }, '1.3');
      attached.add(tabId);
    })().finally(() => initializing.delete(tabId)));
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

function downloadMetadata(item) {
  return { id: item.id, url: item.url, filename: item.filename, state: item.state, exists: item.exists,
    bytesReceived: item.bytesReceived, totalBytes: item.totalBytes, mime: item.mime, error: item.error || null };
}
async function downloadInfo(id) {
  if (!Number.isInteger(id) || id < 0) throw new Error('Download id must be a non-negative integer');
  const [item] = await chrome.downloads.search({ id });
  if (!item) throw new Error(`No download with id ${id}`);
  return downloadMetadata(item);
}
async function waitForDownload({ id, timeoutMs = 20000 }, requestedGeneration) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 25000) throw new Error('timeoutMs must be between 1 and 25000');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
    const item = await downloadInfo(id);
    if (item.state === 'complete') return item;
    if (item.state === 'interrupted') throw new Error(`Download interrupted: ${item.error || 'unknown reason'}${item.filename ? ` (${item.filename})` : ''}`);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`Download ${id} did not complete within ${timeoutMs}ms${item.filename ? ` (${item.filename})` : ''}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(200, remaining)));
  }
}

const groupTitle = () => `🤖 Agent · ${browser?.name || 'browser'}`;
const saveGroups = () => chrome.storage.session.set({ managedGroups: [...managedGroups.values()] });
function groupOperation(fn) {
  const work = groupQueue.then(fn);
  groupQueue = work.catch(() => {});
  return work;
}
async function existingGroup(windowId) {
  const known = managedGroups.get(windowId);
  if (!known) return;
  try {
    const group = await chrome.tabGroups.get(known.id);
    if (group.windowId === windowId) return { ...group, managed: true };
  } catch {}
  managedGroups.delete(windowId);
  await saveGroups();
}
function manageTab(tabId, { title, color } = {}) {
  const requestedGeneration = generation;
  return groupOperation(async () => {
    if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.length > 80)) throw new Error('Group title must contain 1 to 80 characters');
    if (color !== undefined && !['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'].includes(color)) throw new Error('Unknown tab group color');
    const tab = await chrome.tabs.get(tabId);
    let group = await existingGroup(tab.windowId);
    if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
    if (!group) {
      const id = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      const known = { id, windowId: tab.windowId, ownerId: browserId, autoLabel: title === undefined };
      managedGroups.set(tab.windowId, known);
      await saveGroups();
      group = await chrome.tabGroups.update(id, { title: title ?? groupTitle(), color: color ?? 'blue', collapsed: false });
    } else {
      if (tab.groupId !== group.id) await chrome.tabs.group({ tabIds: [tabId], groupId: group.id });
      if (title !== undefined || color !== undefined) {
        group = await chrome.tabGroups.update(group.id, { ...(title === undefined ? {} : { title }), ...(color === undefined ? {} : { color }) });
        if (title !== undefined) { managedGroups.get(tab.windowId).autoLabel = false; await saveGroups(); }
      }
    }
    return { ...group, managed: true };
  });
}
function renameManagedGroups() {
  return groupOperation(async () => {
    for (const known of [...managedGroups.values()]) {
      if (!known.autoLabel) continue;
      const group = await existingGroup(known.windowId);
      if (group) await chrome.tabGroups.update(group.id, { title: groupTitle() }).catch(() => {});
    }
  });
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
  if (method === 'groups.list') {
    const groups = await Promise.all([...managedGroups.keys()].map(existingGroup));
    return groups.filter(Boolean);
  }
  if (method === 'downloads.start') {
    if (typeof params.url !== 'string' || !/^(https?:|data:)/i.test(params.url)) throw new Error('Download URL must use http, https, or data');
    if (params.filename !== undefined && (typeof params.filename !== 'string' || !params.filename)) throw new Error('filename must be a non-empty path relative to the Downloads directory');
    const id = await chrome.downloads.download({ url: params.url, ...(params.filename === undefined ? {} : { filename: params.filename }), saveAs: false, conflictAction: 'uniquify' });
    return downloadInfo(id);
  }
  if (method === 'downloads.info') return downloadInfo(params.id);
  if (method === 'downloads.list') {
    const limit = params.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer between 1 and 100');
    if (params.state !== undefined && !['in_progress', 'complete', 'interrupted'].includes(params.state)) throw new Error('Unknown download state');
    return (await chrome.downloads.search({ limit, orderBy: ['-startTime'], ...(params.state === undefined ? {} : { state: params.state }) })).map(downloadMetadata);
  }
  if (method === 'tabs.list') return (await chrome.tabs.query({})).map(({ id, windowId, title, url, active, status, groupId }) => ({ id, windowId, title, url, active, status, groupId, managed: [...managedGroups.values()].some(group => group.id === groupId) }));
  if (method === 'tabs.create') {
    const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: params.active ?? true });
    await manageTab(tab.id);
    return chrome.tabs.get(tab.id);
  }
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw new Error('tabId must be an integer');
  if (method === 'tabs.close') { await chrome.tabs.remove(tabId); return { closed: true }; }
  if (method === 'groups.manage') return manageTab(tabId, params);
  if (method === 'groups.release') {
    const tab = await chrome.tabs.get(tabId);
    const group = await existingGroup(tab.windowId);
    if (!group || tab.groupId !== group.id) return { tabId, released: false };
    await chrome.tabs.ungroup([tabId]);
    if (attached.has(tabId)) { await chrome.debugger.detach({ tabId }); attached.delete(tabId); }
    return { tabId, released: true };
  }
  if (method === 'tabs.navigate') {
    await manageTab(tabId);
    return chrome.tabs.update(tabId, { url: params.url });
  }
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
      renameManagedGroups().catch(() => {});
      return;
    }
    if (message.type === 'browser') {
      browser = { ...browser, ...message.browser };
      renameManagedGroups().catch(() => {});
      return;
    }
    if (message.type === 'pong') return;
    if (!enabled || !message.id || typeof message.method !== 'string') return;
    const requestedGeneration = generation;
    try {
      const execute = () => {
        if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
        activeGeneration = requestedGeneration;
        return message.method === 'downloads.wait'
          ? waitForDownload(message.params || {}, requestedGeneration)
          : dispatch(message.method, message.params);
      };
      // Waiting for a transfer must not prevent an agent from continuing page actions.
      const work = message.method === 'downloads.wait' ? execute() : commandQueue.then(execute);
      if (message.method !== 'downloads.wait') commandQueue = work.catch(() => {});
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
chrome.tabGroups.onRemoved.addListener(group => {
  for (const [windowId, known] of managedGroups) if (known.id === group.id) managedGroups.delete(windowId);
  saveGroups().catch(() => {});
});
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
