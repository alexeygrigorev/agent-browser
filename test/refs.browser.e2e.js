// Disposable headless browser: node test/refs.browser.e2e.js.
// Exercise the actual page-side functions, not a mock DOM or the user's browser.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const extract = (name, end) => source.slice(source.indexOf(`function ${name}(`), source.indexOf(end, source.indexOf(`function ${name}(`)));
const functions = {
  snapshot: extract('snapshot', 'function targetAction('),
  targetAction: extract('targetAction', '// Atomic click support.'),
  clickStep: extract('clickStep', '// Pointer position and held buttons per tab,')
};
const browser = await chromium.launch({ headless: true, ...(process.env.AGENT_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.AGENT_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage();
  const cdp = await page.context().newCDPSession(page);
  const call = (name, params) => page.evaluate(`(${functions[name]})(${JSON.stringify(params)})`);
  await page.setContent('<title>References</title><p>Verification code: 13. Useful noninteractive context.</p><input id="name" placeholder="Your name"><button id="save" onclick="window.saved = (window.saved || 0) + 1">Save</button><button hidden>Hidden</button>');
  const legacy = await call('snapshot', {});
  assert.match(legacy.text, /Verification code: 13/);
  assert.equal(legacy.elements[0].selector, '#name');
  assert.equal(legacy.elements[0].ref, undefined);
  const first = await call('snapshot', { refs: true, refStart: 1 });
  assert.equal(first.title, 'References');
  assert.equal(first.url, 'about:blank');
  assert.deepEqual(first.elements.map(element => element.ref), ['e1', 'e2']);
  assert.equal(first.elements[0].selector, undefined);
  assert.match(first.text, /Verification code: 13/);
  assert.equal(first.elements[0].text, 'Your name');
  assert.equal(first.elements[1].text, 'Save');
  await call('targetAction', { ref: 'e1', action: 'type' });
  await cdp.send('Input.insertText', { text: 'Alexey' });
  assert.equal(await page.locator('#name').inputValue(), 'Alexey');
  await call('targetAction', { ref: 'e1', action: 'type', clear: false });
  await cdp.send('Input.insertText', { text: '!' });
  assert.equal(await page.locator('#name').inputValue(), 'Alexey!');
  const armed = await call('clickStep', { ref: 'e2', action: 'arm' });
  assert.equal((await call('clickStep', { ref: 'e2', action: 'confirm' })).ok, true);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: armed.x, y: armed.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: armed.x, y: armed.y, button: 'left', clickCount: 1 });
  assert.equal((await call('clickStep', { ref: 'e2', action: 'landing' })).landed, true);
  assert.equal(await page.evaluate('window.saved'), 1);

  // A row inserted ahead of the target must not change the original reference.
  await page.evaluate(() => document.body.insertAdjacentHTML('afterbegin', '<button id="other">Other</button>'));
  await call('clickStep', { ref: 'e2', action: 'synthetic' });
  assert.equal(await page.evaluate('window.saved'), 2);
  // Replacing a node with an identical selector must fail instead of selecting it.
  await page.evaluate(() => { const node = document.querySelector('#save'); node.replaceWith(node.cloneNode(true)); });
  await assert.rejects(call('clickStep', { ref: 'e2', action: 'arm' }), /Stale or unknown element reference e2/);
  await page.evaluate(() => { const node = document.querySelector('#name'); node.replaceWith(node.cloneNode(true)); });
  await assert.rejects(call('targetAction', { ref: 'e1', action: 'type' }), /Stale or unknown/);
  assert.equal(await page.locator('#name').inputValue(), 'Alexey!');

  const second = await call('snapshot', { refs: true, refStart: 501 });
  await assert.rejects(call('clickStep', { ref: 'e2', action: 'arm' }), /Stale or unknown/);
  const inputRef = second.elements.find(element => element.tag === 'input').ref;
  await page.evaluate(() => { location.hash = 'changed-route'; });
  await assert.rejects(call('targetAction', { ref: inputRef, action: 'type' }), /Stale or unknown/);
  await page.evaluate(() => { location.hash = ''; });
  await assert.rejects(call('targetAction', { ref: inputRef, action: 'type' }), /Stale or unknown/);
  await page.goto('data:text/html,<button>New document</button>');
  await assert.rejects(call('clickStep', { ref: 'e501', action: 'arm' }), /Stale or unknown/);
  const other = await browser.newPage();
  await other.setContent('<button>Different tab</button>');
  await assert.rejects(other.evaluate(`(${functions.clickStep})(${JSON.stringify({ ref: 'e501', action: 'arm' })})`), /Stale or unknown/);
  console.log('Reference snapshots, real click/type input, stale DOM targets, navigation, and tab isolation passed.');
} finally {
  await browser.close();
}
