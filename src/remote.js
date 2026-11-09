import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createClient } from './client.js';

export const configFile = () => process.env.AGENT_BROWSER_REMOTE_CONFIG || join(homedir(), '.agent-browser', 'remotes.json');
const namePattern = /^[a-z][a-z0-9_-]{0,31}$/;
export function validateProfile(profile) {
  if (profile?.kind !== 'tools') throw new Error('Unsupported remote profile. Run auth login to configure device-authenticated access.');
  const url = new URL(profile.server);
  if (url.protocol !== 'https:' || url.origin !== profile.server || !/^[a-z][a-z0-9_-]{0,31}$/.test(profile.device || '') || typeof profile.credentialFile !== 'string' || !profile.credentialFile) throw new Error('Invalid tools remote profile');
  return profile;
}
export async function readProfiles() {
  try { return JSON.parse(await readFile(configFile(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
export async function getProfile(name) {
  if (!namePattern.test(name || '')) throw new Error('Invalid remote name');
  const profile = (await readProfiles())[name];
  if (!profile) throw new Error(`Unknown remote: ${name}`);
  return validateProfile(profile);
}
export async function saveProfile(name, profile) {
  if (!namePattern.test(name || '')) throw new Error('Invalid remote name');
  validateProfile(profile);
  const profiles = await readProfiles();
  profiles[name] = profile;
  const file = configFile();
  await mkdir(resolve(file, '..'), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(profiles, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temp, file);
}
export async function remoteCommand(args) {
  const [action, name, ...rest] = args;
  if (action === 'list' && args.length === 1) { console.log(JSON.stringify(await readProfiles(), null, 2)); return; }
  if (action === 'check' && name && !rest.length) {
    const profile = await getProfile(name);
    const { remoteOptions } = await import('./tools/cli.js');
    const client = createClient(await remoteOptions(profile));
    console.log(JSON.stringify(await client.call('browsers.list'), null, 2)); return;
  }
  if (action === 'health' && name && !rest.length) {
    const profile = await getProfile(name);
    const { loadCredential } = await import('./tools/cli.js');
    const health = async (path, headers) => { const r = await fetch(`${profile.server}${path}`, { headers, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error(`${path} returned HTTP ${r.status}`); return r.json(); };
    let service, devices, error;
    try { service = await health('/health'); devices = await health('/browser/devices', { Authorization: `Bearer ${(await loadCredential(profile.credentialFile)).access_token}` }); }
    catch (e) { error = e.message; }
    const mine = devices?.find(d => d.name === profile.device);
    const ok = !error && !!mine?.connected && mine.grant?.active === true;
    console.log(JSON.stringify({ ok, service, device: profile.device, desktop: mine ? 'online' : 'offline', grant: mine?.grant ?? null, ...(error ? { error: `Gateway unreachable or unauthorized: ${error}` } : {}) }, null, 2));
    if (!ok) process.exitCode = 1; return;
  }
  throw new Error('Usage: remote list | check NAME | health NAME. Configure remote access with auth login.');
}
