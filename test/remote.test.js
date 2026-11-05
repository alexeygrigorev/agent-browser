import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateProfile } from '../src/remote.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/cli.js', import.meta.url));

test('remote profiles require device-authenticated HTTPS access and reject retired SSH configuration', () => {
  const profile = { kind: 'tools', server: 'https://tools.example', device: 'desktop', credentialFile: '/private/controller.json' };
  assert.equal(validateProfile(profile), profile);
  for (const server of ['http://tools.example', 'https://tools.example/browser', 'https://user:password@tools.example', 'https://tools.example?query=1']) assert.throws(() => validateProfile({ ...profile, server }));
  assert.throws(() => validateProfile({ ...profile, device: '../desktop' }));
  assert.throws(() => validateProfile({ ...profile, credentialFile: '' }));
  assert.throws(() => validateProfile({ host: 'publisher@relay', port: 19335, tokenFile: '/private/old-token' }), /Run auth login/);
});

test('retired SSH CLI commands fail before reading credentials or opening a connection', async () => {
  for (const args of [['tunnel', 'hetzner'], ['remote', 'publish', 'desktop'], ['remote', 'connect', 'desktop'], ['remote', 'add', 'desktop', '--host', 'relay']]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], { timeout: 5000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Unknown command: tunnel|Configure remote access with auth login/);
      return true;
    });
  }
});
