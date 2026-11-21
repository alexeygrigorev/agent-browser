---
name: browser-control
description: Control existing signed-in local Chrome profiles through this repository's bridge, including named browsers, page interactions, screenshots, and silent video. Use remote-browser-control for agents on another computer.
---

Resolve the repository root as `../..` from this skill directory. Requires Node.js 22+, `npm install`, and the unpacked `extension` installed in the user's existing Chrome profile. After `npm link`, use `browser` from any directory; otherwise substitute `node /absolute/repo/path/bin/cli.js`. Prefer the simple CLI below for normal page work.

## Simple CLI workflow

```sh
browser --session task connect main
browser --session task open https://example.com
browser --session task click e3
browser --session task fill e8 "query"
browser --session task snapshot
browser --session task doctor
```

Use references actually returned by the latest snapshot, never the example numbers blindly. Omit `--session task` for the default session. `connect [profile]` starts a missing local bridge and selects the requested nickname or stable ID. Omitting the profile selects the only connected profile; ambiguity fails clearly. If Chrome is disconnected, open it and retry. An explicit selection never falls back to another profile. A deliberate Pause stays paused until the user resumes it.

`open` creates a fresh background tab. `open`, `click`, and `fill` return an updated snapshot after a bounded settle wait. `fill` replaces the field's contents. Simple `click eN` uses a synthetic page click; for controls requiring trusted input use the advanced tab-ID click/key commands below. Add trailing `--json` for structured output, for example `browser --session task snapshot --json`.

A session privately stores only its browser ID, optional remote alias, and tab ID under `~/.agent-browser/sessions/NAME.json`. It stores no page content, references, cookies, or credentials. Changing an explicit profile or remote invalidates the previous tab. Element references live only in the tab, belong to the latest snapshot, and are rejected after navigation, another snapshot, or removal/replacement of their target. Take a fresh snapshot after a stale-reference error.

After an action, the CLI follows one newly opened tab or authentication popup whose opener is the session tab. It does not switch to unrelated or pre-existing popups. Multiple new popups fail clearly: inspect `tabs.list` and use advanced tab-ID commands to select the correct one. A slow page may need another `snapshot`. If the action was performed but its snapshot failed, inspect before repeating it; do not resubmit a consequential action blindly.

`doctor [profile]` is read-only and does not change session metadata. `connect` verifies extension code and may reload stale code only through a bridge that advertises the atomic idle guard. That guard refuses to interrupt commands, recording, or teaching on the selected profile. Old bridges/extensions report a manual update step. `bridge.restartNeeded` requires an explicit bridge/desktop-daemon restart when tasks finish; never kill other work automatically. Neither command bypasses Pause, permissions, or remote grants.

## Advanced: select and inspect

```sh
node bin/cli.js browsers
node bin/cli.js --browser main browser
node bin/cli.js --browser main call tabs.list '{}'
```

Honor the requested nickname, such as `main` or `orin`, or stable browser ID. Use `--browser NAME_OR_ID` consistently; explicit selection fails rather than silently switching profiles. Rename only when requested: `node bin/cli.js --browser ID browser name main`.

One shared bridge on port 19333 supports multiple Chrome profiles concurrently. Install the same extension directory in each profile: do not copy it, edit ports, or start separate services. Each profile stores its own stable UUID. `browsers` lists aliases, including offline entries with `connected:false`. Assign any requested nickname using `--browser ID browser name NAME`; names are not limited to `main` and `orin`.

With multiple profiles connected, avoid unqualified `browser` or page commands unless testing ambiguity intentionally. Select the nickname/ID on each advanced command, or connect it in a named simple session. Different profiles can work concurrently; actions within one profile are serialized. Read the current checkout and CLI help rather than assuming the early single-profile version. After upgrading an older extension, reload it once in `chrome://extensions` to activate the UUID-capable worker; normal use needs no Connect click.

Get a tab ID from `tabs.list`, then `page.snapshot` for text and selectors. Use observed selectors for clicks/typing and inspect the result. Wait for navigation and asynchronous updates. Timeout/disconnect errors may follow an executed action: inspect before repeating consequential commands.

Agent-created, navigated, and inspected tabs in normal windows join a visible agent group named for the browser. `tabs.list` exposes `managed` and `groupId`, plus `windowId`, `windowType` and `windowFocused`. It covers every window in the selected profile. After clicking sign-in or another action that opens authentication, refresh `tabs.list` and find the new popup by URL/title and `openerTabId`; inspect and control its tab ID with the same page, navigation, and close commands. Do not keep inspecting the original tab while authentication is in a separate window. Popups remain in their original window without grouping. `groups.list` shows owned groups. To hand a tab back, call `groups.release` with `{tabId}`; this ungroups it where supported and detaches the debugger, including for ungrouped popups. Later page commands may manage it again. `groups.manage` takes `{tabId,title?,color?}` when explicitly managing a tab is needed; it returns `managed: false` for popup windows.

