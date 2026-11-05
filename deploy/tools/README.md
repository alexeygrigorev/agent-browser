# Shared tools gateway

The Frankfurt VM hosts Node and Caddy. DNS and the Google-only public Cognito
client are defined in `DataTalksClub/aws-infra`, `sandbox/tools/template.yaml`.
Use the resulting ToolsClientId in `/etc/dtc-tools.env`:

```text
TOOLS_ORIGIN=https://tools.dtcdev.click
TOOLS_AUTH_CLIENT_ID=<public-client-id>
TOOLS_STATE_FILE=/var/lib/dtc-tools/state.json
TOOLS_PORT=19336
```

Install each verified Git release under `/opt/dtc-tools/releases/<commit>`;
run `npm ci --omit=dev`, update `/opt/dtc-tools/current` atomically, then restart
`dtc-tools.service`. Keep the previous release for rollback. The runtime user
`dtc-tools` owns `/var/lib/dtc-tools`; state must be mode 600, directory mode 700.
Back up this private state independently of source releases: it contains pending
OAuth transactions, hashed browser sessions and hashed revocable credentials.
Never put it in git or public artifacts. A rollback must preserve this state.

Caddy terminates public HTTPS on 443, renews its certificates using port 80 and
forwards HTTP/WebSocket traffic to the loopback application. Do not expose 19336
or the desktop bridge publicly. DNS is tools.dtcdev.click; no public browser
extension endpoint exists. The desktop authenticates its outbound WSS connection
using a separately approved daemon credential. Controller credentials cannot
publish a daemon; daemon credentials cannot control devices. Both are restricted
to the same verified user's devices. Controller access lasts 15 minutes and
renews with a device-key-bound 30-day grant; daemon credentials last 30 days.
Browser traffic uses independently pinned inner mutual TLS 1.3. Revocation
closes active tunnels; local unpairing independently closes inner connections.
See [pairing, permissions and migration](../../docs/remote-security.md) before
upgrading. Protocol 2 needs a coordinated controller/daemon upgrade and a fresh
controller device login. The gateway cannot decrypt browser traffic.

The common `/auth/*`, `/device` and `/api/auth/*` routes implement shared Cognito
SSO plus the DTC device-login contract. Browser transport is isolated under
`/browser/*`. Future tools such as PocketShell should register their own route
adapter and explicit credential scopes against this same auth layer; do not
grant browser credentials new tool permissions implicitly. No PocketShell
runtime is deployed by this change.

SSH is an infrastructure administration channel only. Browser traffic uses HTTPS/WSS.
