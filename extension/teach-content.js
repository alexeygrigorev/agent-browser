// Teach recording: injected into every frame while a teach session is active.
// It only reports what the person does; it never changes the page.
(() => {
  if (globalThis.__agentBrowserTeach) return;
  const listeners = [];
  const pendingTyping = new Map();
  const on = (type, handler) => { window.addEventListener(type, handler, true); listeners.push([type, handler]); };
  const clip = (text, length = 200) => (text || '').replace(/\s+/g, ' ').trim().slice(0, length);

  function stop() {
    for (const [type, handler] of listeners) window.removeEventListener(type, handler, true);
    listeners.length = 0;
    for (const entry of pendingTyping.values()) clearTimeout(entry.timer);
    pendingTyping.clear();
    delete globalThis.__agentBrowserTeach;
  }
  function send(event) {
    try {
      const sent = chrome.runtime.sendMessage({ type: 'teach-event', event: { ...event, frameUrl: location.href, isTopFrame: window === window.top } });
      sent?.catch?.(() => {});
    } catch { stop(); } // The extension was reloaded; this copy is orphaned.
  }

  function selector(element) {
    if (element.id) return '#' + CSS.escape(element.id);
    const path = [];
    while (element && element.parentElement && element !== document.documentElement) {
      if (element.id) { path.unshift('#' + CSS.escape(element.id)); return path.join(' > '); }
      const tag = element.localName;
      const siblings = [...element.parentElement.children].filter(item => item.localName === tag);
      path.unshift(tag + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(element) + 1})` : ''));
      element = element.parentElement;
    }
    return path.length ? path.join(' > ') : element?.localName || '';
  }
  function role(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.localName;
    if (tag === 'a') return element.hasAttribute('href') ? 'link' : null;
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      return { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', range: 'slider', number: 'spinbutton' }[type] || 'textbox';
    }
    return { button: 'button', select: element.multiple ? 'listbox' : 'combobox', textarea: 'textbox', img: 'img', option: 'option', summary: 'button',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'listitem', tr: 'row', td: 'cell', th: 'columnheader',
      nav: 'navigation', form: 'form', dialog: 'dialog', table: 'table' }[tag] || null;
  }
  function accessibleName(element) {
    const label = element.getAttribute('aria-label');
    if (label) return clip(label, 150);
    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || '').join(' ');
      if (clip(text)) return clip(text, 150);
    }
    if (element.localName === 'form') return clip(element.getAttribute('name') || element.id, 150);
    if (element.labels?.length) return clip([...element.labels].map(item => item.innerText).join(' '), 150);
    if (element.localName === 'img') return clip(element.getAttribute('alt'), 150);
    if (element.localName === 'input' && ['button', 'submit', 'reset'].includes(element.type)) return clip(element.value, 150);
    if (['input', 'textarea', 'select'].includes(element.localName)) return clip(element.getAttribute('placeholder') || element.getAttribute('title') || element.getAttribute('name'), 150);
    return clip(element.innerText || element.textContent || element.getAttribute('title'), 150);
  }
  function describe(element) {
    const rect = element.getBoundingClientRect();
    const info = { tag: element.localName, role: role(element), name: accessibleName(element), selector: selector(element),
      bbox: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
    for (const [key, attribute] of [['id', 'id'], ['nameAttr', 'name'], ['type', 'type'], ['href', 'href'], ['placeholder', 'placeholder']]) {
      const value = attribute === 'href' ? element.href : element.getAttribute(attribute);
      if (value) info[key] = String(value).slice(0, 500);
    }
    const text = clip(element.innerText, 200);
    if (text && text !== info.name) info.text = text;
    return info;
  }
  const interactive = 'a,button,input,select,textarea,label,summary,option,[role],[onclick],[contenteditable="true"],[tabindex]';
  const elementFrom = event => {
    const target = event.composedPath?.()[0] || event.target;
    return target instanceof Element ? target : target?.parentElement;
  };
  const isPassword = element => element.localName === 'input' && element.type === 'password';
  const valueOf = element => {
    if (isPassword(element)) return '[password not recorded]';
    if (element.isContentEditable) return clip(element.innerText, 500);
    if (element.localName === 'select') return clip([...element.selectedOptions].map(option => option.text).join(', '), 500);
    if (['checkbox', 'radio'].includes(element.type)) return element.checked ? 'checked' : 'unchecked';
    return String(element.value ?? '').slice(0, 500);
  };

  function flushTyping(element) {
    const entry = pendingTyping.get(element);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingTyping.delete(element);
    send({ kind: 'type', ts: entry.ts, endTs: entry.endTs, element: describe(element), value: valueOf(element) });
  }
  const flushAll = () => { for (const element of [...pendingTyping.keys()]) flushTyping(element); };
  const textLike = element => element.isContentEditable || element.localName === 'textarea' ||
    (element.localName === 'input' && !['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'range', 'color'].includes(element.type));

  on('click', event => {
    const raw = elementFrom(event);
    if (!raw) return;
    flushAll();
    const element = raw.closest(interactive) || raw;
    send({ kind: 'click', ts: Date.now(), button: event.button, x: Math.round(event.clientX), y: Math.round(event.clientY),
      isTrusted: event.isTrusted, element: describe(element), ...(element !== raw ? { target: raw.localName } : {}) });
  });
  on('input', event => {
    const element = elementFrom(event);
    if (!element || !textLike(element)) return;
    const entry = pendingTyping.get(element) || { ts: Date.now() };
    clearTimeout(entry.timer);
    entry.endTs = Date.now();
    entry.timer = setTimeout(() => flushTyping(element), 1500);
    pendingTyping.set(element, entry);
  });
  on('change', event => {
    const element = elementFrom(event);
    if (!element) return;
    if (textLike(element)) { flushTyping(element); return; }
    send({ kind: 'change', ts: Date.now(), element: describe(element), value: element.type === 'file' ? [...element.files].map(file => file.name).join(', ') : valueOf(element) });
  });
  on('focusout', event => { const element = elementFrom(event); if (element) flushTyping(element); });
  on('submit', event => {
    flushAll();
    const form = elementFrom(event);
    send({ kind: 'submit', ts: Date.now(), element: form ? describe(form) : null, action: form?.action || null });
  });
  on('keydown', event => {
    const special = ['Enter', 'Escape', 'Tab'].includes(event.key);
    const shortcut = (event.ctrlKey || event.metaKey || event.altKey) && !['Control', 'Meta', 'Alt', 'Shift'].includes(event.key);
    if (!special && !shortcut) return;
    const element = elementFrom(event);
    if (element) flushTyping(element);
    const modifiers = ['ctrl', 'alt', 'shift', 'meta'].filter(name => event[`${name}Key`]);
    send({ kind: 'key', ts: Date.now(), key: event.key, modifiers, element: element ? describe(element) : null });
  });
  on('copy', () => send({ kind: 'copy', ts: Date.now(), text: clip(String(getSelection() || ''), 300) }));
  on('pagehide', flushAll);

  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'teach-stop') { flushAll(); stop(); } });
  globalThis.__agentBrowserTeach = true;
})();
