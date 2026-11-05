---
name: remote-browser-control
description: Control the desktop's existing signed-in Chrome from another machine through tools.dtcdev.click, using shared DTC device login and an outbound desktop daemon.
---

Resolve the repository root as `../..` from this skill directory. Run commands
there or supply an absolute `bin/cli.js` path. The desktop keeps Chrome and the
extension; the controlling machine runs Node.js 22+ and this CLI/MCP client.

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
identity. Both roles expire after 30 days. Renew using device login, and revoke
from https://tools.dtcdev.click/browser or `auth logout` (`--daemon` for that role).

If offline, inspect the desktop task and gateway `dtc-tools.service` logs and
repair the failing side. Never display credential contents. The gateway runs on
the existing Frankfurt VM; deployment and the shared auth boundary for future
tool adapters are documented in `deploy/tools/README.md`. It is trusted to relay
browser data. Chrome profiles and cookies stay on the desktop.

## Browser selection and actions

Use `--browser NAME_OR_ID` on each command. Explicit selection fails rather than
switching profiles. One daemon carries all desktop profiles; never copy the
extension or profile directories, edit ports or start a daemon per profile.
Use `browsers`, then `tabs.list`, then `page.snapshot` before interacting. Inspect
the page before retrying a timed-out consequential action; it may have executed.
The visible agent cursor and click pulse follow real CDP pointer input.

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
(up to 64 MiB each); submission is a separate authorized page action. Download
metadata's absolute `filename` belongs to the desktop; `downloads save` writes a
new file on the controlling machine. Existing outputs are not overwritten.
Screenshots save on the controlling machine; recording paths belong to the
desktop bridge. Recording requires desktop FFmpeg. See README for all methods.

Existing logins permit real account actions; stay within the user's task.
Use Pause in the extension to stop access to that profile. Do not export cookies
or disturb unrelated tabs to establish access.
