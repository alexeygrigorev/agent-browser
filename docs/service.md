# Browser service: API, health, gate and alerts

The desktop Chrome profiles (`orin`, `main`) are reachable by remote agents only through the tools gateway
(`https://tools.dtcdev.click`) and only while a **Resource Gate** grant for the `browser` resource is active.
Access is never always-on: a controller tunnel is refused unless the gateway can confirm an unexpired grant
for that device at the moment the tunnel opens.

## Agent API (CLI)

```sh
node bin/cli.js remote health desktop                       # service + desktop + grant, exit 1 if not usable
node bin/cli.js --remote desktop --browser orin call tabs.list '{}'
node bin/cli.js --remote desktop --browser orin mcp
```

Command reference: [README](../README.md) and [remote-browser-control](../skills/remote-browser-control/SKILL.md).
Pairing and permission modes: [remote-security.md](remote-security.md).

## Health

| Check | Endpoint / command | Meaning |
| --- | --- | --- |
| Gateway up | `GET https://tools.dtcdev.click/health` (public) | `{ok, service, protocol, gate: "file"\|"http", devicesOnline}`; `devicesOnline` 0 means no desktop daemon is connected. |
| Desktop + grant | `GET /browser/devices` with a controller bearer, or `remote health NAME` | per device `{name, connected, grant: {active, expires} \| {active:false, reason}}`. |

`remote health` prints `ok:true` only if the gateway answers, the desktop is online and a grant is active.

## Resource Gate contract (`browser` plugin)

The gateway asks the gate on every controller tunnel (each CLI call opens one), before touching desktop state.
Anything but an explicit unexpired grant is refused with a visible reason; the gate being unreachable is also a
refusal (fail closed).

- `GET {TOOLS_GATE_URL}/v1/check?resource=browser&scope=<device>` with `Authorization: Bearer $TOOLS_GATE_TOKEN`
- `200 {"granted": true, "grant_id": "...", "expires_at": "<ISO-8601>"}` or `{"granted": false}`; any other status = gate error.
- Active tunnels are closed when the grant expires (tunnels last at most 120 s anyway).

Gateway configuration (`/etc/dtc-tools.env`, secrets from DataOps secrets, never printed or committed):

```text
TOOLS_GATE_URL=...  TOOLS_GATE_TOKEN=...     # Resource Gate (preferred)
TOOLS_GATE_FILE=/var/lib/dtc-tools/gate.json  # standalone grants managed on the gateway host
TOOLS_ALERT_WEBHOOK=...                       # optional, POST {"text": "..."}
```

`tools-server` refuses to start with neither gate setting. With the file gate, grants are managed on the gateway host:

```sh
node bin/cli.js gate grant desktop --minutes 15 --label "linkedin for Orin"   # 1 min .. 8 h
node bin/cli.js gate list
node bin/cli.js gate revoke <grant-id|desktop>
```

## Failure behavior

| Situation | Agent sees (within 15 s) | Server side |
| --- | --- | --- |
| No grant / expired / revoked | `Remote browser access refused (HTTP 403): No active Resource Gate grant for browser:desktop...` | audit `gate_denied` |
| Gate unreachable or broken | `... (HTTP 503): Resource Gate ... browser access is refused` | audit + alert `gate_unavailable` |
| Granted but desktop offline | `... (HTTP 503): Desktop browser (desktop) is offline...` | alert `desktop_offline` |
| Desktop daemon drops | next call as above | alert `desktop_disconnected` |
| Gateway unreachable | `Remote browser gateway unreachable within 15s` | none (use `/health` monitoring) |

Alerts are written to the gateway log as `{"event":"alert"}` and posted to `TOOLS_ALERT_WEBHOOK` when set;
each kind is rate-limited to one per 10 minutes. Never fall back to a local browser when access is refused.
