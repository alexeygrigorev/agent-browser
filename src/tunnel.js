import { spawn } from 'node:child_process';
import { createClient, getPort } from './client.js';
import { launchBridge } from './launcher.js';

export function sshArgs(host, { port = getPort(), remotePort = port } = {}) {
  if (typeof host !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(host)) throw new Error('Provide an SSH host or user@host without options or whitespace');
  getPort(port); getPort(remotePort);
  return ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-R', `127.0.0.1:${remotePort}:127.0.0.1:${port}`, host];
}

export async function startTunnel(host, { port = getPort(), remotePort = port, spawnProcess = spawn, ensureBridge = true } = {}) {
  const args = sshArgs(host, { port, remotePort });
  if (ensureBridge) {
    try { await createClient({ port }).status(); }
    catch (error) {
      if (error.cause?.cause?.code !== 'ECONNREFUSED') throw error;
      await launchBridge(port);
    }
  }
  const child = spawnProcess('ssh', args, { shell: false, windowsHide: true, stdio: 'inherit' });
  const stop = () => child.kill();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 || signal ? resolve() : reject(new Error(`SSH tunnel exited with code ${code}`)));
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
