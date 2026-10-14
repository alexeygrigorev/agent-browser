#!/usr/bin/env node
import { createBridge } from '../src/bridge.js';
import { createClient, getPort } from '../src/client.js';
import { readFile } from 'node:fs/promises';

const help = `Usage: agent-browser-bridge <command>

  serve                    Start the local bridge; the extension connects automatically
  status                   Check whether Chrome is connected
  call <method> [JSON]     Send a browser command (params default to {})
  call <method> --stdin    Read JSON params from standard input
  call <method> --params-file <path>  Read UTF-8 JSON params from a file
  mcp                      Run the MCP server over stdio

Environment: AGENT_BROWSER_PORT (default 19333)
Example: agent-browser-bridge call tabs.list`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['serve', 'status', 'call', 'mcp'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const port = getPort();
  if (command === 'serve') {
    const bridge = createBridge({ port, onDiagnostic: event => console.error(`[browser-bridge] ${JSON.stringify(event)}`) });
    await bridge.listen();
    console.log(`Browser bridge listening on http://127.0.0.1:${port}\nThe installed Chrome extension connects automatically.`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  const client = createClient({ port });
  if (command === 'mcp') { const { startMcp } = await import('../src/mcp.js'); await startMcp(client); return; }
  if (command === 'status') { console.log(JSON.stringify(await client.status(), null, 2)); return; }
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
