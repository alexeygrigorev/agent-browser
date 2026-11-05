// Isolated OAuth-style popup regression. Never loads an owner's Chrome profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import { cp, mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { createBridge } from '../src/bridge.js';
import { createBrowserNames } from '../src/browser-names.js';
import { createClient } from '../src/client.js';

const root = await mkdtemp(join(tmpdir(), 'browser-popup-e2e-'));
const bridge = createBridge({ port: 0, names: createBrowserNames({ path: join(root, 'names.json') }) });
const fixture = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/authorize'
    ? '<title>Authentication popup</title><label>Code<input id="code"></label><button id="approve" onclick="document.querySelector(\'h1\').textContent=\'Approved\'">Approve</button><h1>Waiting</h1>'
    : '<title>Sign-in parent</title><button id="login" onclick="window.open(\'/authorize\',\'oauth\',\'popup=yes,width=520,height=600\')">Sign in</button>');
});
let context;
async function eventually(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check(); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out: ' + label);
}
try {
  const port = (await bridge.listen()).port;
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const extension = join(root, 'extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['background.js', 'manifest.json']) {
    const path = join(extension, name);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', `127.0.0.1:${port}`));
  }
  context = await chromium.launchPersistentContext(join(root, 'profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const client = createClient({ port });
  await eventually(async () => (await client.status()).connected, 'extension connection');
  const parent = await context.newPage();
  const parentUrl = `http://127.0.0.1:${fixture.address().port}/`;
  await parent.goto(parentUrl);
  const tab = (await client.call('tabs.list')).find(t => t.url === parentUrl);
  await client.call('page.click', { tabId: tab.id, selector: '#login' });
  const popup = await eventually(async () => (await client.call('tabs.list')).find(t => t.url === parentUrl + 'authorize'), 'popup discovery');
  assert.equal(await worker.evaluate(async id => (await chrome.windows.get(id)).type, popup.windowId), 'popup');
  assert.equal(popup.windowType, 'popup');
  assert.equal(typeof popup.windowFocused, 'boolean');
  assert.equal(popup.openerTabId, tab.id);
  assert.equal((await client.call('page.snapshot', { tabId: popup.id })).title, 'Authentication popup');
  await client.call('page.type', { tabId: popup.id, selector: '#code', text: 'synthetic-code' });
  await client.call('page.click', { tabId: popup.id, selector: '#approve' });
  assert.match((await client.call('page.snapshot', { tabId: popup.id })).text, /Approved/);
  await client.call('tabs.navigate', { tabId: popup.id, url: parentUrl + 'authorize' });
  const controlled = (await client.call('tabs.list')).find(t => t.id === popup.id);
  assert.equal(controlled.windowId, popup.windowId);
  assert.equal(controlled.windowType, 'popup');
  assert.equal(controlled.groupId, -1);
  assert.equal(controlled.managed, false);
  assert.equal((await client.call('groups.release', { tabId: popup.id })).released, true);
  await client.call('tabs.close', { tabId: popup.id });
  assert.ok(!(await client.call('tabs.list')).some(t => t.id === popup.id));
  console.log('PASS: authentication popup is discoverable, readable and interactive in its original window');
} finally {
  await context?.close(); await bridge.close();
  fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  const target = await realpath(root), base = await realpath(tmpdir());
  if (dirname(target) !== base || !basename(target).startsWith('browser-popup-e2e-')) throw new Error('Unexpected test directory');
  await rm(target, { recursive: true, force: true });
}
