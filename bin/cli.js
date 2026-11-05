#!/usr/bin/env node
import { createBridge } from '../src/bridge.js';
import { createClient, getPort } from '../src/client.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const pointerUsage = {
  click: 'Usage: click <tabId> <selector>|<x> <y> [--button left|right|middle] [--count <n>]',
  hover: 'Usage: hover <tabId> <selector>|<x> <y>',
  mouse: 'Usage: mouse move <tabId> <selector>|<x> <y> | mouse down|up <tabId> [<selector>|<x> <y>] [--button left|right|middle]'
};

// Parses `<tabId> <selector>|<x> <y>` plus pointer flags into page.* params.
// A CSS selector cannot be two plain numbers, so two numeric arguments are coordinates.
function pointerParams(command, args) {
  const usage = pointerUsage[command];
  const rest = [...args];
  const params = {};
  if (command === 'mouse') {
    params.action = rest.shift();
    if (!['move', 'down', 'up'].includes(params.action)) throw new Error(usage);
  }
  const positional = [];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--button' && (command === 'click' || ['down', 'up'].includes(params.action)) && rest.length) params.button = rest.shift();
    else if (arg === '--count' && command === 'click' && /^[1-9][0-9]*$/.test(rest[0] || '')) params.clickCount = Number(rest.shift());
    else if (arg.startsWith('--')) throw new Error(usage);
    else positional.push(arg);
  }
  const [tab, ...target] = positional;
  if (!/^[0-9]+$/.test(tab || '')) throw new Error(usage);
  const number = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
  if (target.length === 2 && target.every(value => number.test(value))) { params.x = Number(target[0]); params.y = Number(target[1]); }
  else if (target.length === 1 && target[0].trim()) params.selector = target[0];
  else if (!(target.length === 0 && params.action && params.action !== 'move')) throw new Error(usage);
  return { tabId: Number(tab), ...params };
}

const help = `Usage: agent-browser-bridge [--browser <nickname-or-id>] <command>

  serve                    Start the local bridge; the extension connects automatically
  status                   Check whether Chrome is connected
  browser                  Show the connected browser identity
  browser name <nickname>  Save a nickname for the connected browser
  browsers                 List connected browsers
  extension [info]         Show the extension's version and code hash versus this bridge
  extension reload         Reload the unpacked extension from disk and wait for it to reconnect
  upload <tabId> <selector> <file...>  Upload files from this computer
  downloads [list|info <id>|wait <id>|start <URL> [--filename <relative>]]
  downloads save <id> --output <path>  Copy a completed download to this computer
  download <URL> [--filename <relative>]  Start a browser download
  screenshot <tabId> --output <path>  Save a PNG screenshot (new file; creates parent folders)
  click <tabId> <selector>|<x> <y> [--button left|right|middle] [--count <n>]
                           Click an element or viewport CSS pixel with real mouse input
  hover <tabId> <selector>|<x> <y>  Move the mouse over an element or viewport point
  mouse move <tabId> <selector>|<x> <y>  Move the mouse (held buttons drag)
  mouse down|up <tabId> [<selector>|<x> <y>] [--button <name>]  Press/release (default: last point)
  record start <tabId> [--output <path>]  Start a recording
  record stop <id>         Stop a recording
  teach start [--name <text>] [--no-audio] [--no-browser]  Record a desktop walkthrough: screen, voice,
                           mouse, keyboard, windows, plus Chrome details
  teach stop [--no-sync]   Stop, transcribe, build timeline.md, sync the bundle
  teach status | teach process <id>  Show the session, or rebuild a bundle
  remote list|check NAME    Inspect device-authenticated remote browser access
  auth login|status|logout [--daemon]  Sign in using the shared DTC device flow
  auth identity [--daemon] [--output PATH]  Export this machine's public pairing certificate
  auth pair --certificate-file PATH  Pin the desktop's independently verified certificate
  daemon trust --certificate-file PATH [--profiles orin] [--mode inspect|interact|script] [--origins ORIGINS]
  daemon untrust --fingerprint SHA256  Revoke a controller's local browser grant
  daemon [--credential-file PATH]  Publish this desktop over outbound TLS
  tools-server             Run the shared HTTPS gateway behind a local TLS proxy
  call <method> [JSON]     Send a browser command (params default to {})
  call <method> --stdin    Read JSON params from standard input
  call <method> --params-file <path>  Read UTF-8 JSON params from a file
  mcp                      Run the MCP server over stdio

call and mcp start the local bridge automatically when needed.

Global: --no-autostart (use an existing bridge only), --remote NAME
Environment: AGENT_BROWSER_PORT (default 19333), AGENT_BROWSER_NAME, AGENT_BROWSER_AUTOSTART=0
Example: agent-browser-bridge --browser main call tabs.list`;

