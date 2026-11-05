import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm, mkdir, open, unlink, realpath } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { writePrivate } from './private-store.js';

export const identityPath = role => join(homedir(), '.agent-browser', 'tools', `${role}-identity.json`);
export const trustPath = () => join(homedir(), '.agent-browser', 'tools', 'paired-controllers.json');
export function fingerprint(cert) { return new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase(); }
export function publicIdentity(identity) { return { certificate: identity.certificate, fingerprint: fingerprint(identity.certificate) }; }
export async function loadIdentity(file) { const identity = JSON.parse(await readFile(file, 'utf8')); fingerprint(identity.certificate); if (!identity.key) throw new Error('Identity private key is missing'); return identity; }
export async function ensureIdentity(file) {
  try { return await loadIdentity(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  let lock;
  for (let i = 0; i < 100 && !lock; i++) {
    try { lock = await open(`${file}.lock`, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      try { return await loadIdentity(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
  }
  if (!lock) throw new Error('Identity creation is locked; inspect the owning local process before removing a stale lock');
  const dir = await mkdtemp(join(tmpdir(), 'browser-identity-'));
  try {
    if (process.platform === 'win32') execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    try { return await loadIdentity(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const openssl = process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl';
    execFileSync(openssl, ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '365', '-subj', '/CN=agent-browser.local', '-addext', 'subjectAltName=DNS:agent-browser.local'], { stdio: 'ignore', windowsHide: true });
    const identity = { key: await readFile(join(dir, 'key.pem'), 'utf8'), certificate: await readFile(join(dir, 'cert.pem'), 'utf8') };
    await writePrivate(file, identity); return identity;
  } finally {
    const target = await realpath(dir); const parent = await realpath(tmpdir());
    if (dirname(target) !== parent || !basename(target).startsWith('browser-identity-')) throw new Error('Unexpected identity scratch directory');
    await rm(target, { recursive: true, force: true }); await lock.close(); await unlink(`${file}.lock`);
  }
}
export async function readTrust(file = trustPath()) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
export async function pairController({ certificate, profiles = ['orin'], mode = 'inspect', origins = [], file = trustPath(), expires = Date.now() + 30 * 86400000 }) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(p => !/^[a-z][a-z0-9_-]{0,31}$/.test(p)) || !['inspect', 'interact', 'script'].includes(mode)) throw new Error('Invalid pairing policy');
  const id = fingerprint(certificate); const trust = await readTrust(file);
  if (!Array.isArray(origins) || origins.some(o => o !== '*' && new URL(o).origin !== o)) throw new Error('Expected exact allowed origins');
  trust[id] = { certificate, profiles, mode, origins, expires }; await writePrivate(file, trust); return id;
}
