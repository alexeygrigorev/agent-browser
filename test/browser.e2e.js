// Explicit opt-in: npm run test:browser. Uses a disposable profile, never your Chrome profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';
import { createBrowserNames } from '../src/browser-names.js';

async function eventually(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      // Readiness probes are GETs: restarting the bridge can invalidate a pooled
      // socket. Retry only these transport failures, never assertions or HTTP errors.
      let cause = error;
      let transient = false;
      while (cause) {
        if (['UND_ERR_SOCKET', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED'].includes(cause.code)) {
          transient = true;
          break;
        }
        cause = cause.cause;
      }
      if (!transient) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const profile = await mkdtemp(join(tmpdir(), 'agent-browser-e2e-'));
const profile2 = await mkdtemp(join(tmpdir(), 'agent-browser-e2e-orin-'));
const names = () => createBrowserNames({ path: join(profile, 'browser-names.json') });
const childEnv = { ...process.env, AGENT_BROWSER_PORT: '19333' };
delete childEnv.AGENT_BROWSER_TOKEN;
delete childEnv.AGENT_BROWSER_NAME;
const qualifiedStatus = async browser => (await fetch(`http://127.0.0.1:19333/status?browser=${encodeURIComponent(browser)}`)).json();
async function cli(args, input) {
  const child = spawn(process.execPath, [resolve('bin/cli.js'), ...args], {
    env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const timeout = setTimeout(() => child.kill(), 45000);
  child.stdin.end(input);
  try {
    const [code] = await once(child, 'close');
    assert.equal(code, 0, `CLI ${args.join(' ')} failed: ${stderr}`);
    return JSON.parse(stdout);
  } finally { clearTimeout(timeout); }
}
let bridge;
const fixture = http.createServer((req, res) => {
  if (req.url.startsWith('/login')) {
    const session = req.url.includes('profile=orin') ? 'e2e-orin' : 'e2e-authenticated';
    res.writeHead(302, { 'Set-Cookie': `session=${session}; HttpOnly; SameSite=Strict; Path=/`, Location: '/' });
    res.end();
    return;
  }
  if (req.url === '/private') {
    const authenticated = req.headers.cookie?.split(';').some(value => value.trim() === 'session=e2e-authenticated');
    const orin = req.headers.cookie?.split(';').some(value => value.trim() === 'session=e2e-orin');
    res.writeHead(authenticated || orin ? 200 : 401, { 'Content-Type': 'text/plain' });
    res.end(authenticated ? 'Existing browser session authenticated' : orin ? 'Orin browser session authenticated' : 'Unauthorized');
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
let context2;
let mcp;
try {
  // Refuse to touch a bridge owned by another process or personal Chrome session.
  await assert.rejects(createClient().status(), error => error.cause?.cause?.code === 'ECONNREFUSED', 'Stop the existing bridge before running this isolated test');
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
  let client = createClient();
  await assert.rejects(client.status(), /Cannot reach browser bridge/, 'extension starts with no bridge available');
  bridge = createBridge({ port: 19333, names: names() });
  await bridge.listen();
  await eventually(async () => (await client.status()).connected, 'automatic extension connection without opening popup');
  const mainIdentity = await client.call('browser.info');
  await client.call('browser.rename', { name: 'main' }, { browser: mainIdentity.id });
  client = createClient({ browser: 'main' });
  childEnv.AGENT_BROWSER_NAME = 'main';
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(await popup.locator('input').count(), 0, 'popup requires no token input');
  await eventually(async () => (await popup.locator('#status').textContent()).includes('browser control enabled'), 'popup connected status');
  await eventually(async () => (await popup.locator('#browser-name').textContent()).includes('main'), 'popup browser nickname');
  if (process.env.AGENT_BROWSER_E2E_SCREENSHOT) {
    await popup.screenshot({ path: resolve(process.env.AGENT_BROWSER_E2E_SCREENSHOT) });
  }
  const page = await context.newPage();
  await page.goto(`${url}login`);
  assert.deepEqual(await cli(['status']), { connected: true });
  const cliTabs = await cli(['call', 'tabs.list', '{}']);
  assert.ok(cliTabs.some(tab => tab.url === url), 'actual CLI discovers the signed-in fixture tab');
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
  const screenshotPath = join(profile, 'main-screenshot.png');
  assert.equal((await cli(['screenshot', String(tabId), '--output', screenshotPath])).format, 'png');
  assert.equal((await readFile(screenshotPath)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const cliSnapshot = await cli(['call', 'page.snapshot', '--stdin'], JSON.stringify({ tabId }));
  assert.equal(cliSnapshot.title, 'Agent Browser E2E', 'CLI stdin reaches the real extension');
  mcp = new Client({ name: 'browser-e2e', version: '1.0.0' });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath, args: [resolve('bin/cli.js'), 'mcp'], env: childEnv, stderr: 'pipe',
  }));
  const definitions = await mcp.listTools();
  for (const name of ['tabs_list', 'page_snapshot', 'page_type', 'page_click', 'page_evaluate', 'page_screenshot']) {
    assert.ok(definitions.tools.some(tool => tool.name === name), `MCP advertises ${name}`);
  }
  async function tool(name, args = {}) {
    const result = await mcp.callTool({ name, arguments: args });
    assert.ok(!result.isError, `MCP ${name} failed: ${JSON.stringify(result.content)}`);
    return result.content;
  }
  async function textTool(name, args) {
    const content = await tool(name, args);
    assert.equal(content[0].type, 'text');
    return JSON.parse(content[0].text);
  }
  assert.ok((await textTool('tabs_list')).some(tab => tab.id === tabId));
  assert.equal((await textTool('page_snapshot', { tabId })).title, 'Agent Browser E2E');
  assert.equal(await textTool('page_evaluate', { tabId, expression: 'fetch("/private").then(response => response.text())' }), 'Existing browser session authenticated', 'MCP reuses the existing HttpOnly cookie session');
  await textTool('page_type', { tabId, selector: '#name', text: 'MCP Agent café "quoted"' });
  await textTool('page_click', { tabId, selector: '#submit' });
  assert.equal(await textTool('page_evaluate', { tabId, expression: 'document.querySelector("#result").textContent' }), 'Hello MCP Agent café "quoted"');
  const mcpScreenshot = (await tool('page_screenshot', { tabId }))[0];
  assert.equal(mcpScreenshot.type, 'image');
  assert.equal(mcpScreenshot.mimeType, 'image/png');
  assert.equal(Buffer.from(mcpScreenshot.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');

  // Two disposable Chrome profiles load the same extension, but retain independent IDs and cookies.
  context2 = await chromium.launchPersistentContext(profile2, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker2 = context2.serviceWorkers()[0] || await context2.waitForEvent('serviceworker');
  assert.equal(new URL(worker2.url()).host, extensionId, 'same extension installed in both profiles');
  await eventually(async () => (await client.call('browsers.list')).filter(browser => browser.connected).length === 2, 'second profile automatically connects');
  const identities = await client.call('browsers.list');
  const orinIdentity = identities.find(browser => browser.connected && browser.id !== mainIdentity.id);
  assert.ok(orinIdentity?.id, 'profiles have independent installation UUIDs');
  await cli(['--browser', orinIdentity.id, 'browser', 'name', 'orin']);
  const orinClient = createClient({ browser: 'orin' });
  assert.equal((await cli(['--browser', 'main', 'browser'])).id, mainIdentity.id);
  assert.equal((await cli(['--browser', 'orin', 'browser'])).id, orinIdentity.id);
  const orinPage = await context2.newPage();
  await orinPage.goto(`${url}login?profile=orin`);
  const orinTab = (await orinClient.call('tabs.list')).find(tab => tab.url === url);
  assert.ok(orinTab, 'second profile fixture tab discovered by nickname');
  const privateExpression = 'fetch("/private").then(response => response.text())';
  assert.equal(await textTool('page_evaluate', { browser: 'orin', tabId: orinTab.id, expression: privateExpression }), 'Orin browser session authenticated');
  assert.equal(await textTool('page_evaluate', { browser: 'main', tabId, expression: privateExpression }), 'Existing browser session authenticated', 'profiles do not share login cookies');
  assert.equal(await cli(['--browser', 'orin', 'call', 'page.evaluate', '--stdin'], JSON.stringify({ tabId: orinTab.id, expression: privateExpression })), 'Orin browser session authenticated');
  await textTool('page_type', { browser: 'orin', tabId: orinTab.id, selector: '#name', text: 'Orin Agent' });
  await textTool('page_click', { browser: 'orin', tabId: orinTab.id, selector: '#submit' });
  assert.equal(await textTool('page_evaluate', { browser: 'orin', tabId: orinTab.id, expression: 'document.querySelector("#result").textContent' }), 'Hello Orin Agent');
  assert.equal(await textTool('page_evaluate', { browser: 'main', tabId, expression: 'document.querySelector("#result").textContent' }), 'Hello MCP Agent café "quoted"', 'actions route to only the selected profile');
  const orinScreenshot = (await tool('page_screenshot', { browser: 'orin', tabId: orinTab.id }))[0];
  assert.equal(orinScreenshot.type, 'image');
  assert.equal(Buffer.from(orinScreenshot.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const video = await cli(['record', 'start', String(tabId), '--output', join(profile, 'main-video.webm')]);
  await new Promise(resolve => setTimeout(resolve, 650));
  const recorded = await cli(['record', 'stop', video.id]);
  assert.ok(recorded.frames >= 3, `Expected at least three video frames, got ${recorded.frames}`);
  assert.ok(recorded.bytes > 100);
  execFileSync(process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg', ['-v', 'error', '-xerror', '-i', recorded.path, '-f', 'null', '-'], { windowsHide: true, timeout: 15000 });

  await bridge.close();
  bridge = createBridge({ port: 19333, names: names() });
  await bridge.listen();
  await eventually(async () => (await qualifiedStatus('main')).connected && (await qualifiedStatus('orin')).connected, 'both named profiles reconnect after bridge restart without popup interaction');
  assert.ok((await textTool('tabs_list')).some(tab => tab.id === tabId), 'MCP works after bridge restart without popup interaction');
  await popup.locator('#disconnect').click();
  await eventually(async () => !(await qualifiedStatus('main')).connected, 'main extension pause');
  assert.equal((await qualifiedStatus('orin')).connected, true, 'pausing main keeps orin connected');
  await assert.rejects(client.call('tabs.list'), /Browser is not connected: main/);
  assert.equal(await textTool('page_evaluate', { browser: 'orin', tabId: orinTab.id, expression: privateExpression }), 'Orin browser session authenticated');
  await popup.locator('#connect').click();
  await eventually(async () => (await qualifiedStatus('main')).connected, 'main resume without credentials');
  assert.ok((await textTool('tabs_list')).some(tab => tab.id === tabId), 'MCP works after reconnecting');
  console.log('Browser E2E passed: two profiles with persistent main/orin nicknames, automatic reconnect, isolated HttpOnly sessions, CLI/MCP routing, PNG screenshots, decodable WebM recording, independent pause/resume.');
} finally {
  await mcp?.close();
  await context?.close();
  await context2?.close();
  await bridge?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true });
  await rm(profile2, { recursive: true, force: true });
}
