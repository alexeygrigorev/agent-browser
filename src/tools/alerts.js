// Server-side alerts for browser-service failures. The webhook URL is a secret:
// it is never logged and failures to deliver are reported without it.
export function createAlerts({ webhook, fetchImpl = fetch, cooldownMs = 600000, now = Date.now, sink = event => console.error(JSON.stringify(event)) } = {}) {
  const last = new Map();
  return async function alert(kind, message) {
    const at = now();
    if (at - (last.get(kind) ?? -Infinity) < cooldownMs) return false;
    last.set(kind, at);
    sink({ time: new Date(at).toISOString(), event: 'alert', kind, message });
    if (!webhook) return true;
    try {
      const r = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `[browser-service] ${kind}: ${message}` }), signal: AbortSignal.timeout(5000) });
      if (!r.ok) sink({ event: 'alert_delivery_failed', kind, status: r.status });
    } catch (error) { sink({ event: 'alert_delivery_failed', kind, error: error.name }); }
    return true;
  };
}
