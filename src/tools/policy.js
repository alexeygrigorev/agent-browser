import { createClient } from '../client.js';
import { fail } from './auth.js';
import { createFiles } from '../files.js';

const inspect = new Set(['access.info', 'browser.info', 'browsers.list', 'extension.info', 'tabs.list', 'groups.list', 'page.snapshot', 'page.screenshot', 'downloads.list', 'downloads.info', 'downloads.wait']);
const interact = new Set(['tabs.create', 'tabs.navigate', 'tabs.close', 'groups.manage', 'groups.release', 'dialogs.handle', 'page.click', 'page.hover', 'page.mouse', 'page.type', 'page.key', 'page.scroll', 'page.upload', 'downloads.start']);
export function webUrl(value) {
  try { const u = new URL(value); return ['https:', 'http:', 'data:', 'blob:'].includes(u.protocol) || value === 'about:blank'; } catch { return false; }
}
export function methodAllowed(method, mode) { return inspect.has(method) || mode !== 'inspect' && interact.has(method) || mode === 'script' && method === 'page.evaluate'; }
export function createPolicy({ bridgePort = 19333, files = createFiles({ maxStoredBytes: 512 * 1024 * 1024, maxFiles: 128, retentionMs: 86400000 }), audit = () => {} } = {}) {
  async function invoke(policy, command) {
    const { method, params = {} } = command;
    const browser = command.browser || (['browsers.list', 'access.info'].includes(method) ? policy.profiles[0] : undefined);
    if (!policy.profiles.includes(browser) || !methodAllowed(method, policy.mode)) throw fail(403, 'Profile or command is outside the locally paired grant');
    if (method === 'access.info') return { profiles: policy.profiles, mode: policy.mode, origins: policy.origins, expires: policy.expires };
    const client = createClient({ port: bridgePort, browser });
    if (['tabs.create', 'tabs.navigate', 'downloads.start'].includes(method) && params.url && !webUrl(params.url)) throw fail(403, 'Remote access to local or browser-internal URLs is denied');
    if (params.tabId !== undefined) {
      const tabs = await client.call('tabs.list'); const tab = tabs.find(t => t.id === params.tabId);
      if (!tab || !webUrl(tab.url) || tab.pendingUrl && !webUrl(tab.pendingUrl)) throw fail(403, 'Remote access to local or browser-internal tabs is denied');
      if (!inspect.has(method) && !policy.origins?.includes('*') && !policy.origins?.includes(new URL(tab.url).origin)) throw fail(403, 'Interaction with this origin is not locally granted');
    }
    if (params.url && !inspect.has(method) && !policy.origins?.includes('*') && !policy.origins?.includes(new URL(params.url).origin)) throw fail(403, 'Navigation or download origin is not locally granted');
    if (method === 'page.upload') { try { await files.validateStaged(params.files); } catch { throw fail(403, 'Only valid staged uploads are allowed remotely'); } }
    const result = await client.call(method, params);
    audit('browser_command', { fingerprint: policy.fingerprint, profile: browser, method, outcome: 'allowed' });
    if (method === 'browsers.list') return result.filter(b => policy.profiles.includes(b.name));
    if (method === 'tabs.list') return result.filter(t => webUrl(t.url) && (!t.pendingUrl || webUrl(t.pendingUrl)));
    return result;
  }
  return { invoke, files };
}
