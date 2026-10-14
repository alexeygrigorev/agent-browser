// Exercise only a tab created by this script in an already connected Chrome.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createClient } from '../src/client.js';

const client = createClient();
const marker = `Agent Browser Smoke ${randomUUID()}`;
const fixture = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><title>${marker}${req.url === '/next' ? ' Next' : ''}</title>
    <style>body{font:20px sans-serif;margin:40px;min-height:2400px}input,button{font:inherit}</style>
    <h1>Temporary browser smoke test</h1><label>Name <input id="name" value="replace me"></label>
    <button id="submit" onclick="document.querySelector('#result').textContent='Hello '+document.querySelector('#name').value">Submit</button>
    <p id="result">Waiting</p><p id="key">No key</p>
    <script>document.addEventListener('keydown',event=>{document.querySelector('#key').textContent=event.key})</script>`);
});
let tabId;
async function waitForTitle(title) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const tabs = await client.call('tabs.list');
    if (tabs.some(tab => tab.id === tabId && tab.title === title && tab.status === 'complete')) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Temporary fixture page did not finish loading');
}
async function waitForValue(expression, expected) {
  const deadline = Date.now() + 5000;
  let value;
  while (Date.now() < deadline) {
    value = await client.call('page.evaluate', { tabId, expression });
    if (value === expected) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(value, expected);
}
try {
  assert.equal((await client.status()).connected, true, 'Connect the Chrome extension first');
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const url = `http://127.0.0.1:${fixture.address().port}`;
  const tab = await client.call('tabs.create', { url: `${url}/`, active: true });
  assert.ok(Number.isInteger(tab.id), 'Chrome must return the newly created tab ID');
  tabId = tab.id;
  await waitForTitle(marker);
  const snapshot = await client.call('page.snapshot', { tabId });
  assert.equal(snapshot.title, marker);
  assert.ok(snapshot.elements.some(element => element.selector === '#name'));
  const text = 'Browser café "quoted"';
  await client.call('page.type', { tabId, selector: '#name', text });
  await client.call('page.click', { tabId, selector: '#submit' });
  await waitForValue('document.querySelector("#result").textContent', `Hello ${text}`);
  await client.call('page.key', { tabId, key: 'Escape' });
  await waitForValue('document.querySelector("#key").textContent', 'Escape');
  await client.call('page.scroll', { tabId, y: 600 });
  assert.ok(await client.call('page.evaluate', { tabId, expression: 'scrollY > 0' }));
  const image = await client.call('page.screenshot', { tabId, fullPage: true });
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.readUInt32BE(20) >= 2400, 'Full-page screenshot includes the long fixture');
  const evaluated = await client.call('cdp.send', { tabId, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } });
  assert.equal(evaluated.result.value, marker);
  await client.call('tabs.navigate', { tabId, url: `${url}/next` });
  await waitForTitle(`${marker} Next`);
  console.log('Connected Chrome smoke passed: temporary tab, snapshot, Unicode typing, click, evaluate, key, scroll, full-page PNG, CDP, navigation.');
} finally {
  try {
    if (tabId !== undefined) await client.call('tabs.close', { tabId });
  } finally {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
}
