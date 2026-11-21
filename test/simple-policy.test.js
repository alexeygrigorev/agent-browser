import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy } from '../src/tools/policy.js';

test('named grant inspection remains available when the browser is offline', async () => {
  const policy = createPolicy({ files: {}, clientFactory: () => { throw new Error('offline'); } });
  const grant = { profiles: ['main'], mode: 'interact', origins: ['https://example.com'] };
  assert.deepEqual(await policy.invoke(grant, { method: 'access.info' }), { ...grant, expires: undefined });
});

function fixture() {
  const state = { profiles: [{ id: 'id-main', name: 'main', connected: true }, { id: 'id-private', name: 'private', connected: true }] };
  const calls = [];
  const engine = createPolicy({ files: {}, clientFactory: ({ browser }) => ({
    async call(method, params) {
      calls.push({ browser, method, params });
      if (method === 'browsers.list') return state.profiles;
      if (method === 'tabs.list') return [{ id: 5, url: 'https://example.com/' }, { id: 6, url: 'chrome://settings' }];
      return { ok: true };
    }
  }) });
  const grant = { profiles: ['main'], mode: 'interact', origins: ['https://example.com'] };
  return { state, calls, grant, invoke: command => engine.invoke(grant, command) };
}

test('granted profile ID resolves through its current name and remains pinned', async () => {
  const { invoke, calls } = fixture();
  assert.deepEqual(await invoke({ browser: 'id-main', method: 'extension.info' }), { ok: true });
  assert.deepEqual(calls, [{ browser: undefined, method: 'browsers.list', params: undefined }, { browser: 'id-main', method: 'extension.info', params: {} }]);
});
test('granted profile name also pins downstream commands to its ID', async () => {
  const { invoke, calls } = fixture();
  await invoke({ browser: 'main', method: 'page.click', params: { tabId: 5, ref: 'e1' } });
  assert.deepEqual(calls.slice(1).map(call => call.browser), ['id-main', 'id-main']);
});
test('unknown and ungranted IDs cannot select another connected browser', async () => {
  const { invoke, calls } = fixture();
  for (const browser of ['id-private', 'not-a-profile', 'private']) await assert.rejects(invoke({ browser, method: 'extension.info' }), error => error.status === 403);
  assert.ok(calls.every(call => call.method === 'browsers.list'));
});
test('renaming a profile revokes saved-ID access on the next command', async () => {
  const { invoke, state, calls } = fixture();
  await invoke({ browser: 'id-main', method: 'extension.info' });
  state.profiles[0].name = 'private-now';
  await assert.rejects(invoke({ browser: 'id-main', method: 'extension.info' }), error => error.status === 403);
  assert.equal(calls.filter(call => call.method === 'extension.info').length, 1);
});
test('browser inventory reveals only profiles whose current names are granted', async () => {
  const { invoke, state } = fixture();
  assert.deepEqual(await invoke({ method: 'browsers.list' }), [state.profiles[0]]);
});
test('ID resolution preserves mode and origin restrictions', async () => {
  const { invoke, grant, calls } = fixture();
  grant.mode = 'inspect';
  await assert.rejects(invoke({ browser: 'id-main', method: 'page.click', params: { tabId: 5, ref: 'e1' } }), error => error.status === 403);
  assert.equal(calls.length, 0);
  grant.mode = 'interact'; grant.origins = ['https://other.example'];
  await assert.rejects(invoke({ browser: 'id-main', method: 'page.click', params: { tabId: 5, ref: 'e1' } }), error => error.status === 403);
  assert.ok(calls.every(call => call.method !== 'page.click'));
});
test('internal tabs remain inaccessible and filtered after ID resolution', async () => {
  const { invoke } = fixture();
  assert.deepEqual(await invoke({ browser: 'id-main', method: 'tabs.list' }), [{ id: 5, url: 'https://example.com/' }]);
  await assert.rejects(invoke({ browser: 'id-main', method: 'page.snapshot', params: { tabId: 6 } }), error => error.status === 403);
});
