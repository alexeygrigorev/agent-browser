import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSimpleCommand, formatSimpleResult } from '../src/simple-cli.js';

async function fixture(t) {
  const sessionDir = await mkdtemp(join(tmpdir(), 'browser-cli-'));
  t.after(() => rm(sessionDir, { recursive: true, force: true }));
  return { sessionDir, sessionName: 'test', sleep: async () => {}, settleMs: 300 };
}
function fake() {
  const calls = [];
  const state = { tabs: [{ id: 1, active: true, status: 'complete' }] };
  return {
    calls, state,
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'browser.info') return { id: 'main' };
      if (method === 'tabs.list') return state.tabs;
      if (method === 'tabs.create') { const tab = { id: 2, status: 'complete' }; state.tabs.push(tab); return tab; }
      if (method === 'page.snapshot') return { title: 'Example', url: 'https://example.com', text: 'Welcome', elements: [{ ref: 'e1', tag: 'button', text: 'Continue' }] };
      if (method === 'page.click' && state.popup) state.tabs.push({ id: 3, openerTabId: 2, status: 'complete' });
      return {};
    }
  };
}
async function opened(t, extra = {}) {
  const options = { ...await fixture(t), ...extra };
  const client = fake();
  await (await prepareSimpleCommand({ ...options, command: 'open', args: ['https://example.com'] })).execute(client);
  client.calls.length = 0;
  return { options, client };
}

test('open creates a background tab and persists only minimal routing metadata', async t => {
  const options = await fixture(t); const client = fake();
  const prepared = await prepareSimpleCommand({ ...options, browser: 'main', remote: 'desktop', command: 'open', args: ['https://example.com/private'] });
  const result = await prepared.execute(client);
  assert.deepEqual(client.calls.find(c => c.method === 'tabs.create').params, { url: 'https://example.com/private', active: false });
  assert.equal(result.snapshot.elements[0].ref, 'e1');
  assert.deepEqual(JSON.parse(await readFile(join(options.sessionDir, 'test.json'), 'utf8')), { version: 1, browser: 'main', remote: 'desktop', tabId: 2 });
  const next = await prepareSimpleCommand({ ...options, command: 'snapshot' });
  assert.equal(next.browser, 'main'); assert.equal(next.remote, 'desktop');
});
test('ref click preserves routing, uses background input and returns refreshed refs', async t => {
  const { options, client } = await opened(t);
  const result = await (await prepareSimpleCommand({ ...options, command: 'click', args: ['e1'] })).execute(client);
  assert.deepEqual(client.calls.find(c => c.method === 'page.click').params, { tabId: 2, ref: 'e1', mode: 'synthetic', fallback: false });
  assert.deepEqual(client.calls.at(-1), { method: 'page.snapshot', params: { tabId: 2, refs: true } });
  assert.equal(result.actionPerformed, true);
});
test('fill sends text as data without selector or shell quoting', async t => {
  const { options, client } = await opened(t);
  const text = 'a "quote"\n$(secret)';
  await (await prepareSimpleCommand({ ...options, command: 'fill', args: ['e1', text] })).execute(client);
  assert.deepEqual(client.calls.find(c => c.method === 'page.type').params, { tabId: 2, ref: 'e1', text, clear: true });
});
test('only newly opened session popups are followed, and selection persists', async t => {
  const { options, client } = await opened(t);
  client.state.tabs.push({ id: 8, openerTabId: 2, status: 'complete' }, { id: 9, openerTabId: 1, status: 'complete' });
  client.state.popup = true;
  const result = await (await prepareSimpleCommand({ ...options, command: 'click', args: ['e1'] })).execute(client);
  assert.equal(result.tabId, 3);
  assert.equal(JSON.parse(await readFile(join(options.sessionDir, 'test.json'), 'utf8')).tabId, 3);
});
test('failed post-action snapshot says performed and never retries the action', async t => {
  const { options, client } = await opened(t);
  const original = client.call.bind(client);
  client.call = async (method, params) => { if (method === 'page.snapshot') throw new Error('403 denied'); return original(method, params); };
  await assert.rejects((await prepareSimpleCommand({ ...options, command: 'click', args: ['e1'] })).execute(client), error => error.actionPerformed === true && /Do not repeat/.test(error.message));
  assert.equal(client.calls.filter(c => c.method === 'page.click').length, 1);
});
test('action access denial is propagated without retry or local fallback', async t => {
  const { options, client } = await opened(t, { remote: 'desktop' });
  const calls = [];
  client.call = async (method) => { calls.push(method); if (method === 'browser.info') return { id: 'main' }; if (method === 'tabs.list') return client.state.tabs; throw new Error('403 grant denied'); };
  await assert.rejects((await prepareSimpleCommand({ ...options, command: 'click', args: ['e1'] })).execute(client), /403 grant denied/);
  assert.deepEqual(calls, ['browser.info', 'tabs.list', 'page.click']);
});
test('explicit route changes cannot reuse a tab from a different browser', async t => {
  const { options, client } = await opened(t, { browser: 'main' });
  const next = await prepareSimpleCommand({ ...options, browser: 'other', command: 'snapshot' });
  await assert.rejects(next.execute(client), /no available tab/);
});
test('snapshot never attaches to the user active tab or a closed session tab', async t => {
  const options = await fixture(t); const client = fake();
  await assert.rejects((await prepareSimpleCommand({ ...options, command: 'snapshot' })).execute(client), /open <URL>/);
});
test('legacy click and other commands are left untouched', async () => {
  assert.equal(await prepareSimpleCommand({ command: 'click', args: ['123', '#button'] }), null);
  assert.equal(await prepareSimpleCommand({ command: 'call', args: ['tabs.list'] }), null);
});
test('validates sessions, urls, refs and command arity before browser access', async t => {
  const options = await fixture(t);
  for (const input of [{ command: 'open', args: ['file:///secrets'] }, { command: 'open', args: ['https://example.com'], sessionName: '../escape' }, { command: 'fill', args: ['#selector', 'text'] }, { command: 'snapshot', args: ['extra'] }]) {
    await assert.rejects(prepareSimpleCommand({ ...options, ...input }));
  }
});
test('text output includes reference labels and doctor diagnostics', () => {
  assert.match(formatSimpleResult({ session: 'test', tabId: 2, snapshot: { title: 'Page', elements: [{ ref: 'e1', tag: 'button', text: 'Continue' }] } }), /e1: button Continue/);
  assert.match(formatSimpleResult({ ready: false, diagnostics: [{ message: 'Browser offline', action: 'Open Chrome' }] }), /Not ready\nBrowser offline\n  Open Chrome/);
});
test('fill preserves literal --json text and accepts an additional output flag', async t => {
  const { options, client } = await opened(t);
  for (const args of [['e1', '--json'], ['e1', '--json', '--json']]) {
    const prepared = await prepareSimpleCommand({ ...options, command: 'fill', args });
    await prepared.execute(client);
    assert.equal(client.calls.filter(c => c.method === 'page.type').at(-1).params.text, '--json');
    assert.equal(prepared.json, args.length === 3);
  }
});
test('ambiguous transport failure never retries a click and tells the agent to inspect', async t => {
  const { options, client } = await opened(t);
  const original = client.call.bind(client);
  client.call = async (method, params) => { if (method === 'page.click') throw new Error('Socket disconnected'); return original(method, params); };
  await assert.rejects((await prepareSimpleCommand({ ...options, command: 'click', args: ['e1'] })).execute(client), error => error.actionMayHavePerformed === true && /Do not repeat/.test(error.message));
});
