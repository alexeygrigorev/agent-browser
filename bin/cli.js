#!/usr/bin/env node
import { createBridge } from '../src/bridge.js';
import { createClient, getPort } from '../src/client.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const help = `Usage: agent-browser-bridge [--browser <nickname-or-id>] <command>

  serve                    Start the local bridge; the extension connects automatically
  status                   Check whether Chrome is connected
  browser                  Show the connected browser identity
  browser name <nickname>  Save a nickname for the connected browser
  browsers                 List connected browsers
  screenshot <tabId> --output <path>  Save a PNG screenshot (new file)
  record start <tabId> [--output <path>]  Start a recording
  record stop <id>         Stop a recording
  tunnel <ssh-host> [--remote-port <port>]  Forward this bridge to a remote host
  call <method> [JSON]     Send a browser command (params default to {})
  call <method> --stdin    Read JSON params from standard input
  call <method> --params-file <path>  Read UTF-8 JSON params from a file
  mcp                      Run the MCP server over stdio

call and mcp start the local bridge automatically when needed.

Global: --no-autostart (use an existing bridge or SSH tunnel only)
Environment: AGENT_BROWSER_PORT (default 19333), AGENT_BROWSER_NAME, AGENT_BROWSER_AUTOSTART=0
Example: agent-browser-bridge --browser main call tabs.list`;

async function main() {
  const argv = process.argv.slice(2);
  let browser;
  let autoStart = process.env.AGENT_BROWSER_AUTOSTART !== '0';
  while (['--browser', '--no-autostart'].includes(argv[0])) {
    if (argv[0] === '--no-autostart') { autoStart = false; argv.shift(); continue; }
    browser = argv[1];
    if (!browser || browser.startsWith('--')) throw new Error('Usage: --browser <nickname-or-id> <command>');
    argv.splice(0, 2);
  }
  const [command, ...args] = argv;
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['serve', 'status', 'call', 'mcp', 'browser', 'browsers', 'screenshot', 'record', 'tunnel'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const port = getPort();
  if (command === 'serve') {
    const bridge = createBridge({ port, onDiagnostic: event => console.error(`[browser-bridge] ${JSON.stringify(event)}`) });
    try { await bridge.listen(); }
    catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
    console.log(`Browser bridge listening on http://127.0.0.1:${port}\nThe installed Chrome extension connects automatically.`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (command === 'tunnel') {
    if (!args[0] || !(args.length === 1 || (args.length === 3 && args[1] === '--remote-port'))) throw new Error('Usage: tunnel <ssh-host> [--remote-port <port>]');
    const { startTunnel } = await import('../src/tunnel.js');
    await startTunnel(args[0], { port, remotePort: args[2] ? getPort(args[2]) : port, ensureBridge: autoStart });
    return;
  }
  const active = command !== 'status';
  const client = createClient({ port, browser, autoStart: active && autoStart, waitForConnection: active });
  if (command === 'mcp') { const { startMcp } = await import('../src/mcp.js'); await startMcp(client); return; }
  if (command === 'status') { console.log(JSON.stringify(await client.status(), null, 2)); return; }
  if (command === 'browsers') { console.log(JSON.stringify(await client.call('browsers.list'), null, 2)); return; }
  if (command === 'screenshot') {
    if (args.length !== 3 || args[1] !== '--output' || !Number.isInteger(Number(args[0]))) throw new Error('Usage: screenshot <tabId> --output <path>');
    const path = resolve(args[2]);
    const format = /\.jpe?g$/i.test(path) ? 'jpeg' : 'png';
    const image = await client.call('page.screenshot', { tabId: Number(args[0]), format });
    const data = image.data || image.dataUrl?.split(',')[1];
    if (!data) throw new Error('Browser returned no screenshot data');
    await writeFile(path, Buffer.from(data, 'base64'), { flag: 'wx' });
    console.log(JSON.stringify({ path, format }));
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
