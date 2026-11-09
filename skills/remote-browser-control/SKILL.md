---
name: remote-browser-control
description: Control the desktop's existing signed-in Chrome from another machine through tools.dtcdev.click, using shared DTC device login and an outbound desktop daemon.
---

Resolve the repository root as `../..` from this skill directory. Run commands
there or supply an absolute `bin/cli.js` path. The desktop keeps Chrome and the
extension; the controlling machine runs Node.js 22+ and this CLI/MCP client.

## Resource Gate grant first

Remote browser access is granted per request through the Resource Gate, never always-on.
Check with `node bin/cli.js remote health desktop` (exit 1 when the desktop is offline or no
grant is active). `Remote browser access refused (HTTP 403)` means no grant: ask Alexey to approve
one, do not retry in a loop and never use another browser. HTTP 503 offline errors raise a server
alert already. Details: `docs/service.md`.

## Authenticate a controlling machine

```sh
node bin/cli.js auth login --device desktop
node bin/cli.js auth status
node bin/cli.js remote check desktop
node bin/cli.js --remote desktop --browser orin call tabs.list '{}'
```

The CLI prints a verification URL and code. Open that URL in the trusted browser,
sign in through the shared DTC Google/Cognito login, verify the request label and
role, then approve only the code for the login you started. Each machine gets its
own private, revocable credential. Do not copy credentials between machines.
Before browser access, independently pair public certificates using
`docs/remote-security.md`. Device login alone cannot grant browser access.
Never learn initial certificate pins from the gateway or transfer private keys.
`--server` chooses another HTTPS gateway; `--name` chooses the saved remote alias.

`--remote NAME` loads the HTTPS endpoint and controller credential-file location
from `~/.agent-browser/remotes.json`. It authenticates every request and disables
local bridge autostart. Never fall back to a local browser, another profile, an
unauthenticated endpoint or SSH when remote access fails.

## Desktop daemon

The desktop authorizes its separate publication credential once:

```sh
node bin/cli.js auth login --daemon --device desktop
node bin/cli.js daemon
```

Keep `daemon` running under the desktop's logged-in user; it reconnects over
outbound WSS. No SSH tunnel or persistent process on the controlling machine is
needed. The installed Windows task is **Agent Browser Daemon**. The desktop must
be awake, signed in and running Chrome. A daemon credential can publish only its
named device; a controller can access only devices owned by the same signed-in
identity. Controller access lasts 15 minutes and auto-renews with a device-key-
bound 30-day grant. Daemon credentials and local pairing grants last 30 days.
Renew using device login and explicit local pairing, and revoke
from https://tools.dtcdev.click/browser or `auth logout` (`--daemon` for that role).

If offline, inspect the desktop task and gateway `dtc-tools.service` logs and
repair the failing side. Never display credential contents. The gateway runs on
the existing Frankfurt VM; deployment and the shared auth boundary for future
tool adapters are documented in `deploy/tools/README.md`. Independently pinned
inner mutual TLS protects browser data from the relay. Chrome profiles and
cookies stay on the desktop.

## Browser selection and actions

Use `--browser orin` on each command. Main requires a separate explicit local
grant and credential; never use it as an automatic fallback. Explicit selection fails rather than
switching profiles. One daemon carries all desktop profiles; never copy the
extension or profile directories, edit ports or start a daemon per profile.
Use `browsers`, then `tabs.list`, then `page.snapshot` before interacting. Inspect
the page before retrying a timed-out consequential action; it may have executed.
The visible agent cursor and click pulse follow real CDP pointer input.

After a sign-in click, refresh `tabs.list`: it lists all windows in the selected
profile, including authentication popups. Use `windowType`, `windowId` and
`openerTabId` to find the popup, then inspect and control its own tab ID.
`windowFocused` helps identify which window is visible. Popup windows remain
ungrouped in their original window; `groups.release` still detaches control.
This does not grant access to another profile.

```sh
node bin/cli.js --remote desktop --browser orin click TAB_ID SELECTOR
node bin/cli.js --remote desktop --browser orin hover TAB_ID X Y
node bin/cli.js --remote desktop --browser orin screenshot TAB_ID --output shot.png
node bin/cli.js --remote desktop --browser orin upload TAB_ID 'input[type=file]' ./report.pdf
node bin/cli.js --remote desktop --browser orin download URL
node bin/cli.js --remote desktop --browser orin downloads wait DOWNLOAD_ID
node bin/cli.js --remote desktop --browser orin downloads save DOWNLOAD_ID --output ./report.pdf
node bin/cli.js --remote desktop --browser orin extension
node bin/cli.js --remote desktop --browser orin mcp
```

Uploads stream files from the controlling machine and stage them on the desktop
(up to 64 MiB each); submission is a separate authorized page action.
Only staged uploads are allowed remotely: never pass arbitrary desktop paths.
Staging has a 512 MiB/128-file quota and 24-hour retention. Raw CDP, teaching,
recording and extension reload are blocked remotely; page evaluation requires
an explicit script grant. General Orin interaction remains enabled.
Download metadata's absolute `filename` belongs to the desktop; `downloads save` writes a
new file on the controlling machine. Existing outputs are not overwritten.
Screenshots save on the controlling machine. See README for all methods.

Existing logins permit real account actions; stay within the user's task.
Use Pause in the extension to stop access to that profile. Do not export cookies
or disturb unrelated tabs to establish access.
