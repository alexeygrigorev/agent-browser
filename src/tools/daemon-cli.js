import { readFile } from 'node:fs/promises';
import { pairController, readTrust, trustPath } from './identity.js';
import { writePrivate, privateBrowserHome } from './private-store.js';

export async function daemonPairing(args) {
  await privateBrowserHome();
  const [action, ...rest] = args; const o = { profiles: 'orin', mode: 'inspect', origins: '' };
  for (let i = 0; i < rest.length; i += 2) {
    const key = { '--certificate-file': 'certificateFile', '--fingerprint': 'fingerprint', '--profiles': 'profiles', '--mode': 'mode', '--origins': 'origins' }[rest[i]];
    if (!key || !rest[i + 1]) throw new Error('Invalid pairing option'); o[key] = rest[i + 1];
  }
  if (action === 'trust' && o.certificateFile) {
    const id = await pairController({ certificate: await readFile(o.certificateFile, 'utf8'), profiles: o.profiles.split(','), mode: o.mode, origins: o.origins ? o.origins.split(',') : [] });
    console.log(`Controller paired locally: ${id}`); return;
  }
  if (action === 'untrust' && /^[a-f0-9]{64}$/.test(o.fingerprint || '')) { const trust = await readTrust(); delete trust[o.fingerprint]; await writePrivate(trustPath(), trust); console.log('Controller pairing revoked locally.'); return; }
  throw new Error('Usage: daemon trust --certificate-file PATH [--profiles orin] [--mode inspect|interact|script] [--origins HTTPS_ORIGIN,...] | daemon untrust --fingerprint SHA256');
}
