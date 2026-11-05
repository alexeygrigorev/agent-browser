import { mkdir, open, rename, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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
