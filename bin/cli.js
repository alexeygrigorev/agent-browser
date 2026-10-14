#!/usr/bin/env node
import { createBridge } from '../src/bridge.js';
import { createClient, getPort, getToken } from '../src/client.js';

const help = `Usage: agent-browser-bridge <command>

  serve                    Start the local bridge and show the pairing token
  status                   Check whether Chrome is connected
  call <method> [JSON]     Send a browser command (params default to {})
  mcp                      Run the MCP server over stdio

Environment: AGENT_BROWSER_PORT (default 19333), AGENT_BROWSER_TOKEN
Example: agent-browser-bridge call tabs.list`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) { console.log(help); return; }
  if (!['serve', 'status', 'call', 'mcp'].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
  const token = await getToken({ create: command === 'serve' });
  const port = getPort();
  if (command === 'serve') {
    const bridge = createBridge({ token, port });
    await bridge.listen();
    console.log(`Browser bridge listening on http://127.0.0.1:${port}\nPairing token: ${token}\nPaste this token into the Chrome extension. Keep it private.`);
    let closing = false;
    const close = async () => { if (closing) return; closing = true; await bridge.close(); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  const client = createClient({ token, port });
  if (command === 'mcp') { const { startMcp } = await import('../src/mcp.js'); await startMcp(client); return; }
  if (command === 'status') { console.log(JSON.stringify(await client.status(), null, 2)); return; }
  if (!args[0]) throw new Error('Usage: agent-browser-bridge call <method> [JSON params]');
  if (args.length > 2) throw new Error('Pass params as one quoted JSON argument');
  const result = await client.call(args[0], args[1] ? JSON.parse(args[1]) : {});
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
