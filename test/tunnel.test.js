import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sshArgs, startTunnel } from '../src/tunnel.js';

test('SSH tunnel is loopback-only with safe argv and foreground cleanup', async () => {
  assert.deepEqual(sshArgs('user@server', { port: 19333, remotePort: 19334 }), ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-R', '127.0.0.1:19334:127.0.0.1:19333', 'user@server']);
  for (const host of ['-oProxyCommand=bad', 'server bad', 'host;cmd', '']) assert.throws(() => sshArgs(host));
  assert.throws(() => sshArgs('server', { remotePort: 0 }));
  const before = process.listenerCount('SIGINT');
  let invocation;
  await startTunnel('server', { ensureBridge: false, spawnProcess: (...args) => {
    invocation = args;
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => child.emit('exit', 0, null));
    return child;
  } });
  assert.equal(invocation[0], 'ssh');
  assert.deepEqual(invocation[2], { shell: false, windowsHide: true, stdio: 'inherit' });
  assert.equal(process.listenerCount('SIGINT'), before);
});
