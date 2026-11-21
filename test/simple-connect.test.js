import test from 'node:test';
import assert from 'node:assert/strict';
import { connectBrowser, doctorBrowser } from '../src/simple-connect.js';

const main = { id: 'main-id', name: 'main', connected: true };
const other = { id: 'other-id', name: 'other', connected: true };
const current = { browser: main, extension: { current: true, version: '0.1' }, bridge: { git: 'abc' } };
function fixture({ profiles = [main], info = current, reload, errors = {} } = {}) {
  const calls = [];
  return { calls, async call(method, params, options) {
    calls.push({ method, params, options });
    if (errors[method]) throw new Error(errors[method]);
    if (method === 'browsers.list') return profiles;
    if (method === 'extension.info') return info;
    if (method === 'extension.reload') return reload;
    throw new Error(`Unexpected call: ${method}`);
  } };
}

test('connect selects the unique connected profile and pins diagnostics by ID', async () => {
  const client = fixture({ profiles: [main, { ...other, connected: false }] });
  assert.equal((await connectBrowser(client)).ready, true);
  assert.deepEqual(client.calls[1], { method: 'extension.info', params: {}, options: { browser: main.id } });
});

test('explicit profile selection never falls back to another connected profile', async () => {
  for (const requested of ['missing', 'other']) {
    const client = fixture({ profiles: [main, { ...other, connected: false }] });
    const result = await connectBrowser(client, { profile: requested });
    assert.equal(result.ready, false);
    assert.match(result.diagnostics[0].code, /profile_(not_found|disconnected)/);
    assert.ok(client.calls.every(call => ['browsers.list', 'browser.info'].includes(call.method)));
    assert.ok(client.calls.filter(call => call.method === 'browser.info').every(call => call.options.browser === other.id));
  }
  const client = fixture({ profiles: [main, other] });
  assert.equal((await connectBrowser(client, { profile: 'MAIN' })).profile.id, main.id);
});

test('missing or ambiguous connections explain the next step without changing anything', async () => {
  for (const [profiles, code] of [[[], 'extension_disconnected'], [[main, other], 'profile_ambiguous']]) {
    const client = fixture({ profiles });
    assert.equal((await connectBrowser(client)).diagnostics[0].code, code);
    assert.ok(client.calls.every(call => ['browsers.list', 'browser.info'].includes(call.method)));
  }
});

test('connect waits for its selected profile to reconnect while doctor remains immediate', async () => {
  let connected = false;
  const calls = [];
  const client = { async call(method, params, options) {
    calls.push({ method, options });
    if (method === 'browsers.list') return [{ ...main, connected }];
    if (method === 'browser.info') { assert.equal(options.browser, main.id); connected = true; return main; }
    if (method === 'extension.info') return current;
    throw new Error(method);
  } };
  assert.equal((await doctorBrowser(client, { profile: 'main' })).ready, false);
  assert.equal(calls.some(call => call.method === 'browser.info'), false);
  assert.equal((await connectBrowser(client, { profile: 'main' })).ready, true);
  assert.equal(calls.filter(call => call.method === 'browser.info').length, 1);
});

test('bridge and access errors remain visible, with no alternate profile attempts', async () => {
  const client = fixture({ errors: { 'browsers.list': 'Phone approval required' } });
  const result = await connectBrowser(client);
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0].message, 'Phone approval required');
  assert.equal(client.calls.length, 1);
});

test('a bridge requiring restart is diagnosed before touching the extension', async () => {
  const client = fixture({ info: { ...current, bridge: { restartNeeded: true }, extension: { current: false }, capabilities: { safeReload: true } } });
  assert.equal((await connectBrowser(client)).diagnostics[0].code, 'bridge_restart_needed');
  assert.equal(client.calls.length, 2);
});

test('old bridges cannot trigger an unsafe automatic extension reload', async () => {
  const client = fixture({ info: { ...current, extension: { current: false } } });
  assert.equal((await connectBrowser(client)).diagnostics[0].code, 'extension_outdated');
  assert.equal(client.calls.length, 2);
});

test('automatic reload requires an advertised atomic idle guard and verifies its result', async () => {
  const client = fixture({ info: { ...current, extension: { current: false }, capabilities: { safeReload: true } }, reload: { ...current, reloaded: true } });
  const result = await connectBrowser(client);
  assert.equal(result.ready, true);
  assert.equal(result.reloaded, true);
  assert.deepEqual(client.calls[2], { method: 'extension.reload', params: { onlyIfIdle: true }, options: { browser: main.id } });
});

test('doctor is read-only even when safe reload is supported', async () => {
  const client = fixture({ info: { ...current, extension: { current: false }, capabilities: { safeReload: true } } });
  assert.equal((await doctorBrowser(client)).ready, false);
  assert.equal(client.calls.length, 2);
});

test('busy or unsupported extensions fail with their original explanation', async () => {
  const client = fixture({ info: { ...current, extension: { current: false }, capabilities: { safeReload: true } }, errors: { 'extension.reload': 'Browser has active commands' } });
  const result = await connectBrowser(client);
  assert.equal(result.ready, false);
  assert.equal(result.diagnostics[0].message, 'Browser has active commands');
  assert.equal(client.calls.length, 3);
});

test('a wrong-profile reload response is never accepted as ready', async () => {
  const client = fixture({ info: { ...current, extension: { current: false }, capabilities: { safeReload: true } }, reload: { ...current, browser: other, reloaded: true } });
  assert.equal((await connectBrowser(client)).diagnostics[0].code, 'invalid_response');
});
