// Real Windows foreground events, disposable Chromium data only. No personal profile,
// raw CDP, remote endpoint, token, pairing, or live desktop connection is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createBridge } from '../src/bridge.js';
import { createBrowserNames } from '../src/browser-names.js';
import { createClient } from '../src/client.js';

assert.equal(process.platform, 'win32', 'Run on a Windows interactive CI desktop');
const root = await mkdtemp(join(tmpdir(), 'agent-browser-background-'));
const profile = join(root, 'User Data');
const extension = join(root, 'extension');
const names = () => createBrowserNames({ path: join(root, 'names.json') });
let bridge = createBridge({ port: 0, names: names() });
let context, browserProcess, probe;
async function eventually(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      // Restarting the bridge invalidates pooled status GET sockets. Retry
      // only transport resets, never assertions or HTTP/permission errors.
      let cause = error, transient = false;
      while (cause) {
        if (['ECONNRESET', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'EPIPE'].includes(cause.code)) transient = true;
        cause = cause.cause;
      }
      if (!transient) throw error;
    }
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}
async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
function launch(args) {
  const child = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, `--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
    '--no-first-run', '--no-default-browser-check', ...args
  ], { windowsHide: true, stdio: 'ignore' });
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.closed = once(child, 'close');
  return child;
}
async function startProbe(label) {
  const paths = Object.fromEntries(['ready', 'events', 'stop', 'result'].map(key => [key, join(root, `${label}-${key}`)]));
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', resolve('test/fixtures/foreground.ps1'),
    '-ReadyFile', paths.ready, '-EventsFile', paths.events, '-StopFile', paths.stop, '-ResultFile', paths.result], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  probe = child;
  const hwnd = await eventually(async () => {
    assert.equal(child.exitCode, null, `Foreground probe exited: ${errors}`);
    return (await readIfPresent(paths.ready))?.trim();
  }, 'foreground sentinel');
  assert.notEqual(hwnd, '0', 'An interactive desktop is required, never skip focus assertions');
  return {
    async assertUnchanged() {
      await delay(1000); // let Windows deliver out-of-context foreground events
      assert.equal(await readIfPresent(paths.events), '', 'A window stole foreground focus, even temporarily');
    },
    async stop(expectChange = false) {
      const closed = once(child, 'close');
      await writeFile(paths.stop, 'stop');
      const final = (await eventually(() => readIfPresent(paths.result), 'foreground result')).trim();
      const events = (await readFile(paths.events, 'utf8')).trim();
      assert.equal((await closed)[0], 0, errors);
      probe = undefined;
      if (expectChange) assert.match(events, /\tchrome(?:\r?\n|$)/, 'Positive control must detect Chrome taking foreground');
      else { assert.equal(events, ''); assert.equal(final, hwnd, 'Original foreground handle must be preserved'); }
    }
  };
}
try {
  const port = (await bridge.listen()).port;
  const client = createClient({ port });
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['background.js', 'manifest.json']) {
    const path = join(extension, name);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', `127.0.0.1:${port}`));
  }
  // Ordinary setup happens before measuring focus. Click the real optional
  // permission control; neither Preferences nor extension storage is edited.
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: false,
    ignoreDefaultArgs: ['--disable-background-mode'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const popup = await context.newPage();
  await popup.goto(worker.url().replace('background.js', 'popup.html'));
  assert.equal(await popup.locator('#background').isChecked(), false);
  await popup.locator('#background').check();
  await eventually(() => popup.locator('#background').isEnabled(), 'background permission grant');
  assert.equal(await popup.locator('#background').isChecked(), true);
  await eventually(async () => (await client.status()).connected, 'setup connection');
  const identity = (await client.call('browser.info')).id;
  await client.call('browser.rename', { name: 'main' });
  await context.close(); context = undefined;
  await eventually(async () => !(await client.status()).connected, 'Chrome fully exited');

  const coldProbe = await startProbe('cold');
  browserProcess = launch(['--profile-directory=Default', '--no-startup-window']);
  await eventually(async () => (await client.status()).connected, 'windowless Default connection');
  assert.equal((await client.call('browser.info')).id, identity, 'Reconnects the same profile identity');
  assert.deepEqual(await client.call('tabs.list'), [], 'No browser window/tab was opened');
  await coldProbe.assertUnchanged();
  await bridge.close();
  bridge = createBridge({ port, names: names() });
  await bridge.listen();
  await eventually(async () => (await client.status()).connected, 'background reconnect after bridge restart');
  await coldProbe.assertUnchanged();

  // Calibrate the probe against the behavior we must prevent. This ordinary
  // launch intentionally focuses a disposable Chrome window, never an owner window.
  const ordinary = launch(['--profile-directory=Default', '--new-window', 'about:blank']);
  await eventually(async () => (await client.call('tabs.list')).length, 'positive-control window');
  await delay(1500);
  await coldProbe.stop(true);
  await ordinary.closed;

  const keepProbe = await startProbe('keep');
  for (const tab of await client.call('tabs.list')) await client.call('tabs.close', { tabId: tab.id });
  await delay(3000);
  assert.equal((await client.status()).connected, true, 'Closing the last window keeps the profile available');
  assert.deepEqual(await client.call('tabs.list'), []);
  await keepProbe.assertUnchanged();
  await keepProbe.stop();
  console.log('PASS: same Default identity connects without windows; bridge restart and last-window close preserve foreground; ordinary-launch positive control detects focus');
} finally {
  probe?.kill();
  await context?.close();
  if (browserProcess?.pid) {
    const cleanup = spawn('taskkill.exe', ['/PID', String(browserProcess.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await once(cleanup, 'close');
  }
  await bridge.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
