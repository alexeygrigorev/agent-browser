#!/usr/bin/env node
// End-to-end teach recording demo on a harmless local page, fully isolated
// from the person's own Chrome: a disposable Chromium profile, a copy of the
// extension on its own bridge port, and synthetic narration (Windows SAPI or
// FFmpeg flite) played as the "microphone" on the session clock.
//
// Usage: node scripts/teach-demo.js [--port 19444] [--no-sync]
// The bundle lands in the normal teach folder (AGENT_BROWSER_TEACH_DIR or
// ~/teach-recordings) and syncs like a real session.
import { spawn, execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';

const run = promisify(execFile);
const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 19444);
const noSync = args.includes('--no-sync');
const ffmpeg = process.env.AGENT_BROWSER_FFMPEG || 'ffmpeg';
const cli = resolve('bin/cli.js');
const env = { ...process.env, AGENT_BROWSER_PORT: String(port) };
delete env.AGENT_BROWSER_NAME;

// Narration and the action that follows each sentence, in seconds from the start.
const script = [
  { at: 1, say: 'This is a teach recording demo. First I look at the transactions test page.' },
  { at: 7, say: 'Now I type march into the search box, because the report is for March.' },
  { at: 13, say: 'Next I click open details. It opens the statement in a new tab.' },
  { at: 19, say: 'Finally I go back to the first tab and press the export button.' }
];

const page = `<!doctype html><html><head><title>Teach demo transactions</title></head><body>
<h1>Transactions (demo)</h1>
<form id="search" onsubmit="event.preventDefault(); document.getElementById('result').textContent = 'Exported ' + document.getElementById('q').value;">
  <label for="q">Search</label> <input id="q" name="q" type="search" placeholder="Search transactions">
  <label for="pin">PIN</label> <input id="pin" name="pin" type="password">
  <select id="month" name="month" aria-label="Month"><option>February</option><option>March</option></select>
  <button id="export" type="submit">Export CSV</button>
</form>
<p><a id="details" href="/details" target="_blank">Open details</a></p>
<p id="result"></p></body></html>`;
const details = '<!doctype html><title>Statement details</title><h1>Statement details</h1><p>March statement.</p>';

async function speak(dir) {
  const parts = [];
  for (const [index, line] of script.entries()) {
    const file = join(dir, `line${index}.wav`);
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}'); $s.Speak('${line.say.replace(/'/g, "''")}'); $s.Dispose()`;
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    } else {
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `flite=text='${line.say.replace(/'/g, '')}':voice=slt`, file]);
    }
    parts.push(file);
  }
  // Place each sentence at its moment; trailing silence covers the last actions.
  const output = join(dir, 'narration.wav');
  const inputs = parts.flatMap(file => ['-i', file]);
  const delays = script.map((line, index) => `[${index}]aresample=16000,adelay=${line.at * 1000 - 800}|${line.at * 1000 - 800}[a${index}]`).join(';');
  const mix = `${delays};${script.map((_, index) => `[a${index}]`).join('')}amix=inputs=${script.length}:normalize=0,apad=whole_dur=27[out]`;
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...inputs, '-filter_complex', mix, '-map', '[out]', '-ac', '1', '-ar', '16000', output]);
  return output;
}

function node(cliArgs) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [cli, ...cliArgs], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; process.stderr.write(data); });
    child.once('close', code => code === 0 ? resolveRun(stdout) : reject(new Error(`teach ${cliArgs.join(' ')} failed: ${stderr}`)));
  });
}
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

const work = await mkdtemp(join(tmpdir(), 'teach-demo-'));
let server, bridge, context;
try {
  const narration = await speak(work);
  server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(req.url === '/details' ? details : page); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const site = `http://127.0.0.1:${server.address().port}`;

  bridge = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'ignore', windowsHide: true });
  const extension = join(work, 'extension');
  await cp(resolve('extension'), extension, { recursive: true });
  for (const name of ['background.js', 'manifest.json']) {
    const path = join(extension, name);
    await writeFile(path, (await readFile(path, 'utf8')).replaceAll('127.0.0.1:19333', `127.0.0.1:${port}`));
  }
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium', headless: process.env.TEACH_DEMO_HEADED !== '1', viewport: { width: 1100, height: 700 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  const first = context.pages()[0] || await context.newPage();
  await first.goto(site);
  for (let i = 0; i < 100; i++) {
    const status = await fetch(`http://127.0.0.1:${port}/status`).then(response => response.json()).catch(() => ({}));
    if (status.connected) break;
    await wait(200);
  }

  const started = JSON.parse(await node(['--no-autostart', 'teach', 'start', '--name', 'demo popup walkthrough', '--audio-file', narration]));
  const t0 = Date.now();
  const at = async seconds => { const delay = t0 + seconds * 1000 - Date.now(); if (delay > 0) await wait(delay); };

  await at(3); await first.click('h1');
  await at(9); await first.click('#q'); await first.keyboard.type('march', { delay: 120 });
  await first.click('#pin'); await first.keyboard.type('1234');
  await first.selectOption('#month', 'March');
  await at(15);
  const [popup] = await Promise.all([context.waitForEvent('page'), first.click('#details')]);
  await popup.waitForLoadState();
  await at(21); await first.bringToFront(); await first.click('#export');
  await at(26);

  const stopped = JSON.parse(await node(['--no-autostart', 'teach', 'stop', ...(noSync ? ['--no-sync'] : [])]));
  console.log(JSON.stringify({ id: started.id, dir: stopped.dir, result: stopped.result }, null, 2));
} finally {
  await context?.close().catch(() => {});
  bridge?.kill();
  server?.close();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
