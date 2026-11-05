import { readFile, mkdir, open, rename, unlink, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { deviceLogin } from '../../vendor/dtc-device-login.mjs';
import { deviceName } from './auth.js';
import { saveProfile } from '../remote.js';

export const credentialPath = daemon => join(homedir(), '.agent-browser', 'tools', daemon ? 'daemon.json' : 'controller.json');
export function serverUrl(raw = 'https://tools.dtcdev.click') {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Server must be an HTTPS origin');
  return u.origin;
}
export async function loadCredential(file) {
  const c = JSON.parse(await readFile(file, 'utf8'));
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.access_token || '') || c.expires <= Date.now()) throw new Error('Credential expired; run auth login');
  serverUrl(c.server); return c;
}
export async function runAuth(args) {
  const [action, ...rest] = args; const options = { server: 'https://tools.dtcdev.click', device: 'desktop' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--daemon') { options.daemon = true; continue; }
    const key = { '--server': 'server', '--device': 'device', '--name': 'name', '--label': 'label', '--credential-file': 'credentialFile' }[rest[i]];
    if (!key || !rest[i + 1]) throw new Error('Invalid auth option'); options[key] = rest[++i];
  }
  const file = options.credentialFile ? resolve(options.credentialFile) : credentialPath(options.daemon);
  if (action === 'login') {
    const server = serverUrl(options.server); if (!deviceName(options.device)) throw new Error('Invalid device name');
    const result = await deviceLogin({ baseUrl: server,
      startBody: { role: options.daemon ? 'daemon' : 'controller', device: options.device, label: options.label || `${hostname()} · ${options.daemon ? 'desktop daemon' : 'browser CLI'}` },
      post: async (url, body) => {
        const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
        return { status: response.status, body: await response.json() };
      },
    });
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.access_token || '')) throw new Error('Invalid device credential');
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    const staged = await open(temp, 'wx', 0o600);
    try {
      // Windows ignores POSIX mode bits: restrict the empty staging file before
      // writing any credential, without changing permissions on its directory.
      if (process.platform === 'win32') {
        const identity = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
        execFileSync('icacls.exe', [temp, '/inheritance:r', '/grant:r', `${identity}:F`], { stdio: 'ignore', windowsHide: true });
      }
      await staged.writeFile(JSON.stringify({ ...result, server }, null, 2) + '\n');
    } finally { await staged.close(); }
    await rename(temp, file); await chmod(file, 0o600);
    if (!options.daemon) await saveProfile(options.name || options.device, { kind: 'tools', server, device: options.device, credentialFile: file });
    console.log(`Signed in as ${result.email} (${result.role}). Credential stored privately.`); return;
  }
  if (['status', 'logout'].includes(action)) {
    const credential = await loadCredential(file);
    const response = await fetch(`${credential.server}/api/auth/${action === 'logout' ? 'logout' : 'me'}`, { method: action === 'logout' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Authentication rejected (${response.status}); run auth login`);
    if (action === 'logout') { await unlink(file); console.log('Credential revoked and removed.'); }
    else console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  throw new Error('Usage: auth login|status|logout [--server HTTPS_ORIGIN] [--daemon] [--device desktop] [--name desktop] [--label TEXT] [--credential-file PATH]');
}
