import { mkdir, open, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Environment domain/user names can describe an SSH login rather than the
// Windows token running this process. icacls accepts a literal token SID.
export function currentWindowsPrincipal({ run = execFileSync } = {}) {
  let output;
  try {
    // Git for Windows also ships whoami.exe, which does not support these flags.
    const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    output = run(executable, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 5000 });
  } catch {
    throw new Error('Cannot determine the current Windows account SID; private storage was not granted to another account.');
  }
  const match = String(output).replace(/^\uFEFF/, '').trim().match(/^"(?:[^"]|"")*","(S-1-\d+(?:-\d+){1,15})"$/);
  if (!match) throw new Error('Cannot validate the current Windows account SID.');
  const parts = match[1].split('-').slice(2).map(value => BigInt(value));
  if (parts[0] > 281474976710655n || parts.slice(1).some(value => value > 4294967295n)) throw new Error('Cannot validate the current Windows account SID.');
  return `*${match[1]}`;
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${currentWindowsPrincipal()}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  else await chmod(directory, 0o700);
}
export async function privateBrowserHome() {
  const root = join(homedir(), '.agent-browser');
  await privateDirectory(root); await privateDirectory(join(root, 'tools'));
}

export async function writePrivate(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    if (process.platform === 'win32') execFileSync('icacls.exe', [temp, '/inheritance:r', '/grant:r', `${currentWindowsPrincipal()}:F`], { stdio: 'ignore', windowsHide: true });
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    await handle.sync(); await handle.close(); await rename(temp, file); await chmod(file, 0o600);
  } catch (error) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error; }
}
