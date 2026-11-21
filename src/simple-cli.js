import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, writePrivate } from './tools/private-store.js';

const refPattern = /^e[1-9][0-9]*$/;
const simpleCommands = new Set(['connect', 'doctor', 'open', 'snapshot', 'fill']);

// Resolve persisted routing before constructing a client. Never keep page contents,
// element references, cookies, credentials or downloaded files in session metadata.
export async function prepareSimpleCommand({ command, args = [], browser, remote, sessionName = 'default', sessionDir = join(homedir(), '.agent-browser', 'sessions'), settleMs = 1200, sleep = delay } = {}) {
  if (!simpleCommands.has(command) && !(command === 'click' && refPattern.test(args[0] || ''))) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionName)) throw new Error('Session names must contain 1–64 letters, numbers, underscores or hyphens');
  const parts = [...args];
  const minimumArgs = command === 'fill' ? 2 : ['open', 'click'].includes(command) ? 1 : 0;
  const json = parts.length > minimumArgs && parts.at(-1) === '--json';
  if (json) parts.pop();
  if (['connect', 'doctor'].includes(command) ? parts.length > 1 : command === 'open' ? parts.length !== 1 : command === 'snapshot' ? parts.length !== 0 : command === 'click' ? parts.length !== 1 : parts.length !== 2) {
    throw new Error(`Usage: ${command}${['connect', 'doctor'].includes(command) ? ' [profile]' : command === 'open' ? ' <URL>' : command === 'snapshot' ? '' : command === 'click' ? ' <eN>' : ' <eN> <text>'} [--json]`);
  }
  if (['fill', 'click'].includes(command) && !refPattern.test(parts[0])) throw new Error('Expected an element reference such as e3 from the latest snapshot');
  if (command === 'open') {
    let url; try { url = new URL(parts[0]); } catch { throw new Error('Open requires a complete http or https URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Open requires a complete http or https URL');
  }
  const file = join(sessionDir, `${sessionName}.json`);
  let saved = {};
  try {
    saved = JSON.parse(await readFile(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved) || saved.version !== 1 || (saved.browser !== undefined && (typeof saved.browser !== 'string' || !saved.browser.trim())) || (saved.remote !== undefined && (typeof saved.remote !== 'string' || !saved.remote.trim())) || (saved.tabId !== undefined && (!Number.isInteger(saved.tabId) || saved.tabId < 0))) throw new Error('Invalid browser session metadata');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const explicitBrowser = ['connect', 'doctor'].includes(command) ? parts[0] ?? browser : browser;
  const effectiveBrowser = explicitBrowser ?? saved.browser;
  const effectiveRemote = remote ?? saved.remote;
  const routeChanged = (explicitBrowser !== undefined && explicitBrowser !== saved.browser) || (remote !== undefined && remote !== saved.remote);
  let tabId = routeChanged ? undefined : saved.tabId;
  let selectedBrowser = effectiveBrowser;
  async function persist() {
    await privateDirectory(sessionDir);
    await writePrivate(file, { version: 1, ...(selectedBrowser ? { browser: selectedBrowser } : {}), ...(effectiveRemote ? { remote: effectiveRemote } : {}), ...(tabId === undefined ? {} : { tabId }) });
  }
  return {
    browser: effectiveBrowser, remote: effectiveRemote, json,
    async execute(client) {
      if (['connect', 'doctor'].includes(command)) {
        const { connectBrowser, doctorBrowser } = await import('./simple-connect.js');
        const result = await (command === 'connect' ? connectBrowser : doctorBrowser)(client, { profile: effectiveBrowser });
        if (command === 'connect' && result.ready) {
          const identity = result.profile?.id || result.profile?.name;
          if (identity && identity !== selectedBrowser) tabId = undefined;
          selectedBrowser = identity || selectedBrowser;
          await persist();
        }
        return { command, session: sessionName, ...result };
      }
      const identity = await client.call('browser.info');
      if (typeof identity?.id !== 'string' || !identity.id) throw new Error('The bridge did not identify the selected browser. Run connect <profile> first.');
      selectedBrowser = identity.id;
      const call = (method, params) => client.call(method, params, { browser: selectedBrowser });
      let tabs = await call('tabs.list');
      if (command !== 'open' && (tabId === undefined || !tabs.some(tab => tab.id === tabId))) throw new Error(`Session ${sessionName} has no available tab. Run open <URL> first.`);
      const before = new Set(tabs.map(tab => tab.id));
      let actionPerformed = false;
      if (command === 'open') {
        const created = await call('tabs.create', { url: parts[0], active: false });
        tabId = created.id;
        actionPerformed = true;
      } else if (command === 'click') {
        await perform('page.click', { tabId, ref: parts[0], mode: 'synthetic', fallback: false });
        actionPerformed = true;
      } else if (command === 'fill') {
        await perform('page.type', { tabId, ref: parts[0], text: parts[1], clear: true });
        actionPerformed = true;
      }
      // Save successful mutations before inspecting their result: a failed snapshot
      // must never invite a retry of a purchase, form submission or other click.
      async function perform(method, params) {
        try { return await call(method, params); }
        catch (error) {
          if (/timeout|timed out|disconnect|socket|cannot reach|fetch failed|connection|econnreset/i.test(error.message)) {
            throw Object.assign(new Error(`The ${command} result is unknown: ${error.message}. Do not repeat the action; run snapshot to inspect the result.`, { cause: error }), { actionMayHavePerformed: true, tabId });
          }
          throw error;
        }
      }
      try {
        if (actionPerformed) await persist();
        if (actionPerformed) {
          const attempts = Math.max(1, Math.ceil(settleMs / 100));
          let stable = 0;
          for (let attempt = 0; attempt < attempts; attempt++) {
            await sleep(Math.min(100, settleMs));
            tabs = await call('tabs.list');
            const popups = tabs.filter(tab => !before.has(tab.id) && tab.openerTabId === tabId);
            if (popups.length === 1) { tabId = popups[0].id; await persist(); stable = 0; }
            else if (popups.length > 1) throw new Error('The action opened multiple tabs. Inspect tabs.list and choose a tab explicitly.');
            const current = tabs.find(tab => tab.id === tabId);
            if (!current) throw new Error('The session tab closed. Open a new URL to continue.');
            stable = current.status === 'loading' ? 0 : stable + 1;
            if (stable >= 3) break;
          }
        }
        const snapshot = await call('page.snapshot', { tabId, refs: true });
        return { command, session: sessionName, tabId, ...(actionPerformed ? { actionPerformed: true } : {}), snapshot };
      } catch (error) {
        if (!actionPerformed) throw error;
        throw Object.assign(new Error(`The ${command} action was performed, but its updated snapshot failed: ${error.message}. Do not repeat the action; run snapshot to inspect the result.`, { cause: error }), { actionPerformed: true, tabId });
      }
    }
  };
}

export function formatSimpleResult(result) {
  if (!result.snapshot) {
    return [`${result.ready ? 'Ready' : 'Not ready'}${result.profile?.name || result.profile?.id ? `: ${result.profile.name || result.profile.id}` : ''}`, ...(result.diagnostics || []).map(item => `${item.message}${item.action ? `\n  ${item.action}` : ''}`)].join('\n');
  }
  const { snapshot } = result;
  return [`Session ${result.session} · tab ${result.tabId}`, snapshot.title, snapshot.url, snapshot.text, ...(snapshot.elements || []).map(element => `${element.ref || '?'}: ${element.tag || element.role || 'element'}${element.text ? ` ${element.text}` : ''}${element.type ? ` (${element.type})` : ''}`)].filter(Boolean).join('\n');
}