PowerShell-safe JSON:

```powershell
'{"tabId":123}' | node .\bin\cli.js --browser main call page.snapshot --stdin
'{"tabId":123,"selector":"#search","text":"query"}' | node .\bin\cli.js --browser main call page.type --stdin
'{"tabId":123,"selector":"#submit"}' | node .\bin\cli.js --browser main call page.click --stdin
```

Menus, hover cards, and side panels that ignore scripted clicks need real mouse input. Use these instead of `page.evaluate` clicks; coordinates are viewport CSS pixels (as in `getBoundingClientRect()`):

```sh
node bin/cli.js --browser main click 123 640 360
node bin/cli.js --browser main click 123 'button[aria-label="More"]' --button right
node bin/cli.js --browser main hover 123 'nav .account'
node bin/cli.js --browser main mouse move 123 200 300
node bin/cli.js --browser main mouse down 123
node bin/cli.js --browser main mouse move 123 400 300
node bin/cli.js --browser main mouse up 123
```

`click` brings a background tab to the front first (`activatedTab: true`), because Chrome ignores input in hidden tabs and downloads/form submits need that user activation; it errors if the target is covered or the tab stays hidden. `click` also takes `--count 2`. `mouse down|up` default to the last pointer point and take `--button`. Generic API forms: `page.click`, `page.hover`, `page.mouse` (`action` move/down/up). If they report `Unknown method`, the Chrome extension is outdated (the bridge forwards page methods unchanged). Run `--browser NAME extension reload`, and if that also says `Unknown method`, the extension needs one manual reload in `chrome://extensions` (or a Chrome restart).

Clicks re-resolve and confirm their target at press time and retry when the page re-renders (`attempts` in the result). To pick a row from a list that re-renders, use `click TAB 'li[role=option]' --text Germany` instead of coordinates from `page.evaluate`. A real click that produces no mouse events falls back to a synthetic MouseEvent sequence (`method: synthetic`; `--real` disables it). For keyboard input use `key TAB ArrowDown --count 2` / `key TAB Enter` / `type TAB 'Ger' --selector '#country' --keys`; these are trusted key events, unlike dispatched ones. `navigate TAB URL [--wait-for SELECTOR]` waits for the page (a Gmail thread deep link waits for the thread to render). Screenshots retry in place after a CDP timeout. After pulling, run `extension reload`.

## Which extension code is live

`--browser NAME extension` shows the extension version, its source hash (`extension.code`), and `extension.current` (true when it matches this checkout's `extension` directory). After a `git pull`, run `--browser NAME extension reload`: it reloads from disk, waits for the reconnect, and prints the new hash. If `bridge.restartNeeded` is true, the bridge process predates the pull and needs a restart. Reloading needs Developer mode on in `chrome://extensions`. It does not restart Chrome or close tabs.

For non-ASCII JSON on PowerShell 5.1, use a UTF-8 file with `--params-file params.json` or set `$OutputEncoding` to UTF-8. The repository README's Browser commands table covers navigation, keys, scrolling, evaluation, and CDP parameters.

## Screenshots and video

Upload a client-local file with `node bin/cli.js --browser main upload 123 'input[type=file]' ./report.pdf`; this stages it on the desktop and selects the input without submitting the form. Generic `page.upload` instead takes desktop-local paths. Download with `node bin/cli.js --browser main download URL --filename reports/report.pdf`, then `downloads wait DOWNLOAD_ID`. The returned absolute `filename` is on the Chrome computer. `downloads list` and `downloads info DOWNLOAD_ID` inspect state and saved paths.

Staged files are limited to 64 MiB each and retained in desktop `~/.agent-browser/uploads` for later form submission. Read only the requested client paths; generic upload validates explicit desktop paths rather than browsing the filesystem.

Use `downloads save DOWNLOAD_ID --output ./report.pdf` to transfer a completed browser download to a new client-local file. Existing outputs are not overwritten.

```sh
node bin/cli.js --browser main screenshot 123 --output screenshot.png
node bin/cli.js --browser main record start 123 --output demo.webm
node bin/cli.js --browser main record list
node bin/cli.js --browser main record stop RECORDING_ID
```

Screenshot files must not exist; missing parent folders are created; `.jpg`/`.jpeg` selects JPEG. Retain the recording ID and stop it when finished. Videos are silent WebM sampled from viewport frames, not audio or native screencasts. Desktop FFmpeg with `libvpx-vp9` must be on PATH or configured by `AGENT_BROWSER_FFMPEG`.

Existing logins permit real account actions; stay within the user's task. Local processes can control the connected browser, so keep the bridge on loopback. Do not export cookies or modify unrelated tabs to establish access.
