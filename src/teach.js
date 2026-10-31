import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';

export const teachRoot = () => resolve(process.env.AGENT_BROWSER_TEACH_DIR || join(homedir(), 'teach-recordings'));
export const validId = id => typeof id === 'string' && /^[\w][\w.-]{0,100}$/.test(id);

export function sessionId(name, date = new Date()) {
  const stamp = date.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  const slug = String(name || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-').slice(0, 40);
  return slug ? `${stamp}-${slug}` : stamp;
}

// The browser layer of a teach session, owned by the bridge: the extension
// pushes events here and they are written to <bundle>/events.jsonl. The
// teach CLI owns the session itself (desktop recorder, timeline, sync).
export function createTeach({ send, root = teachRoot, now = Date.now } = {}) {
  let session = null;
  const summary = item => ({ id: item.id, dir: item.dir, browserId: item.browserId, t0: item.t0, events: item.seq, screenshots: item.screenshots });
  function write(item, record) {
    item.writes = item.writes.then(() => appendFile(join(item.dir, 'events.jsonl'), JSON.stringify(record) + '\n'));
    return item.writes;
  }

  async function start({ browserId, id, t0, dir: bundle, name = '' } = {}) {
    if (session) throw new Error(`A teach session is already recording browser events: ${session.id}`);
    if (!validId(id) || !Number.isFinite(t0)) throw new Error('teach.start needs a recording id and t0');
    if (bundle !== undefined && (typeof bundle !== 'string' || !isAbsolute(bundle) || basename(bundle) !== id)) throw new Error('dir must be an absolute bundle path ending in the recording id');
    const dir = bundle ? resolve(bundle) : join(typeof root === 'function' ? root() : root, id);
    await mkdir(join(dir, 'screenshots'), { recursive: true });
    const item = { id, dir, browserId, t0, seq: 0, screenshots: 0, writes: Promise.resolve() };
    session = item;
    try {
      const result = await send(browserId, 'teach.start', { sessionId: id, t0 });
      await write(item, { seq: 0, source: 'browser', kind: 'session_start', ts: now(), time: new Date(now()).toISOString(), offsetMs: now() - t0, name, tabs: result?.tabs || [] });
    } catch (error) {
      session = null;
      if (/Unknown method: teach\./.test(error.message)) throw new Error('The Chrome extension does not support teach recording yet. Pull the latest agent-browser and reload the extension at chrome://extensions.');
      throw error;
    }
    return { ...summary(item), state: 'recording' };
  }

  async function ingest(browserId, message) {
    const item = session;
    if (!item || message.sessionId !== item.id || browserId !== item.browserId || !message.event || typeof message.event !== 'object') return;
    const event = { ...message.event };
    const seq = ++item.seq;
    const ts = Number.isFinite(event.ts) ? event.ts : now();
    const record = { seq, source: 'browser', ...event, ts, time: new Date(ts).toISOString(), offsetMs: ts - item.t0 };
    if (typeof message.screenshot === 'string' && message.screenshot) {
      const file = `screenshots/${String(seq).padStart(4, '0')}-${String(event.kind || 'event').replace(/[^\w-]/g, '')}.jpg`;
      item.screenshots++;
      record.screenshot = file;
      item.writes = item.writes.then(() => writeFile(join(item.dir, file), Buffer.from(message.screenshot, 'base64')));
    }
    await write(item, record);
  }

  async function stop({ browserId } = {}) {
    const item = session;
    if (!item) {
      // A restarted bridge forgets its session while the extension may still log.
      await send(browserId, 'teach.stop', {}).catch(() => {});
      return { state: 'idle' };
    }
    session = null;
    const notes = [];
    try { await send(item.browserId, 'teach.stop', { sessionId: item.id }); }
    catch (error) { notes.push(`Browser did not confirm the stop: ${error.message}`); }
    await item.writes.catch(error => notes.push(`Could not write browser events: ${error.message}`));
    return { ...summary(item), state: 'stopped', notes };
  }

  return {
    start, stop, ingest,
    status: () => session ? { ...summary(session), state: 'recording' } : { state: 'idle' },
    close: async () => { if (session) await stop(); }
  };
}
