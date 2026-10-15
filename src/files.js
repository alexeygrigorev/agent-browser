import { mkdir, open, unlink, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

export function createFiles({ directory = join(homedir(), '.agent-browser', 'uploads'), maxBytes = 64 * 1024 * 1024 } = {}) {
  return {
    async stage(source, name) {
      if (typeof name !== 'string' || !name || name.length > 200 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw new Error('Provide a portable filename without directories or reserved characters');
      const id = randomUUID();
      const folder = join(directory, id);
      const path = join(folder, name);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      let file, size = 0;
      try {
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
      }
    },
    async validate(paths) {
      if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== 'string' || !isAbsolute(path))) throw new Error('Upload files must be absolute paths on the bridge computer');
      await Promise.all(paths.map(async path => { if (!(await stat(path)).isFile()) throw new Error(`Upload must be a regular file: ${path}`); }));
      return paths;
    }
  };
}
