---
name: remote-browser-control
description: Let an agent on Hetzner or another SSH host control existing signed-in Chrome on the user's computer through a loopback reverse SSH tunnel. Use for remote agent access rather than local browser control.
---

Resolve the repository root as `../..` from this skill directory. Run commands there or supply an absolute `bin/cli.js` path. The desktop keeps Chrome and its unpacked extension; the remote host runs Node.js 22+ and this repository's CLI/MCP client. No remote browser or cookie export is needed.

## Desktop tunnel

With dependencies and the Chrome extension installed, use the user's SSH host alias:

```sh
node bin/cli.js tunnel hetzner
```

Keep this foreground desktop SSH session running. It starts the local bridge if necessary and forwards it to a loopback listener on the remote host. Use existing authorized SSH configuration; do not modify SSH server settings or expose a public bridge listener.

## Remote agent

Clone this repository and run `npm install` if needed. On the remote host:

```sh
node bin/cli.js --no-autostart browsers
node bin/cli.js --no-autostart --browser main call tabs.list '{}'
node bin/cli.js --no-autostart --browser orin call tabs.list '{}'
```

Always disable remote autostart with `--no-autostart` or `AGENT_BROWSER_AUTOSTART=0`: a failed tunnel must not launch an unrelated remote bridge. Honor the requested name/ID and fail rather than switch browsers. Restore the desktop SSH tunnel on connection failure.

The same single tunnel carries all Chrome profiles through one desktop bridge. Install the same extension directory in each desktop profile; each keeps an independent stable UUID. No copied extension, edited port, additional service, or additional tunnel is needed per profile. List with `browsers`, then assign requested aliases using `--no-autostart --browser ID browser name NAME`. Names can extend beyond `main` and `orin`; offline aliases remain listed with `connected:false`.

Select a nickname/ID on every remote command or MCP tool's `browser` property when multiple profiles are present. Different profiles support concurrent work; each profile serializes its own actions. Consult the current repository and tool definitions rather than assuming the initial single-profile implementation. An old desktop extension needs one reload after upgrading to activate UUID identity, not a Connect click during normal work.

For another remote port, run `tunnel hetzner --remote-port 19334` on the desktop and set `AGENT_BROWSER_PORT=19334` remotely. PowerShell: `$env:AGENT_BROWSER_PORT='19334'`. POSIX: `export AGENT_BROWSER_PORT=19334`.

## MCP and actions

Launch `node /absolute/repo/bin/cli.js --no-autostart --browser main mcp` remotely. Client environment can instead specify `AGENT_BROWSER_AUTOSTART=0`, `AGENT_BROWSER_PORT`, and `AGENT_BROWSER_NAME`. MCP tools accept a `browser` selector.

Use `tabs.list`, then `page.snapshot` with the tab ID before interacting. Preserve JSON with stdin in PowerShell:

```powershell
'{"tabId":123}' | node .\bin\cli.js --no-autostart --browser main call page.snapshot --stdin
```

Upload a remote-agent file with `node bin/cli.js --no-autostart --browser main upload 123 'input[type=file]' ./report.pdf`. The CLI transfers it through the tunnel and selects the desktop file input; submit the form separately if requested. MCP `page_upload` does the same staging. Generic `page.upload` requires desktop-local paths.

Each staged file may be up to 64 MiB. Copies remain in desktop `~/.agent-browser/uploads` for later submission; this transfers specific requested files, not general filesystem browsing access.

Download using `node bin/cli.js --no-autostart --browser main download URL`, then `downloads wait DOWNLOAD_ID` with the same global flags. Metadata's absolute `filename` belongs to the desktop Chrome computer, not the remote host.

Retrieve the bytes remotely with `node bin/cli.js --no-autostart --browser main downloads save DOWNLOAD_ID --output ./report.pdf`. This creates a new file on the remote agent's computer without overwriting existing files. MCP `downloads_save` performs the same transfer; do not treat Chrome's desktop path as a remote filesystem path.

The CLI supports `screenshot 123 --output shot.png` and `record start 123 --output demo.webm`, followed by `record stop RECORDING_ID`. Screenshots are saved on the CLI computer; recording paths belong to the desktop bridge computer. Silent sampled-frame WebM requires desktop FFmpeg with `libvpx-vp9` on PATH or `AGENT_BROWSER_FFMPEG`.

The trusted remote host's local processes gain browser control while the tunnel is open. Keep listeners on loopback and close the SSH session when finished. Existing accounts remain signed in; browser actions must stay within the user's task.
