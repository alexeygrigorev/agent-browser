// Explicit opt-in: npm run test:browser. Uses a disposable profile, never your Chrome profile.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';

async function eventually(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const profile = await mkdtemp(join(tmpdir(), 'agent-browser-e2e-'));
const token = randomBytes(32).toString('hex');
const bridge = createBridge({ token, port: 19333 });
const fixture = http.createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(302, { 'Set-Cookie': 'session=e2e-authenticated; HttpOnly; SameSite=Strict; Path=/', Location: '/' });
    res.end();
    return;
  }
  if (req.url === '/private') {
    const authenticated = req.headers.cookie?.split(';').some(value => value.trim() === 'session=e2e-authenticated');
    res.writeHead(authenticated ? 200 : 401, { 'Content-Type': 'text/plain' });
    res.end(authenticated ? 'Existing browser session authenticated' : 'Unauthorized');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><title>Agent Browser E2E</title>
    <h1>Disposable browser fixture</h1>
    <label>Name <input id="name" value="replace me"></label>
    <button id="submit" onclick="document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value">Submit</button>
    <p id="result">Waiting</p>`);
});
let context;
try {
  await bridge.listen();
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  const extension = resolve('extension');
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#token').fill(token);
  await popup.locator('#connect').click();
  const client = createClient({ token });
  await eventually(async () => (await client.status()).connected, 'extension pairing');
  await eventually(async () => (await popup.locator('#status').textContent()).includes('browser control enabled'), 'popup connected status');
  if (process.env.AGENT_BROWSER_E2E_SCREENSHOT) {
    await popup.screenshot({ path: resolve(process.env.AGENT_BROWSER_E2E_SCREENSHOT) });
  }
  const page = await context.newPage();
  await page.goto(`${url}login`);
  const tabs = await client.call('tabs.list');
  const tab = tabs.find(tab => tab.url === url);
  assert.ok(tab, 'extension discovers existing fixture tab');
  const tabId = tab.id;
  assert.equal(await client.call('page.evaluate', { tabId, expression: 'fetch("/private").then(response => response.text())' }), 'Existing browser session authenticated');
  assert.equal(await client.call('page.evaluate', { tabId, expression: 'document.cookie' }), '', 'HttpOnly session is used without exposing it to page JavaScript');
  const snapshot = await client.call('page.snapshot', { tabId });
  assert.equal(snapshot.title, 'Agent Browser E2E');
  assert.ok(snapshot.elements.some(element => element.selector === '#name'));
  await client.call('page.type', { tabId, selector: '#name', text: 'Browser Agent' });
  await client.call('page.click', { tabId, selector: '#submit' });
  assert.equal(await client.call('page.evaluate', { tabId, expression: 'document.querySelector("#result").textContent' }), 'Hello Browser Agent');
  const screenshot = await client.call('page.screenshot', { tabId });
  assert.equal(Buffer.from(screenshot.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  await popup.locator('#disconnect').click();
  await eventually(async () => !(await client.status()).connected, 'extension disconnect');
  await assert.rejects(client.call('tabs.list'), /Connect the Chrome extension first/);
  console.log('Browser E2E passed: pairing, existing tab discovery, HttpOnly cookie session, snapshot, type, click, evaluate, PNG screenshot, disconnect.');
} finally {
  await context?.close();
  await bridge.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
