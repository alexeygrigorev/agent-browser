import { readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir, hostname } from 'node:os';
import { SignJWT, importPKCS8 } from 'jose';
import { deviceLogin } from '../../vendor/dtc-device-login.mjs';
import { deviceName, hash, secret } from './auth.js';
import { saveProfile } from '../remote.js';
import { ensureIdentity, loadIdentity, identityPath, publicIdentity } from './identity.js';
import { pairedFetch } from './paired-client.js';
import { writePrivate } from './private-store.js';

export const credentialPath = daemon => join(homedir(), '.agent-browser', 'tools', daemon ? 'daemon.json' : 'controller.json');
export function serverUrl(raw = 'https://tools.dtcdev.click') {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Server must be an HTTPS origin');
  return u.origin;
}
export async function loadCredential(file) {
  let c = JSON.parse(await readFile(file, 'utf8')); serverUrl(c.server);
  if (c.role === 'controller' && (!c.identityFile || !c.refresh_token)) throw new Error('Controller device-key login required; run auth login');
  if (c.role === 'controller' && c.refresh_token && c.expires < Date.now() + 60000) {
    const identity = await loadIdentity(c.identityFile); const key = await importPKCS8(identity.key, 'ES256');
    const proof = await new SignJWT({ htm: 'POST', htu: `${c.server}/api/auth/refresh`, grant_hash: hash(c.refresh_token), jti: secret() }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt' }).setIssuedAt().sign(key);
    const r = await fetch(`${c.server}/api/auth/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', DPoP: proof }, body: JSON.stringify({ refresh_token: c.refresh_token }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Device grant rejected; run auth login');
    // The device-bound renewal grant is non-rotating. Concurrent CLI processes
    // may issue overlapping short-lived access tokens without losing ownership.
    c = { ...c, ...await r.json() }; await writePrivate(file, c);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(c.access_token || '') || c.expires <= Date.now()) throw new Error('Credential expired; run auth login');
  return c;
}
export async function remoteOptions(profile) {
  const c = await loadCredential(profile.credentialFile);
  if (c.server !== profile.server || c.role !== 'controller') throw new Error('Remote credential does not match server/controller role');
  const identity = await loadIdentity(c.identityFile);
  return { baseUrl: `${profile.server}/browser/${profile.device}`, fetchImpl: pairedFetch({ server: c.server, device: profile.device, token: c.access_token, identity, daemonCertificate: c.daemonCertificate }) };
}
export async function runAuth(args) {
  const [action, ...rest] = args; const options = { server: 'https://tools.dtcdev.click', device: 'desktop' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--daemon') { options.daemon = true; continue; }
    const key = { '--server': 'server', '--device': 'device', '--name': 'name', '--label': 'label', '--credential-file': 'credentialFile', '--identity-file': 'identityFile', '--certificate-file': 'certificateFile', '--output': 'output' }[rest[i]];
    if (!key || !rest[i + 1]) throw new Error('Invalid auth option'); options[key] = rest[++i];
  }
  const file = options.credentialFile ? resolve(options.credentialFile) : credentialPath(options.daemon);
  const localIdentityFile = options.identityFile ? resolve(options.identityFile) : identityPath(options.daemon ? 'daemon' : 'controller');
  if (action === 'identity') {
    const identity = await ensureIdentity(localIdentityFile);
    if (options.output) await writePrivate(resolve(options.output), identity.certificate);
    console.log(JSON.stringify(publicIdentity(identity), null, 2)); return;
  }
  if (action === 'pair') {
    if (!options.certificateFile || options.daemon) throw new Error('Usage: auth pair --certificate-file PATH');
    const c = await loadCredential(file); const certificate = await readFile(options.certificateFile, 'utf8');
    const info = publicIdentity({ certificate });
    await writePrivate(file, { ...c, daemonCertificate: certificate }); console.log(`Desktop certificate pinned: ${info.fingerprint}`); return;
  }
  if (action === 'login') {
    const server = serverUrl(options.server); if (!deviceName(options.device)) throw new Error('Invalid device name');
    const identity = await ensureIdentity(localIdentityFile);
    console.log(`Local device identity: ${publicIdentity(identity).fingerprint}`);
    const result = await deviceLogin({ baseUrl: server,
      startBody: { role: options.daemon ? 'daemon' : 'controller', certificate: options.daemon ? undefined : identity.certificate, device: options.device, label: options.label || `${hostname()} · ${options.daemon ? 'desktop daemon' : 'browser CLI'}` },
      post: async (url, body) => { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); return { status: response.status, body: await response.json() }; },
    });
    if (!/^[A-Za-z0-9_-]{43}$/.test(result.access_token || '')) throw new Error('Invalid device credential');
    let previous = {};
    try { previous = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    await writePrivate(file, { ...result, server, identityFile: localIdentityFile, daemonCertificate: previous.server === server ? previous.daemonCertificate : undefined });
    if (!options.daemon) await saveProfile(options.name || options.device, { kind: 'tools', server, device: options.device, credentialFile: file });
    console.log(`Signed in as ${result.email} (${result.role}). Credential stored privately.`); return;
  }
  if (['status', 'logout'].includes(action)) {
    const credential = await loadCredential(file);
    const response = await fetch(`${credential.server}/api/auth/${action === 'logout' ? 'logout' : 'me'}`, { method: action === 'logout' ? 'POST' : 'GET', headers: { Authorization: `Bearer ${credential.access_token}` }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Authentication rejected (${response.status}); run auth login`);
    if (action === 'logout') { await unlink(file); console.log('Credential revoked and removed.'); } else console.log(JSON.stringify(await response.json(), null, 2)); return;
  }
  throw new Error('Usage: auth login|status|logout|identity|pair [--daemon] [--server HTTPS_ORIGIN] [--device desktop] [--certificate-file PATH]');
}
