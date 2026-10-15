// Capture real extension UI in disposable Chromium, without personal tabs or cookies.
import { chromium } from 'playwright';
import { mkdtemp, cp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../src/bridge.js';
import { createClient } from '../src/client.js';
import { createBrowserNames } from '../src/browser-names.js';

const root = await mkdtemp(join(tmpdir(), 'agent-browser-readme-'));
const extension = join(root, 'extension');
const output = resolve('docs/screenshots');
const bridge = createBridge({ port: 19336, names: createBrowserNames({ path: join(root, 'names.json') }) });
const contexts = [];
try {
  await cp(resolve('extension'), extension, { recursive: true });
  for (const file of ['background.js', 'manifest.json']) {
    const path = join(extension, file);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', '127.0.0.1:19336'));
  }
  await mkdir(output, { recursive: true });
  await bridge.listen();
  const client = createClient({ port: 19336 });
  for (const name of ['main', 'orin']) {
    const context = await chromium.launchPersistentContext(join(root, name), {
      channel: 'chromium', headless: true, viewport: { width: 350, height: 360 }, deviceScaleFactor: 2,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    contexts.push(context);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    let identity;
    for (let attempt = 0; attempt < 100; attempt++) {
      const list = await client.call('browsers.list');
      identity = list.find(browser => browser.connected && !browser.name);
      if (identity) break;
      await delay(100);
    }
    if (!identity) throw new Error('Extension did not connect');
    await client.call('browser.rename', { name }, { browser: identity.id });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`);
    await popup.getByText(`Browser: ${name}`, { exact: true }).waitFor();
    await popup.screenshot({ path: join(output, `extension-${name}.png`), fullPage: true });
  }
  console.log('Captured main and orin extension popups from two connected Chromium profiles.');
} finally {
  for (const context of contexts) await context.close();
  await bridge.close();
  await rm(root, { recursive: true, force: true });
}
