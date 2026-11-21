import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

async function popup({ granted = false, accept = true, fail = false } = {}) {
  const elements = new Map();
  const calls = [];
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { checked: false, disabled: false, addEventListener(event, fn) { this[event] = fn; } });
    return elements.get(selector);
  } };
  const chrome = {
    runtime: { sendMessage: async message => { calls.push(message.type); return { enabled: false, status: 'Paused' }; } },
    permissions: {
      contains: async () => granted,
      request: async value => { calls.push(['request', value]); if (fail) throw new Error('Permission unavailable'); granted = accept; return granted; },
      remove: async value => { calls.push(['remove', value]); granted = false; return true; }
    }
  };
  const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
  await vm.runInNewContext(`(async () => { ${source}\n })()`, { chrome, document, setInterval() {} });
  return { elements, calls, background: elements.get('#background') };
}

test('background lifetime is optional and opening a paused popup never grants it', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.ok(!manifest.permissions.includes('background'));
  assert.ok(manifest.optional_permissions.includes('background'));
  const { background, calls } = await popup();
  assert.equal(background.checked, false);
  assert.deepEqual(calls, ['status']);
});

test('explicit background opt-in and removal preserve Pause', async () => {
  const { background, calls, elements } = await popup();
  background.checked = true;
  await background.change();
  assert.equal(background.checked, true);
  background.checked = false;
  await background.change();
  assert.equal(background.checked, false);
  assert.equal(elements.get('#status').textContent, 'Paused');
  assert.deepEqual(calls.map(c => Array.isArray(c) ? c[0] : c), ['status', 'request', 'remove']);
  assert.equal(JSON.stringify(calls[1][1]), '{"permissions":["background"]}');
});

for (const options of [{ accept: false }, { fail: true }]) {
  test(`denied/unavailable permission restores the actual checkbox state: ${JSON.stringify(options)}`, async () => {
    const { background } = await popup(options);
    background.checked = true;
    await background.change();
    assert.equal(background.checked, false);
    assert.equal(background.disabled, false);
  });
}
