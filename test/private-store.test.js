import test from 'node:test';
import assert from 'node:assert/strict';
import { currentWindowsPrincipal } from '../src/tools/private-store.js';

test('ACL principal comes from the current Windows token SID, independent of account naming', () => {
  const calls = [];
  const result = currentWindowsPrincipal({ run(...args) {
    calls.push(args);
    return '"desktop\\User","S-1-5-21-123-456-789-1001"\r\n';
  } });
  assert.equal(result, '*S-1-5-21-123-456-789-1001');
  assert.match(calls[0][0], /[\\/]System32[\\/]whoami\.exe$/);
  assert.deepEqual(calls[0][1], ['/user', '/fo', 'csv', '/nh']);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(calls[0][2].windowsHide, true);
});

test('CSV account names can contain commas and escaped quotes', () => {
  assert.equal(currentWindowsPrincipal({ run: () => '\uFEFF"domain\\A,""B""","S-1-5-18"\r\n' }), '*S-1-5-18');
});

test('invalid or ambiguous whoami output cannot become an ACL argument', () => {
  for (const output of [
    '', 'WORKGROUP\\user', '"user","S-1-5-18"\n"other","S-1-5-19"',
    '"user","S-1-5-18 /grant Everyone:F"', '"user","S-2-5-18"',
    '"user","S-1-281474976710656-18"', '"user","S-1-5-4294967296"',
    `"user","S-1-5${'-1'.repeat(16)}"`
  ]) {
    assert.throws(() => currentWindowsPrincipal({ run: () => output }), /Cannot validate/);
  }
});

test('whoami failure refuses access changes without exposing subprocess output', () => {
  assert.throws(() => currentWindowsPrincipal({ run() { throw new Error('private subprocess output'); } }), error => {
    assert.match(error.message, /Cannot determine.*SID/);
    assert.doesNotMatch(error.message, /private subprocess output/);
    return true;
  });
});
