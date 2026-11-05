import { mkdir, open, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
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
    if (process.platform === 'win32') execFileSync('icacls.exe', [temp, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:F`], { stdio: 'ignore', windowsHide: true });
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    await handle.sync(); await handle.close(); await rename(temp, file); await chmod(file, 0o600);
  } catch (error) { await handle.close().catch(() => {}); await unlink(temp).catch(() => {}); throw error; }
}
