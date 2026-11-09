import { createFileGate } from './gate.js';

const usage = 'Usage: gate grant <device> [--minutes N] [--label TEXT] | gate revoke <grant-id|device> | gate list  (file gate: TOOLS_GATE_FILE)';
export async function gateCommand(args, env = process.env) {
  if (!env.TOOLS_GATE_FILE) throw new Error('TOOLS_GATE_FILE is not set; this command manages the gateway host\'s file gate');
  const gate = createFileGate({ file: env.TOOLS_GATE_FILE });
  const [action, value, ...rest] = args;
  if (action === 'list') { console.log(JSON.stringify((await gate.list()).map(g => ({ ...g, expires: new Date(g.expires).toISOString(), created: new Date(g.created).toISOString() })), null, 2)); return; }
  if (action === 'revoke' && value) { console.log(JSON.stringify({ revoked: await gate.revoke(value) })); return; }
  if (action === 'grant' && value) {
    let minutes = 30, label = '';
    for (let i = 0; i < rest.length; i += 2) { if (rest[i] === '--minutes') minutes = Number(rest[i + 1]); else if (rest[i] === '--label') label = rest[i + 1] || ''; else throw new Error(usage); }
    const g = await gate.grant(value, minutes * 60000, label);
    console.log(JSON.stringify({ ...g, expires: new Date(g.expires).toISOString() })); return;
  }
  throw new Error(usage);
}
