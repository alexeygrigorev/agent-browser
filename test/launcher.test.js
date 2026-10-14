import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { createClient } from '../src/client.js';
import { launchBridge } from '../src/launcher.js';

test('an absent bridge launches once in a detached process and accepts a browser connection', async t => {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  let launches = 0, browser, pid;
  t.after(async () => {
    browser?.terminate();
    if (pid) { try { process.kill(pid); } catch {} }
  });
  const client = createClient({ port, autoStart: true, connectTimeout: 5000, launcher: async value => { launches++; pid = await launchBridge(value); } });
  await assert.rejects(client.status(), /Cannot reach browser bridge/);
  assert.equal(launches, 0, 'status must never start a missing bridge');
  const command = client.call('tabs.list');
  let status;
  for (let i = 0; i < 50; i++) {
    try { status = await client.status(); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.ok(status, 'detached bridge became available');
  browser = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: `chrome-extension://${'a'.repeat(32)}` });
  browser.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.method) browser.send(JSON.stringify({ id: message.id, result: [{ id: 42 }] }));
  });
  await new Promise((resolve, reject) => { browser.once('open', () => { browser.send(JSON.stringify({ type: 'hello', protocol: 1 })); resolve(); }); browser.once('error', reject); });
  assert.deepEqual(await command, [{ id: 42 }]);
  assert.equal(launches, 1);
  assert.ok(pid, 'launcher returns PID for controlled cleanup');

  // A racing launch exits successfully rather than leaving a second bridge.
  const racer = spawn(process.execPath, [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'serve'], { env: { ...process.env, AGENT_BROWSER_PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
  assert.equal(await new Promise(resolve => racer.once('exit', resolve)), 0);
});
