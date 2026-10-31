import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
const ffmpegPath = () => process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg';
import { fileURLToPath } from 'node:url';

function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error) { error.stderr = `${stderr || ''}`; reject(error); } else resolve({ stdout: `${stdout}`, stderr: `${stderr}` });
    });
  });
}

export function pythonPath() {
  if (process.env.AGENT_BROWSER_PYTHON) return process.env.AGENT_BROWSER_PYTHON;
  if (process.platform === 'win32') {
    const local = join(homedir(), '.local', 'bin', 'python.exe');
    return existsSync(local) ? local : 'python';
  }
  return 'python3';
}

// Sync target as "<ssh-host>:<directory>"; the directory is relative to the
// remote home. Windows desktops default to Orin's Hetzner inbox.
export function syncTarget(value = process.env.AGENT_BROWSER_TEACH_SYNC) {
  if (value === undefined) return process.platform === 'win32' ? 'hetzner:tmp/teach-recordings' : null;
  if (!value || ['0', 'off', 'none', 'false'].includes(value.toLowerCase())) return null;
  const match = value.match(/^([\w.@-]+):(.+)$/);
  if (!match) throw new Error('Sync target must look like <ssh-host>:<remote-directory>');
  return value;
}

const clock = ms => {
  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(ms) / 1000;
  const minutes = Math.floor(total / 60);
  return `${sign}${String(minutes).padStart(2, '0')}:${(total - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

const host = url => { try { const parsed = new URL(url); return parsed.host + parsed.pathname; } catch { return url || ''; } };

const where = window => window?.app || window?.title ? ` in ${[window.app, window.title ? `"${window.title}"` : null].filter(Boolean).join(' ')}` : '';

export function describeAction(event) {
  const element = event.element;
  const label = element ? [element.role || element.tag, element.name ? `"${element.name}"` : null].filter(Boolean).join(' ') : '';
  if (event.source === 'desktop') {
    switch (event.kind) {
      case 'click': return `${event.button && event.button !== 'left' ? `${event.button[0].toUpperCase()}${event.button.slice(1)}-click` : 'Click'} ${label || `at ${event.x},${event.y}`}${where(event.window)}`;
      case 'type': return `Type ${JSON.stringify(event.text ?? '')}${where(event.window)}`;
      case 'key': return `Press ${[...(event.modifiers || []), event.key].join('+')}${where(event.window)}`;
      case 'scroll': return `Scroll ${event.dy < 0 ? 'down' : event.dy > 0 ? 'up' : 'sideways'}${where(event.window)}`;
      case 'window': return `Switch to${where(event.window).replace(/^ in/, '')}`;
      default: return event.kind;
    }
  }
  switch (event.kind) {
    case 'session_start': return `Browser layer started with ${event.tabs?.length || 0} open tab(s)`;
    case 'session_screenshot': return 'Browser tab at session start';
    case 'click': return `Click ${label}`;
    case 'type': return `Type ${JSON.stringify(event.value ?? '')} into ${label}`;
    case 'change': return `Set ${label} to ${JSON.stringify(event.value ?? '')}`;
    case 'submit': return `Submit form${element?.name ? ` "${element.name}"` : ''}${event.action ? ` (${event.action})` : ''}`;
    case 'key': return `Press ${[...(event.modifiers || []), event.key].join('+')}${label ? ` in ${label}` : ''}`;
    case 'copy': return `Copy ${JSON.stringify(event.text ?? '')}`;
    case 'navigation': return `Go to ${event.url} (${event.transition || 'navigation'})`;
    case 'page_loaded': return `Page loaded: "${event.title || ''}" ${event.url || ''}`;
    case 'tab_opened': return `New tab ${event.tabId}${event.openerTabId != null ? ` opened from tab ${event.openerTabId}` : ''}${event.url ? ` (${event.url})` : ''}`;
    case 'tab_activated': return `Switch to tab ${event.tabId} "${event.title || ''}"`;
    case 'tab_closed': return `Close tab ${event.tabId}`;
    case 'window_opened': return `New ${event.windowType || ''} browser window ${event.windowId}`.replace('  ', ' ');
    case 'window_closed': return `Close browser window ${event.windowId}`;
    default: return event.kind;
  }
}

const browserApp = window => /chrome|chromium|msedge|brave/i.test(window?.app || '');

// The desktop log sees every click and keystroke, the browser log the same
// actions with page detail. A desktop click, key or typing burst in the browser
// that matches a browser event is folded into it; typing that went into a
// password field is redacted from the desktop log too.
export function mergeLayers(events) {
  const browser = events.filter(event => event.source === 'browser');
  const result = [];
  for (const event of events) {
    if (event.source !== 'desktop') { result.push(event); continue; }
    if (event.kind === 'click' || event.kind === 'key') {
      const same = item => item.kind === event.kind && Math.abs(item.offsetMs - event.offsetMs) <= 600 && !item.desktop &&
        (event.kind === 'click' || item.key?.toLowerCase() === event.key?.toLowerCase());
      const match = browser.find(same);
      if (match) { match.desktop = { ...(event.kind === 'click' ? { x: event.x, y: event.y } : {}), window: event.window }; continue; }
    }
    if (event.kind === 'type' && browserApp(event.window)) {
      const end = event.endTs ? event.offsetMs + (event.endTs - event.ts) : event.offsetMs;
      const overlapping = browser.filter(item => item.kind === 'type' && item.offsetMs >= event.offsetMs - 1500 && item.offsetMs <= end + 2500);
      if (overlapping.some(item => item.value === '[password not recorded]')) event.text = '[password not recorded]';
      if (overlapping.length) continue;
    }
    result.push(event);
  }
  return result;
}

// Puts browser actions, desktop actions and speech on the session clock. Each
// action carries what was being said just before and during it (3 s before,
// 1 s after), so "I click here because..." sits next to the click it explains.
export function buildTimeline({ manifest, events, transcript }) {
  const audioOffset = manifest.audio?.startOffsetMs ?? 0;
  const speech = (transcript?.segments || []).map(segment => ({
    type: 'speech', offsetMs: Math.round(audioOffset + segment.start * 1000), endOffsetMs: Math.round(audioOffset + segment.end * 1000), text: segment.text
  }));
  const actions = mergeLayers(events).map(event => {
    const said = speech.filter(item => item.offsetMs <= event.offsetMs + 1000 && item.endOffsetMs >= event.offsetMs - 3000).map(item => item.text).join(' ');
    return { type: 'action', source: event.source || 'browser', offsetMs: event.offsetMs, kind: event.kind, summary: describeAction(event), ...(said ? { said } : {}), event };
  });
  const items = [...actions, ...speech].sort((a, b) => a.offsetMs - b.offsetMs || (a.type === 'speech' ? -1 : 1))
    .map(item => ({ ...item, time: new Date(manifest.t0 + item.offsetMs).toISOString(), clock: clock(item.offsetMs) }));
  return { version: 2, session: manifest, transcript: transcript ? { engine: transcript.engine, model: transcript.model, language: transcript.language, segments: speech.length } : null, items };
}

const layer = item => !item ? 'off' : `${item.status}${item.device ? ` from ${item.device}` : ''}${item.startOffsetMs !== undefined ? `, starts at ${clock(item.startOffsetMs)}` : ''}${item.reason ? ` — ${item.reason}` : ''}`;

export function renderMarkdown(timeline, { notes = [] } = {}) {
  const { session, items } = timeline;
  const actions = items.filter(item => item.type === 'action');
  const lines = [`# Teach recording: ${session.name || session.id}`, '',
    `- Recording: \`${session.id}\``,
    `- Started: ${session.startedAt}; ended: ${session.endedAt || 'unknown'}${session.durationMs ? ` (${clock(session.durationMs)})` : ''}`,
    `- Actions: ${actions.filter(item => item.source === 'desktop').length} desktop, ${actions.filter(item => item.source === 'browser').length} browser; screenshots: ${actions.filter(item => item.event.screenshot).length}`,
    `- Microphone: ${layer(session.audio)}`,
    `- Screen video: ${layer(session.screen)}${session.screen?.status === 'recorded' ? ' (screen.mkv)' : ''}`,
    `- Mouse, keyboard and windows: ${layer(session.hooks)}`,
    `- Browser details: ${layer(session.browser)}`,
    `- Transcript: ${timeline.transcript ? `${timeline.transcript.segments} segment(s), language ${timeline.transcript.language}, ${timeline.transcript.engine} ${timeline.transcript.model}` : 'none'}`];
  for (const note of notes) lines.push(`- Note: ${note}`);
  lines.push('', 'Times are minutes:seconds from the start of the session. **say** lines are speech; the others are actions. Desktop screenshots mark clicks with a red box.', '', '## Timeline', '');
  for (const item of items) {
    if (item.type === 'speech') { lines.push(`- \`${item.clock}\` **say** “${item.text}”`); continue; }
    const event = item.event;
    const tab = event.tabId !== undefined ? ` · tab ${event.tabId}${event.url && !['navigation', 'page_loaded'].includes(event.kind) ? ` · ${host(event.url)}` : ''}` : '';
    const selector = event.element?.selector ? ` · \`${event.element.selector}\`` : '';
    const screen = event.desktop?.x !== undefined ? ` · screen ${event.desktop.x},${event.desktop.y}` : event.source === 'desktop' && event.kind === 'click' ? ` · screen ${event.x},${event.y}` : '';
    const shot = event.screenshot ? ` · [screenshot](${event.screenshot})` : '';
    lines.push(`- \`${item.clock}\` **${event.kind}**${item.source === 'desktop' ? ' (desktop)' : ''} ${item.summary}${selector}${tab}${screen}${shot}`);
  }
  return lines.join('\n') + '\n';
}