async function main() {
  const argv = process.argv.slice(2);
  let browser;
  let remote;
  let autoStart = process.env.AGENT_BROWSER_AUTOSTART !== '0';
  while (['--browser', '--no-autostart', '--remote'].includes(argv[0])) {
    if (argv[0] === '--no-autostart') { autoStart = false; argv.shift(); continue; }
    if (argv[0] === '--remote') { remote = argv[1]; if (!remote || remote.startsWith('--')) throw new Error('Expected remote name'); argv.splice(0, 2); continue; }
    browser = argv[1];
    if (!browser || browser.startsWith('--')) throw new Error('Usage: --browser <nickname-or-id> <command>');
    argv.splice(0, 2);
  }
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['serve', 'status', 'call', 'mcp', 'browser', 'browsers', 'screenshot', 'record', 'remote', 'auth', 'daemon', 'tools-server', 'upload', 'downloads', 'download', 'click', 'hover', 'mouse', 'teach', 'extension'].includes(command)) throw new Error(`Unknown command: ${command}
${help}`);
  let port = getPort(), token, baseUrl, fetchImpl;
  if (command === 'auth') { const { runAuth } = await import('../src/tools/cli.js'); await runAuth(args); return; }
  if (command === 'daemon') {
    if (['trust', 'untrust'].includes(args[0])) { const { daemonPairing } = await import('../src/tools/daemon-cli.js'); await daemonPairing(args); return; }
    if (!(args.length === 0 || args.length === 2 && args[0] === '--credential-file')) throw new Error('Usage: daemon [--credential-file PATH]');
    const { credentialPath } = await import('../src/tools/cli.js'); const { runDaemon } = await import('../src/tools/daemon.js');
    await runDaemon({ credentialFile: args[1] || credentialPath(true), bridgePort: port }); return;
  }
  if (command === 'tools-server') {
    const { createToolsServer } = await import('../src/tools/server.js');
    const tools = await createToolsServer({ file: process.env.TOOLS_STATE_FILE, origin: process.env.TOOLS_ORIGIN || 'https://tools.dtcdev.click', clientId: process.env.TOOLS_AUTH_CLIENT_ID });
    await tools.listen(getPort(process.env.TOOLS_PORT || '19336')); console.log('Tools gateway listening on loopback');
    const stop = async () => { await tools.close(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); return;
  }
  if (command === 'remote') { const { remoteCommand } = await import('../src/remote.js'); await remoteCommand(args); return; }
  if (remote) {
    if (['serve', 'teach'].includes(command)) throw new Error('This command requires a local bridge');
    const { getProfile } = await import('../src/remote.js');
    const profile = await getProfile(remote);
    const { remoteOptions } = await import('../src/tools/cli.js');
    ({ baseUrl, fetchImpl } = await remoteOptions(profile));
    autoStart = false;
  }
  if (command === 'serve') {
    const bridge = createBridge({ port, onDiagnostic: event => {
      console.error(`[browser-bridge] ${JSON.stringify(event)}`);
      if (event.event === 'extension_mismatch') {
        const label = event.browser.name || event.browser.id;
        const running = event.extension.code ? `code ${event.extension.code.slice(0, 12)}` : 'code that predates the version handshake';
        const expected = event.extension.expected ? `this bridge's extension directory has ${event.extension.expected.slice(0, 12)}` : 'this bridge has a newer extension';
        console.error(`[browser-bridge] WARNING: browser ${label} runs extension ${running} (version ${event.extension.version ?? 'unknown'}), but ${expected}. ${event.extension.code ? `Run: agent-browser-bridge --browser ${label} extension reload` : 'Reload it once in chrome://extensions; later updates can use extension reload.'}`);
      }
    } });
    try { await bridge.listen(); }
    catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
    console.log(`Browser bridge listening on http://127.0.0.1:${port}\nThe installed Chrome extension connects automatically.`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === 'teach') { const { runTeach } = await import('../src/teach-cli.js'); await runTeach({ port, browser, autoStart }, args); return; }
  const active = command !== 'status';
  const client = createClient({ port, browser, token, baseUrl, fetchImpl, autoStart: active && autoStart, waitForConnection: active });
  if (command === 'mcp') { const { startMcp } = await import('../src/mcp.js'); await startMcp(client); return; }
  if (command === 'status') { console.log(JSON.stringify(await client.status(), null, 2)); return; }
  if (command === 'browsers') { console.log(JSON.stringify(await client.call('browsers.list'), null, 2)); return; }
  if (command === 'upload') {
    if (args.length < 3) throw new Error('Usage: upload <tabId> <selector> <file...>');
    console.log(JSON.stringify(await client.upload(Number(args[0]), args[1], args.slice(2)), null, 2));
    return;
  }
  if (command === 'downloads' || command === 'download') {
    const parts = command === 'download' ? ['start', ...args] : (args.length ? args : ['list']);
    const [action, value, flag, filename] = parts;
    if (action === 'save') {
      if (parts.length !== 4 || flag !== '--output') throw new Error('Usage: downloads save <id> --output <path>');
      console.log(JSON.stringify(await client.saveDownload(Number(value), filename), null, 2));
      return;
    }
    let params;
    if (action === 'list' && parts.length === 1) params = {};
    else if (['info', 'wait'].includes(action) && parts.length === 2 && Number.isInteger(Number(value))) params = { id: Number(value) };
    else if (action === 'start' && value && (parts.length === 2 || (parts.length === 4 && flag === '--filename'))) params = { url: value, ...(filename ? { filename } : {}) };
    else throw new Error('Usage: downloads [list|info <id>|wait <id>|start <URL> [--filename <relative>]]');
    console.log(JSON.stringify(await client.call(`downloads.${action}`, params), null, 2));
    return;
  }
  if (command === 'screenshot') {
    if (args.length !== 3 || args[1] !== '--output' || !Number.isInteger(Number(args[0]))) throw new Error('Usage: screenshot <tabId> --output <path>');
    const path = resolve(args[2]);
    await mkdir(dirname(path), { recursive: true });
    const format = /\.jpe?g$/i.test(path) ? 'jpeg' : 'png';
    const image = await client.call('page.screenshot', { tabId: Number(args[0]), format });
    const data = image.data || image.dataUrl?.split(',')[1];
    if (!data) throw new Error('Browser returned no screenshot data');
    await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx' });
    console.log(JSON.stringify({ path, format }));
    return;
  }
  if (['click', 'hover', 'mouse'].includes(command)) {
    const params = pointerParams(command, args);
    console.log(JSON.stringify(await client.call(command === 'mouse' ? 'page.mouse' : `page.${command}`, params), null, 2));
    return;
  }
  if (command === 'record') {
    let method, params;
    if (args[0] === 'start' && [2, 4].includes(args.length) && Number.isInteger(Number(args[1])) && (args.length === 2 || args[2] === '--output')) {
      method = 'recording.start'; params = { tabId: Number(args[1]), ...(args[3] ? { path: resolve(args[3]) } : {}) };
    } else if (args[0] === 'stop' && args.length === 2) { method = 'recording.stop'; params = { id: args[1] }; }
    else if (args[0] === 'list' && args.length === 1) { method = 'recording.list'; params = {}; }
    else throw new Error('Usage: record start <tabId> [--output <path>] | record stop <id> | record list');
    console.log(JSON.stringify(await client.call(method, params), null, 2));
    return;
  }
  if (command === 'extension') {
    if (!(args.length === 0 || (args.length === 1 && ['info', 'reload'].includes(args[0])))) throw new Error('Usage: extension [info|reload]');
    console.log(JSON.stringify(await client.call(`extension.${args[0] || 'info'}`), null, 2));
    return;
  }
  if (command === 'browser') {
    if (args.length && !(args.length === 2 && args[0] === 'name' && args[1].trim())) throw new Error('Usage: browser [name <nickname>]');
    const result = await client.call(args.length ? 'browser.rename' : 'browser.info', args.length ? { name: args[1] } : {});
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (!args[0]) throw new Error('Usage: agent-browser-bridge call <method> [JSON params]');
  let paramsText;
  if (args[1] === '--stdin') {
    if (args.length !== 2) throw new Error('Usage: call <method> --stdin');
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    paramsText = Buffer.concat(chunks).toString('utf8');
  } else if (args[1] === '--params-file') {
    if (args.length !== 3) throw new Error('Usage: call <method> --params-file <path>');
    paramsText = await readFile(args[2], 'utf8');
  } else {
    if (args.length > 2) throw new Error('Pass params as one quoted JSON argument, or use --stdin');
    paramsText = args[1];
  }
  let params = {};
  if (paramsText !== undefined) {
    try { params = JSON.parse(paramsText.replace(/^\uFEFF/, '')); }
    catch { throw new Error('Invalid JSON params. Use --stdin or --params-file to avoid shell quoting issues.'); }
  }
  const result = await client.call(args[0], params);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
