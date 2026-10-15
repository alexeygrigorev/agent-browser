---
name: browser-control
description: Control existing signed-in local Chrome profiles through this repository's bridge, including named browsers, page interactions, screenshots, and silent video. Use remote-browser-control for agents on another computer.
---

Resolve the repository root as `../..` from this skill directory. Run commands there or substitute an absolute path to `bin/cli.js`. Requires Node.js 22+, `npm install`, and the unpacked `extension` installed in the user's existing Chrome profile.

Browser calls start the bridge automatically and wait up to 35 seconds for Chrome. No token, pairing, or popup click is needed. Temporary failures reconnect automatically. An explicit popup Pause stays paused until the user resumes it.

## Select and inspect

```sh
node bin/cli.js browsers
node bin/cli.js --browser main browser
node bin/cli.js --browser main call tabs.list '{}'
```

Honor the requested nickname, such as `main` or `orin`, or stable browser ID. Use `--browser NAME_OR_ID` consistently; explicit selection fails rather than silently switching profiles. Rename only when requested: `node bin/cli.js --browser ID browser name main`.

One shared bridge on port 19333 supports multiple Chrome profiles concurrently. Install the same extension directory in each profile: do not copy it, edit ports, or start separate services. Each profile stores its own stable UUID. `browsers` lists aliases, including offline entries with `connected:false`. Assign any requested nickname using `--browser ID browser name NAME`; names are not limited to `main` and `orin`.

With multiple profiles connected, avoid unqualified `browser` or page commands unless testing ambiguity intentionally. Select the nickname/ID on each command, or supply the MCP tool's `browser` property. Different profiles can work concurrently; actions within one profile are serialized. Read the current checkout and MCP tool definitions rather than assuming the early single-profile version. After upgrading an older extension, reload it once in `chrome://extensions` to activate the UUID-capable worker; normal use needs no Connect click.

Get a tab ID from `tabs.list`, then `page.snapshot` for text and selectors. Use observed selectors for clicks/typing and inspect the result. Wait for navigation and asynchronous updates. Timeout/disconnect errors may follow an executed action: inspect before repeating consequential commands.

Agent-created, navigated, and inspected tabs join a visible agent group named for the browser. `tabs.list` exposes `managed` and `groupId`; `groups.list` shows owned groups. To hand a tab back, call `groups.release` with `{tabId}`; this ungroups it and detaches the debugger. Later page commands may manage it again. `groups.manage` takes `{tabId,title?,color?}` when explicitly managing a tab is needed.

PowerShell-safe JSON:

```powershell
'{"tabId":123}' | node .\bin\cli.js --browser main call page.snapshot --stdin
'{"tabId":123,"selector":"#search","text":"query"}' | node .\bin\cli.js --browser main call page.type --stdin
'{"tabId":123,"selector":"#submit"}' | node .\bin\cli.js --browser main call page.click --stdin
```

For non-ASCII JSON on PowerShell 5.1, use a UTF-8 file with `--params-file params.json` or set `$OutputEncoding` to UTF-8. The repository README's Browser commands table covers navigation, keys, scrolling, evaluation, and CDP parameters.

## Screenshots and video

Upload a client-local file with `node bin/cli.js --browser main upload 123 'input[type=file]' ./report.pdf`; this stages it on the desktop and selects the input without submitting the form. Generic `page.upload` instead takes desktop-local paths. Download with `node bin/cli.js --browser main download URL --filename reports/report.pdf`, then `downloads wait DOWNLOAD_ID`. The returned absolute `filename` is on the Chrome computer. `downloads list` and `downloads info DOWNLOAD_ID` inspect state and saved paths.

Staged files are limited to 64 MiB each and retained in desktop `~/.agent-browser/uploads` for later form submission. Read only the requested client paths; generic upload validates explicit desktop paths rather than browsing the filesystem.

Use `downloads save DOWNLOAD_ID --output ./report.pdf` to transfer a completed browser download to a new client-local file. Existing outputs are not overwritten; MCP `downloads_save` supports the same transfer.

```sh
node bin/cli.js --browser main screenshot 123 --output screenshot.png
node bin/cli.js --browser main record start 123 --output demo.webm
node bin/cli.js --browser main record list
node bin/cli.js --browser main record stop RECORDING_ID
```

Screenshot files must not exist; `.jpg`/`.jpeg` selects JPEG. Retain the recording ID and stop it when finished. Videos are silent WebM sampled from viewport frames, not audio or native screencasts. Desktop FFmpeg with `libvpx-vp9` must be on PATH or configured by `AGENT_BROWSER_FFMPEG`.

Existing logins permit real account actions; stay within the user's task. Local processes can control the connected browser, so keep the bridge on loopback. Do not export cookies or modify unrelated tabs to establish access.
