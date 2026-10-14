// Explicit opt-in: npm run test:browser. Uses a disposable profile, never your Chrome profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';

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
const childEnv = { ...process.env, AGENT_BROWSER_PORT: '19333' };
delete childEnv.AGENT_BROWSER_TOKEN;
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
  const client = createClient();
  await assert.rejects(client.status(), /Cannot reach browser bridge/, 'extension starts with no bridge available');
  bridge = createBridge({ port: 19333 });
  await bridge.listen();
  await eventually(async () => (await client.status()).connected, 'automatic extension connection without opening popup');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  assert.equal(await popup.locator('input').count(), 0, 'popup requires no token input');
  await eventually(async () => (await popup.locator('#status').textContent()).includes('browser control enabled'), 'popup connected status');
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
  await bridge.close();
  bridge = createBridge({ port: 19333 });
  await bridge.listen();
  await eventually(async () => (await client.status()).connected, 'automatic connection after bridge restart without popup interaction');
  assert.ok((await textTool('tabs_list')).some(tab => tab.id === tabId), 'MCP works after bridge restart without popup interaction');
  await popup.locator('#disconnect').click();
  await eventually(async () => !(await client.status()).connected, 'extension disconnect');
  await assert.rejects(client.call('tabs.list'), /Connect the Chrome extension first/);
  await popup.locator('#connect').click();
  await eventually(async () => (await client.status()).connected, 'reconnection without credentials');
  assert.ok((await textTool('tabs_list')).some(tab => tab.id === tabId), 'MCP works after reconnecting');
  console.log('Browser E2E passed: extension before bridge, automatic reconnect after restart, actual CLI and MCP stdio, existing HttpOnly session, page actions, MCP PNG image, explicit pause and resume.');
} finally {
  await mcp?.close();
  await context?.close();
  await bridge?.close();
  await new Promise(resolve => fixture.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
