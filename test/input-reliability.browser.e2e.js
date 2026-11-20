// Explicit opt-in: node test/input-reliability.browser.e2e.js. Disposable Chromium profile and bridge.
// Reproduces the failure modes seen on Finom (re-rendering comboboxes) and Gmail (SPA thread deep links).
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';
import { createBrowserNames } from '../src/browser-names.js';

const port = Number(process.env.AGENT_BROWSER_TEST_PORT || 19347);
const profile = await mkdtemp(join(tmpdir(), 'agent-browser-input-'));
const page = `<!doctype html><title>Input reliability</title><body style="font:16px sans-serif">
<h3>Combobox that re-renders its list like Finom</h3>
<input id="country" role="combobox" autocomplete="off" style="width:240px">
<ul id="list" role="listbox" style="position:absolute;left:8px;top:90px;margin:0;padding:0;list-style:none;width:240px;background:#eee"></ul>
<p id="chosen">none</p><p id="keylog"></p>
<script>
const countries = ['Germany', 'Georgia', 'Ghana', 'Greece', 'Gabon'];
let shown = [], active = -1, shift = 0;
const list = document.querySelector('#list'), input = document.querySelector('#country');
// Every render replaces all rows and the list jitters vertically, so a position or node
// captured earlier points at the wrong row or at nothing.
function render() {
  list.replaceChildren(...shown.map((name, i) => Object.assign(document.createElement('li'), { id: 'opt-' + i + '-' + Math.random().toString(36).slice(2), role: 'option', textContent: name, style: 'padding:8px;' + (i === active ? 'background:#cde' : '') + (i === 1 ? 'margin-top:' + shift + 'px' : '') })));
  list.style.top = (90 + shift) + 'px';
}
function choose(name) { document.querySelector('#chosen').textContent = name; shown = []; render(); input.value = name; }
input.addEventListener('input', () => { shown = countries.filter(name => name.toLowerCase().startsWith(input.value.toLowerCase())); active = -1; render(); });
input.addEventListener('keydown', event => {
  document.querySelector('#keylog').textContent += event.key + ':' + event.isTrusted + ' ';
  if (!event.isTrusted) return; // a dispatched Enter does not select, as on Finom
  if (event.key === 'ArrowDown') { active = Math.min(active + 1, shown.length - 1); render(); event.preventDefault(); }
  if (event.key === 'Enter' && active >= 0) { choose(shown[active]); event.preventDefault(); }
});
list.addEventListener('mousedown', event => { if (event.target.role === 'option') choose(event.target.textContent); });
setInterval(() => { if (shown.length) { shift = (shift + 7) % 21; render(); } }, 40);

// A control that only reacts to untrusted clicks: real clicks never land on it.
document.body.insertAdjacentHTML('beforeend', '<button id="swallowed" style="position:absolute;left:300px;top:20px">Swallowed</button><p id="swallowed-result">untouched</p>');
for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) window.addEventListener(type, event => { if (event.target.id === 'swallowed' && event.isTrusted) event.stopImmediatePropagation(); }, true);
document.querySelector('#swallowed').addEventListener('click', event => { document.querySelector('#swallowed-result').textContent = 'synthetic click ' + event.detail; });

// A Gmail-like single page app: the thread renders asynchronously after a route change.
document.body.insertAdjacentHTML('beforeend', '<div id="app" role="main" style="position:absolute;left:8px;top:300px"></div>');
function route() {
  const app = document.querySelector('#app'), match = location.hash.match(/^#inbox\\/([A-Za-z0-9]{16,})$/);
  app.replaceChildren();
  if (match) setTimeout(() => { if (location.hash.endsWith(match[1])) app.innerHTML = '<h2 class="hP">Thread ' + match[1] + '</h2>'; }, 1200);
}
addEventListener('hashchange', route); route();
</script></body>`;
const fixture = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page); });
let context, bridge;
const results = {};
try {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const extension = join(profile, 'extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const filename of ['background.js', 'manifest.json']) {
    const path = join(extension, filename);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', `127.0.0.1:${port}`));
  }
  context = await chromium.launchPersistentContext(join(profile, 'chrome'), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  bridge = createBridge({ port, names: createBrowserNames({ path: join(profile, 'names.json') }) });
  await bridge.listen();
  const client = createClient({ port });
  for (let i = 0; i < 100 && !(await client.status().catch(() => ({}))).connected; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const tab = page => client.call('tabs.list').then(tabs => tabs.find(tab => tab.url.startsWith(page)));
  const fixturePage = await context.newPage();
  await fixturePage.goto(url);
  const { id: tabId } = await tab(url);
  const text = selector => client.call('page.evaluate', { tabId, expression: `document.querySelector(${JSON.stringify(selector)}).textContent` });

  // 1. Click re-resolved at press time against a list that re-renders every 40ms.
  for (const name of ['Germany', 'Ghana', 'Greece']) {
    await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#country").value=""; document.querySelector("#chosen").textContent="none"' });
    await client.call('page.type', { tabId, selector: '#country', text: 'G' });
    await fixturePage.waitForSelector('#list li');
    const clicked = await client.call('page.click', { tabId, selector: '#list li', match: name });
    assert.equal(await text('#chosen'), name, `selector+text click chose ${name} despite re-rendering`);
    results[`click ${name}`] = clicked;
  }

  // 1b. A stale coordinate (what page.evaluate returned earlier) lands on whatever is there now, not on a dead node.
  await client.call('page.type', { tabId, selector: '#country', text: 'G' });
  await fixturePage.waitForSelector('#list li');
  const stale = await client.call('page.evaluate', { tabId, expression: 'const r=document.querySelector("#list li").getBoundingClientRect();({x:r.x+10,y:r.y+r.height/2})' });
  await new Promise(resolve => setTimeout(resolve, 300));
  results['coordinate click'] = await client.call('page.click', { tabId, ...stale });
  assert.notEqual(await text('#chosen'), 'none');

  // 3. Keyboard: real typing, ArrowDown and Enter select an option that dispatched events cannot.
  await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#country").value=""; document.querySelector("#chosen").textContent="none"; document.querySelector("#keylog").textContent=""' });
  await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#country").focus()' });
  await client.call('page.type', { tabId, text: 'Ge', keys: true });
  await fixturePage.waitForSelector('#list li');
  await client.call('page.key', { tabId, key: 'ArrowDown', count: 2 });
  await client.call('page.key', { tabId, key: 'Enter' });
  assert.equal(await text('#chosen'), 'Georgia', 'real ArrowDown x2 + Enter selects the second option');
  assert.match(await text('#keylog'), /G:true e:true ArrowDown:true ArrowDown:true Enter:true/);
  await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#country").value=""; document.querySelector("#chosen").textContent="none"; document.querySelector("#country").dispatchEvent(new InputEvent("input")); document.querySelector("#country").value="Ge"; document.querySelector("#country").dispatchEvent(new InputEvent("input")); document.querySelector("#country").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true})); document.querySelector("#country").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))' });
  assert.equal(await text('#chosen'), 'none', 'control: dispatched events do not select (the reported symptom)');

  // 2. A real click that never lands falls back to a synthetic MouseEvent sequence.
  const swallowed = await client.call('page.click', { tabId, selector: '#swallowed' });
  assert.equal(swallowed.method, 'synthetic');
  assert.equal(await text('#swallowed-result'), 'synthetic click 1');
  results['swallowed click'] = swallowed;
  await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#swallowed-result").textContent="untouched"' });
  await assert.rejects(client.call('page.click', { tabId, selector: '#swallowed', mode: 'real' }), /no mouse events/);
  assert.equal(await text('#swallowed-result'), 'untouched');

  // 5. Deep link to a thread that renders asynchronously: navigate returns only once it exists.
  const started = Date.now();
  const nav = await client.call('tabs.navigate', { tabId, url: `${url}#inbox/FMfcgzQjgzprVDklJWDVxzdxzjGgmVKr`, waitFor: 'h2.hP' });
  assert.equal(nav.settled, true);
  assert.ok(Date.now() - started >= 1000, 'navigate waited for the async render');
  assert.equal(await text('h2.hP'), 'Thread FMfcgzQjgzprVDklJWDVxzdxzjGgmVKr');
  results.navigate = nav;

  const shot = await client.call('page.screenshot', { tabId });
  assert.ok((shot.data || shot.dataUrl).length > 1000);
  console.log(JSON.stringify(results, null, 2));
  console.log('input reliability e2e passed');
} finally {
  await context?.close();
  await bridge?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
