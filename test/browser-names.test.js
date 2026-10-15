import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createBrowserNames } from '../src/browser-names.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'browser-names-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'nested', 'names.json');
  return { path, store: createBrowserNames({ path }) };
}

test('browser nicknames persist across store instances and can be renamed', async t => {
  const { store, path } = await fixture(t);
  assert.equal(await store.get('profile-one'), null);
  assert.equal(await store.rename('profile-one', 'Main'), 'main');
  assert.equal(await createBrowserNames({ path }).get('profile-one'), 'main');
  assert.equal(await store.rename('profile-one', 'personal'), 'personal');
  assert.equal(await createBrowserNames({ path }).get('profile-one'), 'personal');
  const persisted = await readFile(path, 'utf8');
  assert.doesNotThrow(() => JSON.parse(persisted));
});

test('nicknames validate their shape and reject duplicate names across browsers', async t => {
  const { store } = await fixture(t);
  await store.rename('profile-one', 'main');
  await assert.rejects(store.rename('profile-two', 'MAIN'));
  assert.equal(await store.get('profile-one'), 'main');
  assert.equal(await store.get('profile-two'), null);
  for (const name of ['', '1main', 'with space', '../main', 'a'.repeat(33), null]) {
    await assert.rejects(store.rename('profile-one', name));
  }
  assert.equal(await store.rename('profile-two', 'Work_2-test'), 'work_2-test');
});

test('migration moves an existing nickname and survives reopening', async t => {
  const { store, path } = await fixture(t);
  await store.rename('old-profile', 'main');
  await store.migrate('old-profile', 'new-profile');
  const reopened = createBrowserNames({ path });
  assert.equal(await reopened.get('new-profile'), 'main');
  assert.equal(await reopened.get('old-profile'), null);
  await store.migrate('missing-profile', 'another-profile');
  assert.equal(await store.get('another-profile'), null);
});

test('migration preserves an already named destination', async t => {
  const { store } = await fixture(t);
  await store.rename('old-profile', 'main');
  await store.rename('new-profile', 'work');
  await store.migrate('old-profile', 'new-profile');
  assert.equal(await store.get('old-profile'), 'main');
  assert.equal(await store.get('new-profile'), 'work');
});
