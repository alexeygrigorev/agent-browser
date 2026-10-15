import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
export function createBrowserNames({ path = process.env.AGENT_BROWSER_NAMES_FILE || join(homedir(), '.agent-browser', 'browser-names.json') } = {}) {
  async function read() {
    try {
      const data = JSON.parse(await readFile(path, 'utf8'));
      if (data.version !== 1 || !data.names || typeof data.names !== 'object' || Array.isArray(data.names)) throw new Error('Invalid browser nickname file');
      return data;
    } catch (error) { if (error.code === 'ENOENT') return { version: 1, names: {} }; throw error; }
  }
  function update(fn) {
    const operation = (queues.get(path) || Promise.resolve()).catch(() => {}).then(async () => {
      const data = await read();
      const result = fn(data.names);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(() => {}); }
      return result;
    });
    queues.set(path, operation);
    return operation;
  }
  return {
    async get(id) { await queues.get(path)?.catch(() => {}); const data = await read(); return Object.hasOwn(data.names, id) ? data.names[id] : null; },
    async list() { await queues.get(path)?.catch(() => {}); return Object.entries((await read()).names).map(([id, name]) => ({ id, name })); },
    rename(id, name) {
      return update(names => {
        if (typeof id !== 'string' || !id || typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/i.test(name)) throw new Error('Use a nickname starting with a letter, followed by up to 31 letters, numbers, underscores or hyphens');
        const normalized = name.toLowerCase();
        if (Object.entries(names).some(([other, value]) => other !== id && value === normalized)) throw new Error(`Browser nickname already exists: ${normalized}`);
        Object.defineProperty(names, id, { value: normalized, configurable: true, enumerable: true, writable: true });
        return normalized;
      });
    },
    migrate(oldId, newId) {
      return update(names => {
        if (oldId === newId || Object.hasOwn(names, newId) || !Object.hasOwn(names, oldId)) return names[newId] || null;
        const name = names[oldId];
        Object.defineProperty(names, newId, { value: name, configurable: true, enumerable: true, writable: true });
        delete names[oldId];
        return name;
      });
    }
  };
}
