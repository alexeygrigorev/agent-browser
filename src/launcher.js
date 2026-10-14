import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function launchBridge(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'serve'], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, AGENT_BROWSER_PORT: String(port) }
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}
