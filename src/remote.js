import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { getPort, createClient } from './client.js';

export const configFile = () => process.env.AGENT_BROWSER_REMOTE_CONFIG || join(homedir(), '.agent-browser', 'remotes.json');
const namePattern = /^[a-z][a-z0-9_-]{0,31}$/;
export function validateProfile(profile) {
  if (profile?.kind === 'tools') {
    const url = new URL(profile.server);
    if (url.protocol !== 'https:' || url.origin !== profile.server || !/^[a-z][a-z0-9_-]{0,31}$/.test(profile.device || '') || typeof profile.credentialFile !== 'string' || !profile.credentialFile) throw new Error('Invalid tools remote profile');
    return profile;
  }
  if (!profile || typeof profile !== 'object' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(profile.host || '')) throw new Error('Remote host must be an SSH alias or user@host');
  for (const key of ['port', 'remotePort', 'gatewayPort']) {
    if (!Number.isInteger(profile[key])) throw new Error(`Remote ${key} must be an integer`);
    getPort(profile[key]);
  }
  if (typeof profile.tokenFile !== 'string' || !profile.tokenFile) throw new Error('Remote tokenFile is required');
  if (profile.identityFile !== undefined && (typeof profile.identityFile !== 'string' || !profile.identityFile)) throw new Error('Invalid SSH identityFile');
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
export async function readToken(file) {
  const token = (await readFile(file, 'utf8')).trim();
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token)) throw new Error('Token must contain at least 256 bits (43 URL-safe characters)');
  return token;
}
export function remoteSshArgs(profile, mode) {
  validateProfile(profile);
  if (!['connect', 'publish'].includes(mode)) throw new Error('Expected connect or publish');
  return ['-N', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10',
    ...(profile.identityFile ? ['-i', profile.identityFile, '-o', 'IdentitiesOnly=yes'] : []),
    mode === 'publish' ? '-R' : '-L',
    mode === 'publish' ? `127.0.0.1:${profile.remotePort}:127.0.0.1:${profile.gatewayPort}` : `127.0.0.1:${profile.port}:127.0.0.1:${profile.remotePort}`, profile.host];
}

// The relay only carries SSH traffic. Authentication is enforced on the desktop,
// before any request reaches the bridge. No browser or credentials live on it.
export function createGateway({ token, bridgePort = 19333 }) {
  if (!/^[a-zA-Z0-9_-]{43,128}$/.test(token || '')) throw new Error('Invalid gateway token');
  const expected = Buffer.from(`Bearer ${token}`);
  const server = http.createServer(async (req, res) => {
    const deny = (status, message) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: message })); };
    const actual = Buffer.from(req.headers.authorization || '');
    if (req.headers.origin || req.headers['sec-fetch-site'] || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return deny(401, 'Remote authentication required');
    const path = req.url.split('?')[0];
    if (!((req.method === 'GET' && (path === '/status' || /^\/downloads\/[0-9]+\/file$/.test(path))) || (req.method === 'POST' && ['/command', '/files'].includes(path)))) return deny(404, 'Not found');
    const upstream = http.request({ hostname: '127.0.0.1', port: bridgePort, path: req.url, method: req.method,
      headers: { 'content-type': req.headers['content-type'] || 'application/json', ...(req.headers['content-length'] ? { 'content-length': req.headers['content-length'] } : {}) }, timeout: 45000 }, response => {
      res.writeHead(response.statusCode, { ...response.headers, 'cache-control': 'no-store' });
      pipeline(response, res).catch(() => {});
    });
    upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
    upstream.on('error', () => { if (!res.headersSent) deny(502, 'Desktop bridge unavailable; inspect page before retrying an action'); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    pipeline(req, upstream).catch(() => upstream.destroy());
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 60000;
  return server;
}

export async function runRemote(mode, profile, { reconnect = false } = {}) {
  if (profile.kind === 'tools') throw new Error('SSH tunnels are not needed for tools remotes. Start the desktop daemon and use --remote NAME.');
  const token = await readToken(profile.tokenFile);
  let gateway;
  if (mode === 'publish') {
    await createClient({ autoStart: true, waitForConnection: true }).call('browsers.list');
    gateway = createGateway({ token });
    await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(profile.gatewayPort, '127.0.0.1', done); });
  }
  let child, stopping = false;
  const stop = () => { stopping = true; child?.kill(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      console.error(`Remote ${mode}: connecting to ${profile.host} (loopback only)`);
      const code = await new Promise((done, fail) => {
        child = spawn('ssh', remoteSshArgs(profile, mode), { shell: false, windowsHide: true, stdio: 'inherit' });
        child.once('error', fail); child.once('exit', code => done(code));
      });
      if (!stopping && !reconnect && code !== 0) throw new Error(`SSH disconnected (${code})`);
      if (!stopping && reconnect) await delay(3000);
    } while (reconnect && !stopping);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    if (gateway) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)); }
  }
}

export async function remoteCommand(args) {
  const [action, name, ...rest] = args;
  if (action === 'list' && !name) { console.log(JSON.stringify(await readProfiles(), null, 2)); return; }
  if (action === 'add' && name) {
    const profile = { port: 19335, remotePort: 19334, gatewayPort: 19334 };
    const flags = { '--host': 'host', '--port': 'port', '--remote-port': 'remotePort', '--gateway-port': 'gatewayPort', '--identity': 'identityFile', '--token-file': 'tokenFile' };
    for (let i = 0; i < rest.length; i += 2) {
      const key = flags[rest[i]];
      if (!key || !rest[i + 1]) throw new Error('Invalid remote add option');
      profile[key] = key.endsWith('Port') || key === 'port' ? getPort(rest[i + 1]) : key.endsWith('File') ? resolve(rest[i + 1]) : rest[i + 1];
    }
    await saveProfile(name, profile); console.log(`Saved remote ${name}`); return;
  }
  if (['connect', 'publish', 'check'].includes(action) && name && (rest.length === 0 || rest.length === 1 && rest[0] === '--reconnect')) {
    const profile = await getProfile(name);
    if (action === 'check') {
      let options = { port: profile.port };
      if (profile.kind === 'tools') {
        const { loadCredential } = await import('./tools/cli.js'); const c = await loadCredential(profile.credentialFile);
        if (c.server !== profile.server || c.role !== 'controller') throw new Error('Remote credential does not match server/controller role');
        options = { baseUrl: `${profile.server}/browser/${profile.device}`, token: c.access_token };
      } else options.token = await readToken(profile.tokenFile);
      console.log(JSON.stringify(await createClient(options).call('browsers.list'), null, 2)); return;
    }
    await runRemote(action, profile, { reconnect: rest[0] === '--reconnect' }); return;
  }
  throw new Error('Usage: remote list | add NAME --host SSH_HOST --token-file PATH [--identity PATH] [--port N] [--remote-port N] [--gateway-port N] | connect|publish NAME [--reconnect] | check NAME');
}
