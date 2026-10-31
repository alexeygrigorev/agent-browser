// Teach recording, loaded by background.js. While a session is active it logs
// what the person does in every tab and window and streams it to the bridge,
// which owns the bundle on disk. Nothing here drives or alters pages.
const teach = { session: null, queue: [], windows: new Map() };
const TEACH_SCRIPT = 'agent-browser-teach';
const teachLoaded = chrome.storage.session.get('teach').then(value => { teach.session = value.teach || null; });

function teachSend(message) {
  if (socket?.readyState === WebSocket.OPEN && browser?.connected) socket.send(JSON.stringify(message));
  else if (teach.queue.length < 2000) teach.queue.push(message);
}
function teachFlush() {
  while (teach.queue.length && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(teach.queue.shift()));
}

// captureVisibleTab allows two calls per second; one chain per window keeps
// captures spaced and drops shots that would only pile up behind a burst.
function teachCapture(windowId) {
  const state = teach.windows.get(windowId) || { chain: Promise.resolve(), last: 0, waiting: 0 };
  teach.windows.set(windowId, state);
  if (state.waiting >= 2) return Promise.resolve(null);
  state.waiting++;
  const shot = state.chain.then(async () => {
    const wait = state.last + 600 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    state.last = Date.now();
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 });
    return dataUrl.split(',')[1];
  }).catch(() => null).finally(() => { state.waiting--; });
  state.chain = shot;
  return shot;
}

async function teachRecord(event, { tabId, screenshot = false } = {}) {
  await teachLoaded;
  const session = teach.session;
  if (!session) return;
  event = { ts: Date.now(), ...event };
  let tab;
  if (Number.isInteger(tabId) && tabId >= 0) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
    event.tabId = tabId;
    if (tab) Object.assign(event, { windowId: tab.windowId, url: event.url ?? tab.url, title: tab.title });
  }
  const message = { type: 'teach-event', sessionId: session.id, event };
  if (screenshot && tab?.active) {
    const data = await teachCapture(tab.windowId);
    if (data) message.screenshot = data;
  }
  teachSend(message);
}

async function teachStart({ sessionId, t0 } = {}) {
  if (typeof sessionId !== 'string' || !sessionId || !Number.isFinite(t0)) throw new Error('sessionId and t0 are required');
  await teachLoaded;
  teach.session = { id: sessionId, t0 };
  await chrome.storage.session.set({ teach: teach.session });
  await chrome.scripting.unregisterContentScripts({ ids: [TEACH_SCRIPT] }).catch(() => {});
  await chrome.scripting.registerContentScripts([{ id: TEACH_SCRIPT, js: ['teach-content.js'], matches: ['<all_urls>'],
    allFrames: true, runAt: 'document_start', persistAcrossSessions: false }]);
  const tabs = await chrome.tabs.query({});
  // Pages that are already open need the logger now; new ones get it on load.
  await Promise.allSettled(tabs.filter(tab => /^(https?|file):/.test(tab.url || '')).map(tab =>
    chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['teach-content.js'] })));
  const summary = tabs.map(({ id, windowId, url, title, active }) => ({ tabId: id, windowId, url, title, active }));
  const active = tabs.find(tab => tab.active && tab.highlighted !== false) || tabs.find(tab => tab.active);
  if (active) teachRecord({ kind: 'session_screenshot' }, { tabId: active.id, screenshot: true });
  return { sessionId, tabs: summary };
}

async function teachStop({ sessionId } = {}) {
  await teachLoaded;
  const session = teach.session;
  if (sessionId && session && session.id !== sessionId) throw new Error(`Another teach session is active: ${session.id}`);
  teach.session = null;
  await chrome.storage.session.remove('teach');
  await chrome.scripting.unregisterContentScripts({ ids: [TEACH_SCRIPT] }).catch(() => {});
  for (const tab of await chrome.tabs.query({})) chrome.tabs.sendMessage(tab.id, { type: 'teach-stop' }).catch(() => {});
  teachFlush();
  return { stopped: !!session, sessionId: session?.id || null };
}

async function teachDispatch(method, params = {}) {
  if (method === 'teach.start') return teachStart(params);
  if (method === 'teach.stop') return teachStop(params);
  if (method === 'teach.status') { await teachLoaded; return { session: teach.session, queued: teach.queue.length }; }
  throw new Error(`Unknown method: ${method}`);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'teach-event' || sender.id !== chrome.runtime.id || !sender.tab) return;
  const event = { ...message.event, frameId: sender.frameId };
  if (sender.frameId === 0) delete event.frameUrl;
  teachRecord(event, { tabId: sender.tab.id, screenshot: ['click', 'submit'].includes(event.kind) || (event.kind === 'key' && event.key === 'Enter') });
});
chrome.tabs.onCreated.addListener(tab => teachRecord({ kind: 'tab_opened', openerTabId: tab.openerTabId ?? null, url: tab.pendingUrl || tab.url }, { tabId: tab.id }));
chrome.tabs.onRemoved.addListener((tabId, info) => teachRecord({ kind: 'tab_closed', tabId, windowId: info.windowId, windowClosing: info.isWindowClosing }));
chrome.tabs.onActivated.addListener(({ tabId }) => teachRecord({ kind: 'tab_activated' }, { tabId, screenshot: true }));
chrome.windows.onCreated.addListener(window => teachRecord({ kind: 'window_opened', windowId: window.id, windowType: window.type }));
chrome.windows.onRemoved.addListener(windowId => teachRecord({ kind: 'window_closed', windowId }));
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  teachRecord({ kind: 'navigation', url: details.url, transition: details.transitionType, qualifiers: details.transitionQualifiers }, { tabId: details.tabId });
});
chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
  if (details.frameId !== 0) return;
  teachRecord({ kind: 'navigation', url: details.url, transition: 'history', qualifiers: details.transitionQualifiers }, { tabId: details.tabId, screenshot: true });
});
chrome.webNavigation.onCompleted.addListener(details => {
  if (details.frameId !== 0) return;
  teachRecord({ kind: 'page_loaded', url: details.url }, { tabId: details.tabId, screenshot: true });
});
