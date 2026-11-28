import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../windows/managed-chrome.ps1', import.meta.url), 'utf8');

test('managed Chrome launch always carries both anti-backgrounding flags', () => {
  for (const flag of ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']) {
    assert.ok(script.includes(`'${flag}'`), flag);
  }
});

test('managed Chrome launch restores tabs in the existing profile', () => {
  assert.match(script, /--restore-last-session/);
  assert.match(script, /--profile-directory=\$ProfileDirectory/);
});