export async function readEvents(dir) {
  const events = [];
  for (const [file, source] of [['events.jsonl', 'browser'], ['desktop-events.jsonl', 'desktop']]) {
    const text = await readFile(join(dir, file), 'utf8').catch(() => '');
    for (const line of text.split('\n')) if (line.trim()) events.push({ source, ...JSON.parse(line) });
  }
  return events.sort((a, b) => a.offsetMs - b.offsetMs || (a.source === b.source ? a.seq - b.seq : a.source === 'desktop' ? -1 : 1));
}

// Cuts a still from the screen video for desktop actions: just before a click
// (with a box at the pointer), after a window switch, and at Enter.
export async function desktopScreenshots(dir, events, manifest, { run = exec } = {}) {
  const video = join(dir, 'screen.mkv');
  if (manifest.screen?.status !== 'recorded' || !existsSync(video)) return 0;
  const origin = manifest.hooks?.screen || { x: 0, y: 0 };
  let made = 0;
  for (const event of events) {
    if (event.source !== 'desktop' || event.screenshot || !(event.kind === 'click' || event.kind === 'window' || (event.kind === 'key' && event.key === 'enter'))) continue;
    const at = (event.offsetMs - manifest.screen.startOffsetMs + (event.kind === 'click' ? -150 : event.kind === 'window' ? 600 : 0)) / 1000;
    if (at < 0) continue;
    const file = `screenshots/d${String(event.seq).padStart(4, '0')}-${event.kind}.jpg`;
    const filter = event.kind === 'click' ? ['-vf', `drawbox=x=${event.x - origin.x - 18}:y=${event.y - origin.y - 18}:w=36:h=36:color=red:t=4`] : [];
    if (!existsSync(join(dir, file))) {
      try { await run(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', video, '-frames:v', '1', ...filter, '-q:v', '4', '-n', join(dir, file)], { timeout: 60000 }); }
      catch { continue; }
    }
    event.screenshot = file;
    made++;
  }
  return made;
}

// Transcribes (when audio exists), writes timeline.json/.md and syncs the
// bundle. Each step records its own failure so one problem never hides the
// rest of the bundle.
export async function processBundle(dir, { transcribe = true, sync, python = pythonPath(), run = exec } = {}) {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
  const notes = [];
  let transcript = null;
  const audioPath = join(dir, 'audio.wav');
  const hasAudio = manifest.audio?.status === 'recorded' && await stat(audioPath).then(info => info.size > 44, () => false);
  if (!hasAudio) notes.push(`No audio to transcribe (${manifest.audio?.status}${manifest.audio?.reason ? `: ${manifest.audio.reason}` : ''})`);
  else if (transcribe) {
    try {
      await run(python, [fileURLToPath(new URL('../scripts/teach-transcribe.py', import.meta.url)), audioPath, join(dir, 'transcript.json')], { timeout: 60 * 60 * 1000 });
      transcript = JSON.parse(await readFile(join(dir, 'transcript.json'), 'utf8'));
    } catch (error) {
      notes.push(`Transcription failed: ${(error.stderr || error.message).trim().split('\n').slice(-3).join(' ')}. Re-run with: teach process ${manifest.id}`);
    }
  } else {
    transcript = await readFile(join(dir, 'transcript.json'), 'utf8').then(JSON.parse, () => null);
  }
  const events = mergeLayers(await readEvents(dir));
  await desktopScreenshots(dir, events, manifest, { run });
  const timeline = buildTimeline({ manifest, events, transcript });
  await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...timeline, notes }, null, 2) + '\n');
  await writeFile(join(dir, 'timeline.md'), renderMarkdown(timeline, { notes }));
  const result = { dir, timeline: join(dir, 'timeline.md'), transcript: transcript ? join(dir, 'transcript.json') : null, notes, synced: null };
  const target = sync === false ? null : syncTarget(sync === undefined || sync === true ? undefined : sync);
  if (target) {
    const [sshHost, remoteDir] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1).replace(/\/+$/, '')];
    const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
    try {
      await run('ssh', [...options, sshHost, `mkdir -p '${remoteDir.replace(/'/g, `'\\''`)}'`], { timeout: 60000 });
      await run('scp', [...options, '-r', '-q', dir, `${sshHost}:${remoteDir}/`], { timeout: 30 * 60 * 1000 });
      result.synced = `${sshHost}:${remoteDir.startsWith('/') || remoteDir.startsWith('~') ? '' : '~/'}${remoteDir}/${basename(dir)}/`;
    } catch (error) {
      notes.push(`Sync to ${target} failed: ${(error.stderr || error.message).trim()}`);
      await writeFile(join(dir, 'timeline.json'), JSON.stringify({ ...timeline, notes }, null, 2) + '\n');
      await writeFile(join(dir, 'timeline.md'), renderMarkdown(timeline, { notes }));
    }
  }
  return result;
}
