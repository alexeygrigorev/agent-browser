import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const extensionDir = fileURLToPath(new URL('../extension/', import.meta.url));
const repoDir = fileURLToPath(new URL('../', import.meta.url));
const fileName = /^[a-z0-9_-]+(?:\.[a-z0-9]+)+$/i;

// Must match hashCode() in extension/background.js: CRLF is normalized so a
// Windows checkout and a POSIX checkout of the same commit hash identically.
export function hashFiles(files, texts) {
  const hash = createHash('sha256');
  hash.update(files.map((file, index) => `${file}\0${texts[index].replace(/\r\n/g, '\n')}`).join('\0'));
  return hash.digest('hex');
}

// Hashes the files the extension reported, as they are on this machine's disk.
// Returns null when the list is unusable or a file is missing here.
export async function localCode(files, dir = extensionDir) {
  if (!Array.isArray(files) || !files.length || files.length > 64 || files.some(file => typeof file !== 'string' || !fileName.test(file))) return null;
  try { return hashFiles(files, await Promise.all(files.map(file => readFile(join(dir, file), 'utf8')))); }
  catch { return null; }
}

export function gitHead(dir = repoDir) {
  try { return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; }
  catch { return null; }
}

export function packageVersion() {
  try { return JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8')).version; }
  catch { return null; }
}
