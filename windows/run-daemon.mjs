// Hidden scheduled-task entry point. Keep metadata-only daemon output bounded.
import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { writePrivate, privateBrowserHome } from '../src/tools/private-store.js';

const log = join(homedir(), '.agent-browser', 'tools', 'daemon.log');
await privateBrowserHome();
// Retain recent audit output across restarts and set private permissions.
let tail = '';
try {
  const file = await open(log, 'r');
  try { const info = await file.stat(); const buffer = Buffer.alloc(Math.min(info.size, 2 * 1024 * 1024)); await file.read(buffer, 0, buffer.length, info.size - buffer.length); tail = buffer.toString('utf8'); }
  finally { await file.close(); }
} catch (e) { if (e.code !== 'ENOENT') throw e; }
await writePrivate(log, tail);
let size = statSync(log).size;
function record(chunk) {
  if (size + chunk.length > 2 * 1024 * 1024) {
    try { unlinkSync(`${log}.3`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (let n = 2; n >= 0; n--) {
      try { renameSync(n ? `${log}.${n}` : log, `${log}.${n + 1}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    size = 0;
  }
  appendFileSync(log, chunk, { mode: 0o600 }); size += chunk.length;
}
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/cli.js', import.meta.url)), 'daemon'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', record); child.stderr.on('data', record);
child.on('error', () => { record(Buffer.from('Daemon launch failed\n')); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
