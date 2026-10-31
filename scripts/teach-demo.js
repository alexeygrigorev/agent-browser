#!/usr/bin/env node
// End-to-end teach recording demo of a desktop session on an X11 display
// (Linux, e.g. Xvfb plus a window manager), isolated from the person's own
// Chrome: a disposable Chromium profile with a copy of the extension on its
// own bridge port, a separate Tk "Accountant notes" app, mouse and keyboard
// input injected through XTest (seen by the recorder like real hardware), and
// synthetic narration (FFmpeg flite) played as the microphone.
//
// Usage: DISPLAY=:77 AGENT_BROWSER_PYTHON=<python with pynput, tkinter,
//   python-xlib, faster-whisper> node scripts/teach-demo.js [--port 19444]
//   [--sync <ssh-host>:<dir>]
// The bundle lands in AGENT_BROWSER_TEACH_DIR or ~/teach-recordings.
import { spawn, execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const port = Number(option('--port') || 19444);
const sync = option('--sync');
if (process.platform !== 'linux' || !process.env.DISPLAY) throw new Error('The scripted demo needs an X11 display (set DISPLAY, e.g. Xvfb :77 plus xfwm4)');
const python = process.env.AGENT_BROWSER_PYTHON || 'python3';
const ffmpeg = process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg';
const cli = resolve('bin/cli.js');
const helper = resolve('scripts/teach-demo-desktop.py');
const env = { ...process.env, AGENT_BROWSER_PORT: String(port), AGENT_BROWSER_PYTHON: python };
delete env.AGENT_BROWSER_NAME;

// Narration, placed at these seconds from the start; actions follow each line.
const script = [
  { at: 1, say: 'This is a desktop teach recording demo. I start in the browser, on the transactions test page.' },
  { at: 7, say: 'I type march into the search box, because the report is for March.' },
  { at: 13, say: 'Next I click open details. It opens the statement in a new tab.' },
  { at: 19, say: 'Back on the first tab, I press the export button.' },
  { at: 25, say: 'Now I switch to the notes app and write that the export is done.' },
  { at: 33, say: 'Finally I copy the note.' }
];
const length = 39;

const page = `<!doctype html><html><head><title>Teach demo transactions</title></head><body style="font: 18px sans-serif; margin: 30px">
<h1>Transactions (demo)</h1>
<form id="search" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Exported ' + document.getElementById('q').value;">
  <label for="q">Search</label> <input id="q" name="q" type="search" placeholder="Search transactions" style="font-size: 18px">
  <button id="export" type="submit" style="font-size: 18px">Export CSV</button>
</form>
<p><a id="details" href="/details" target="_blank">Open details</a></p>
<p id="result"></p></body></html>`;
const details = '<!doctype html><title>Statement details</title><h1>Statement details</h1><p>March statement.</p>';

async function narrate(dir) {
  const parts = [];
  for (const [index, line] of script.entries()) {
    const file = join(dir, `line${index}.wav`);
    await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${line.say.replace(/'/g, '')}':voice=slt`, file]);
    parts.push(file);
  }
  const output = join(dir, 'narration.wav');
  const delays = script.map((line, index) => `[${index}]aresample=16000,adelay=${line.at * 1000}|${line.at * 1000}[a${index}]`).join(';');
  const mix = `${delays};${script.map((_, index) => `[a${index}]`).join('')}amix=inputs=${script.length}:normalize=0,apad=whole_dur=${length}[out]`;
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...parts.flatMap(file => ['-i', file]), '-filter_complex', mix, '-map', '[out]', '-ac', '1', '-ar', '16000', output]);
  return output;
}

function teach(cliArgs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, '--no-autostart', 'teach', ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
    child.once('close', code => code === 0 ? resolveRun(JSON.parse(stdout)) : reject(new Error(`teach ${cliArgs.join(' ')} failed: ${stderr}`)));
  });
}
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
function lines(child) {
  const queue = [], waiting = [];
  createInterface({ input: child.stdout }).on('line', line => { const next = waiting.shift(); if (next) next(line); else queue.push(line); });
  return () => queue.length ? Promise.resolve(queue.shift()) : new Promise(resolveLine => waiting.push(resolveLine));
}

const work = await mkdtemp(join(tmpdir(), 'teach-demo-'));
let server, bridge, context, app, input;
try {
  const narration = await narrate(work);
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url === '/details' ? details : page); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const site = `http://127.0.0.1:${server.address().port}`;

  bridge = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'ignore' });
  const extension = join(work, 'extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['background.js', 'manifest.json']) {
    const path = join(extension, name);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', `127.0.0.1:${port}`));
  }
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium', headless: false, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-position=0,0', '--window-size=820,700', '--no-first-run']
  });
  const first = context.pages()[0] || await context.newPage();
  await first.goto(site);
  for (let i = 0; i < 100 && !(await fetch(`http://127.0.0.1:${port}/status`).then(r => r.json()).catch(() => ({}))).connected; i++) await wait(200);

  app = spawn(python, [helper, 'app'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const notes = JSON.parse(await lines(app)());
  input = spawn(python, [helper, 'input'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const reply = lines(input);
  const send = async command => { input.stdin.write(command + '\n'); await reply(); };
  // Calibrate page to screen coordinates with one click before recording.
  await first.evaluate(() => { window.addEventListener('click', event => { window.lastClick = [event.clientX, event.clientY]; }, { once: true }); });
  await send('click 400 400');
  let point;
  for (let i = 0; i < 20 && !point; i++) { await wait(150); point = await first.evaluate(() => window.lastClick); }
  if (!point) throw new Error('Calibration click did not reach the page');
  const [clientX, clientY] = point;
  const screen = selector => first.evaluate(([selector, dx, dy]) => {
    const rect = document.querySelector(selector).getBoundingClientRect();
    return [Math.round(dx + rect.x + rect.width / 2), Math.round(dy + rect.y + rect.height / 2)];
  }, [selector, 400 - clientX, 400 - clientY]);

  const started = await teach(['start', '--name', 'desktop demo walkthrough', '--audio-file', narration]);
  const t0 = Date.now();
  const at = async seconds => { const delay = t0 + seconds * 1000 - Date.now(); if (delay > 0) await wait(delay); };

  await at(4); await send(`click ${(await screen('h1')).join(' ')}`);
  await at(10); await send(`click ${(await screen('#q')).join(' ')}`); await send('type march');
  await at(16); await send(`click ${(await screen('#details')).join(' ')}`);
  await at(22); await send('combo Control_L 1'); await wait(700); await send(`click ${(await screen('#export')).join(' ')}`);
  await at(29); await send(`click ${notes.entry.join(' ')}`); await send('type March export done');
  await send(`click ${notes.button.join(' ')}`);
  await at(35); await send(`click ${notes.entry.join(' ')}`); await send('combo Control_L a'); await send('combo Control_L c');
  await at(length);

  const stopped = await teach(['stop', ...(sync ? ['--sync', sync] : ['--no-sync'])]);
  console.log(JSON.stringify({ id: started.id, ...stopped }, null, 2));
} finally {
  input?.stdin.end();
  app?.kill();
  await context?.close().catch(() => {});
  bridge?.kill();
  server?.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
