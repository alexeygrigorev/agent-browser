import { mkdir, open, unlink, rmdir, stat, readdir, realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createFiles({ directory = join(homedir(), '.agent-browser', 'uploads'), maxBytes = 64 * 1024 * 1024, maxStoredBytes = Infinity, maxFiles = Infinity, retentionMs = Infinity, now = Date.now } = {}) {
  let reserved = 0, active = 0; const activeFolders = new Set();
  async function inventory() {
    await mkdir(directory, { recursive: true, mode: 0o700 }); let bytes = 0, count = 0;
    for (const folder of await readdir(directory, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^[a-f0-9-]{36}$/.test(folder.name)) continue;
      const parent = join(directory, folder.name);
      if (activeFolders.has(parent)) continue;
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(parent, entry.name); const info = await lstat(path);
        if (now() - info.mtimeMs > retentionMs) { await unlink(path); continue; }
        bytes += info.size; count++;
      }
      await rmdir(parent).catch(() => {});
    }
    return { bytes, count };
  }
  return {
    cleanup: inventory,
    async stage(source, name) {
      if (typeof name !== 'string' || !name || name.length > 200 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Provide a portable filename without directories or reserved characters');
      const id = randomUUID();
      const folder = join(directory, id);
      const path = join(folder, name);
      const usage = await inventory();
      if (usage.bytes + reserved + maxBytes > maxStoredBytes || usage.count + active >= maxFiles) throw Object.assign(new Error('Staged upload storage quota exceeded'), { statusCode: 429 });
      reserved += maxBytes; active++;
      activeFolders.add(folder);
      let file, size = 0;
      try {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        file = await open(path, 'wx', 0o600);
        const chunks = source.iterator ? source.iterator({ destroyOnReturn: false }) : source;
        for await (const value of chunks) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          size += chunk.length;
          if (size > maxBytes) { const error = new Error(`Upload exceeds ${maxBytes} bytes`); error.statusCode = 413; throw error; }
          await file.writeFile(chunk);
        }
        await file.close(); file = undefined;
        return { id, path, name, size };
      } catch (error) {
        await file?.close().catch(() => {});
        await unlink(path).catch(() => {});
        await rmdir(folder).catch(() => {});
        source.resume?.();
        throw error;
      } finally { reserved -= maxBytes; active--; activeFolders.delete(folder); }
    },
    async validate(paths) {
      if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Upload files must be absolute paths on the bridge computer');
      await Promise.all(paths.map(async path => { if (!(await stat(path)).isFile()) throw new Error(`Upload must be a regular file: ${path}`); }));
      return paths;
    },
    async validateStaged(paths) {
      if (!Array.isArray(paths) || !paths.length || paths.length > 32) throw new Error('Expected staged upload paths');
      const root = await realpath(directory);
      for (const path of paths) {
        if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Only staged uploads are allowed remotely');
        const actual = await realpath(path); const rel = relative(root, actual);
        if (!rel || rel.startsWith('..' + sep) || isAbsolute(rel) || rel.split(sep).length !== 2 || !/^[a-f0-9-]{36}$/.test(rel.split(sep)[0])) throw new Error('Only staged uploads are allowed remotely');
        const info = await stat(actual); if (!info.isFile() || now() - info.mtimeMs > retentionMs) throw new Error('Staged upload is missing or expired');
      }
      return paths;
    }
  };
}
