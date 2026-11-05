import { createHash } from 'node:crypto';

export function createAudit(sink = event => console.error(JSON.stringify(event)), now = Date.now) {
  let window = now(), count = 0, dropped = 0;
  return (event, fields = {}) => {
    if (now() - window > 60000) { if (dropped) sink({ event: 'audit_suppressed', count: dropped }); window = now(); count = 0; dropped = 0; }
    if (++count > 120) { dropped++; return; }
    const record = { time: new Date(now()).toISOString(), event };
    // Never log URLs, selectors, expressions, cookies, credentials or bodies.
    for (const key of ['role', 'device', 'profile', 'method', 'outcome', 'bytes', 'fingerprint']) if (fields[key] !== undefined) record[key] = String(fields[key]).slice(0, 100);
    if (fields.owner) record.principal = createHash('sha256').update(fields.owner).digest('hex').slice(0, 16);
    sink(record);
  };
}
