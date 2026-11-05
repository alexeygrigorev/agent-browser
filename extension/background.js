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
const idleTabs = new Map();
const busyTabs = new Map();
let tabIdleMinutes = 15;
const saveIdleTabs = () => chrome.storage.session.set({ idleTabs: [...idleTabs] });
async function touchIdleTab(tabId, create = false) {
  if (!Number.isInteger(tabId) || (!create && !idleTabs.has(tabId))) return;
  idleTabs.set(tabId, Date.now());
  await saveIdleTabs();
}
async function closeIdleTabs() {
  for (const [id, lastUsed] of idleTabs) {
    if (busyTabs.has(id) || Date.now() - lastUsed < tabIdleMinutes * 60000) continue;
    try {
      const tab = await chrome.tabs.get(id);
      if (!idleTabs.has(id) || busyTabs.has(id) || Date.now() - idleTabs.get(id) < tabIdleMinutes * 60000) continue;
      // Pinned tabs belong to the person; audible media is still in use.
      if (tab.pinned || tab.audible) { await touchIdleTab(id); continue; }
      await chrome.tabs.remove(id);
    } catch { /* A tab may already have been closed. */ }
    idleTabs.delete(id);
    pointers.delete(id);
  }
  await saveIdleTabs();
}
// Every source file this extension loads. The worker hashes them at startup and
// reports the hash in its hello, so the bridge can prove which code is live and
// warn when the loaded extension differs from the bridge's extension directory.
const CODE_FILES = ['manifest.json', 'background.js', 'popup.html', 'popup.js', 'popup.css', 'teach.js', 'teach-content.js'];
let code = null;
async function hashCode() {
  // Line endings are normalized so Windows (CRLF) and POSIX checkouts agree.
  const texts = await Promise.all(CODE_FILES.map(async file => (await (await fetch(chrome.runtime.getURL(file))).text()).replace(/\r\n/g, '\n')));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(CODE_FILES.map((file, index) => `${file}\0${texts[index]}`).join('\0')));
  return { sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), files: CODE_FILES };
}
const startup = chrome.storage.local.get(['enabled', 'paused', 'connectionError', 'browserId', 'tabIdleMinutes']).then(async config => {
  code = await hashCode().catch(() => null);
  browserId = config.browserId || crypto.randomUUID();
  if (!config.browserId) await chrome.storage.local.set({ browserId });
  browser = { id: browserId, connected: false };
  if (Number.isFinite(config.tabIdleMinutes) && config.tabIdleMinutes >= 1 && config.tabIdleMinutes <= 1440) tabIdleMinutes = config.tabIdleMinutes;
  const session = await chrome.storage.session.get(['managedGroups', 'idleTabs']);
  for (const group of session.managedGroups || []) if (group.ownerId === browserId) managedGroups.set(group.windowId, group);
  for (const [id, lastUsed] of session.idleTabs || []) if (Number.isInteger(id) && Number.isFinite(lastUsed)) idleTabs.set(id, lastUsed);
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
  if (action === 'point') {
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
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

// Pointer position and held buttons per tab, so hover menus and drags see one
// continuous mouse rather than isolated events.
const pointers = new Map();
const mouseButtons = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };
// A page overlay makes synthetic CDP input visible without intercepting it.
function showAgentPointer({ x, y, pressed }) {
  let host = document.querySelector('agent-browser-pointer');
  if (!host) {
    host = document.createElement('agent-browser-pointer');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host,*{pointer-events:none!important}svg{position:absolute;overflow:visible;filter:drop-shadow(0 1px 2px #0008)}circle{fill:#2563eb33;stroke:#2563eb;stroke-width:3}path{fill:#2563eb;stroke:white;stroke-width:2}</style><svg width="30" height="36" aria-hidden="true"><circle cx="0" cy="0" r="16" style="display:none"/><path d="M0 0 L0 27 L7 20 L13 33 L19 30 L13 18 L24 18 Z"/></svg>';
    document.documentElement.append(host);
  }
  const svg = host.shadowRoot.querySelector('svg');
  svg.style.left = `${x}px`; svg.style.top = `${y}px`;
  const ring = svg.querySelector('circle');
  if (pressed) {
    ring.style.display = '';
    ring.getAnimations().forEach(animation => animation.cancel());
    ring.animate([{ opacity: 1, r: '12px' }, { opacity: 0, r: '30px' }], { duration: 800, fill: 'forwards' });
  }
  return true;
}
async function point(tabId, params, action = 'point') {
  const target = params.selector ? await pageCall(tabId, targetAction, { selector: params.selector, action }) : params;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) throw new Error('Provide selector or x and y coordinates');
  return { x: target.x, y: target.y };
}
async function mouse(tabId, type, { x, y }, { button = 'left', clickCount = 1 } = {}) {
  if (type !== 'mouseMoved' && !Object.hasOwn(mouseButtons, button)) throw new Error('button must be left, right, middle, back, or forward');
  if (!Number.isInteger(clickCount) || clickCount < 1) throw new Error('clickCount must be a positive integer');
  const state = pointers.get(tabId) || { buttons: 0 };
  let buttons = state.buttons;
  if (type === 'mousePressed') buttons |= mouseButtons[button];
  if (type === 'mouseReleased') buttons &= ~mouseButtons[button];
  const held = Object.keys(mouseButtons).find(name => buttons & mouseButtons[name]);
  // Cosmetic failures must never turn a completed click into a retryable error.
  await pageCall(tabId, showAgentPointer, { x, y, pressed: type === 'mousePressed' }).catch(() => {});
  await cdp(tabId, 'Input.dispatchMouseEvent', { type, x, y, buttons, ...(type === 'mouseMoved' ? { button: held || 'none' } : { button, clickCount }) });
  pointers.set(tabId, { x, y, buttons });
  return { x, y };
}

async function dispatch(method, params = {}) {
  if (method === 'extension.info') return { version: chrome.runtime.getManifest().version, code };
  if (method === 'extension.reload') {
    // Reply first; the bridge then waits for the reloaded worker to reconnect.
    setTimeout(() => chrome.runtime.reload(), 100);
    return { reloading: true, version: chrome.runtime.getManifest().version, code };
  }
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
  if (method.startsWith('teach.')) return teachDispatch(method, params);
  if (method === 'tabs.list') return (await chrome.tabs.query({})).map(({ id, windowId, title, url, active, status, groupId, openerTabId }) => ({ id, windowId, title, url, active, status, groupId, ...(openerTabId === undefined ? {} : { openerTabId }), managed: [...managedGroups.values()].some(group => group.id === groupId) }));
  if (method === 'tabs.create') {
    const tab = await chrome.tabs.create({ url: params.url || 'about:blank', active: params.active ?? true });
    await touchIdleTab(tab.id, true);
    await manageTab(tab.id);
    return chrome.tabs.get(tab.id);
  }
  const tabId = params.tabId;
  if (!Number.isInteger(tabId)) throw new Error('tabId must be an integer');
  if (method === 'dialogs.handle') {
    if (typeof params.accept !== 'boolean') throw new Error('accept must be a boolean');
    if (params.promptText !== undefined && typeof params.promptText !== 'string') throw new Error('promptText must be a string');
    return cdp(tabId, 'Page.handleJavaScriptDialog', { accept: params.accept, ...(params.promptText === undefined ? {} : { promptText: params.promptText }) });
  }
  if (method === 'tabs.close') { await chrome.tabs.remove(tabId); pointers.delete(tabId); return { closed: true }; }
  if (method === 'groups.manage') return manageTab(tabId, params);
  if (method === 'groups.release') {
    idleTabs.delete(tabId);
    await saveIdleTabs();
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
    const target = await point(tabId, params, 'click');
    const clickCount = params.clickCount ?? 1;
    if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) throw new Error('clickCount must be 1, 2, or 3');
    await mouse(tabId, 'mouseMoved', target);
    // A real double click is two press/release pairs with an increasing count.
    for (let count = 1; count <= clickCount; count++) {
      await mouse(tabId, 'mousePressed', target, { ...params, clickCount: count });
      await mouse(tabId, 'mouseReleased', target, { ...params, clickCount: count });
    }
    return { clicked: true, ...target };
  }
  if (method === 'page.hover') return { hovered: true, ...await mouse(tabId, 'mouseMoved', await point(tabId, params)) };
  if (method === 'page.mouse') {
    const types = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' };
    if (!Object.hasOwn(types, params.action)) throw new Error('action must be move, down, or up');
    const last = pointers.get(tabId);
    const target = params.selector || params.x !== undefined || params.y !== undefined || params.action === 'move' || !last ? await point(tabId, params) : last;
    return { action: params.action, ...await mouse(tabId, types[params.action], target, params) };
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
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocol: 1, browserId, version: chrome.runtime.getManifest().version, code }));
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
      if (typeof teachFlush === 'function') teachFlush();
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
      const execute = async () => {
        if (!enabled || requestedGeneration !== generation) throw new Error('Browser access was disconnected');
        activeGeneration = requestedGeneration;
        const id = message.params?.tabId;
        if (Number.isInteger(id)) busyTabs.set(id, (busyTabs.get(id) || 0) + 1);
        try {
          await touchIdleTab(id);
          return await (message.method === 'downloads.wait'
            ? waitForDownload(message.params || {}, requestedGeneration)
            : dispatch(message.method, message.params));
        } finally {
          if ((busyTabs.get(id) || 0) > 1) busyTabs.set(id, busyTabs.get(id) - 1); else busyTabs.delete(id);
          await touchIdleTab(id);
        }
      };
      // Transfers and dialog handling must not wait behind page actions; a dialog
      // can be the reason an earlier navigation or tab close is still waiting.
      // Reloading is the way out of a stuck queue, so it never waits either.
      const bypassQueue = ['downloads.wait', 'dialogs.handle', 'extension.info', 'extension.reload'].includes(message.method);
      const work = bypassQueue ? execute() : commandQueue.then(execute);
      if (!bypassQueue) commandQueue = work.catch(() => {});
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
chrome.tabs.onRemoved.addListener(id => {
  idleTabs.delete(id); pointers.delete(id); saveIdleTabs().catch(() => {});
});
chrome.tabs.onCreated.addListener(tab => {
  // Links/popups opened by agent-owned tabs inherit their lifetime.
  if (idleTabs.has(tab.openerTabId)) touchIdleTab(tab.id, true).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => touchIdleTab(tabId).catch(() => {}));
chrome.tabGroups.onRemoved.addListener(group => {
  for (const [windowId, known] of managedGroups) if (known.id === group.id) managedGroups.delete(windowId);
  saveGroups().catch(() => {});
});
// Chrome starts the worker for these events after a reload or browser launch;
// loading the script is enough to connect.
chrome.runtime.onInstalled.addListener(() => {});
chrome.runtime.onStartup.addListener(() => {});
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.create('idle-tabs', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async ({ name }) => {
  await startup;
  if (name === 'idle-tabs') await closeIdleTabs();
  if (name === 'reconnect' && enabled && !socket) connect();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type === 'teach-event') return;
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
// Teach recording lives in its own file; the unit tests load this file alone.
if (typeof importScripts === 'function') importScripts('teach.js');
