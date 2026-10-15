---
name: browser-control
description: Control existing signed-in local Chrome profiles through this repository's bridge, including named browsers, page interactions, screenshots, and silent video. Use remote-browser-control for agents on another computer.
---

Resolve the repository root as `../..` from this skill directory. Run commands there or substitute an absolute path to `bin/cli.js`. Requires Node.js 22+, `npm install`, and the unpacked `extension` installed in the user's existing Chrome profile.

Browser calls start the bridge automatically and wait up to 35 seconds for Chrome. No token, pairing, or popup click is needed. Temporary failures reconnect automatically. An explicit popup Pause stays paused until the user resumes it.

## Select and inspect

```sh
node bin/cli.js browsers
node bin/cli.js browser
node bin/cli.js --browser main call tabs.list '{}'
```

Honor the requested nickname, such as `main` or `orin`, or stable browser ID. Use `--browser NAME_OR_ID` consistently; explicit selection fails rather than silently switching profiles. Rename only when requested: `node bin/cli.js --browser ID browser name main`.

Get a tab ID from `tabs.list`, then `page.snapshot` for text and selectors. Use observed selectors for clicks/typing and inspect the result. Wait for navigation and asynchronous updates. Timeout/disconnect errors may follow an executed action: inspect before repeating consequential commands.

PowerShell-safe JSON:

```powershell
'{"tabId":123}' | node .\bin\cli.js --browser main call page.snapshot --stdin
'{"tabId":123,"selector":"#search","text":"query"}' | node .\bin\cli.js --browser main call page.type --stdin
'{"tabId":123,"selector":"#submit"}' | node .\bin\cli.js --browser main call page.click --stdin
```

For non-ASCII JSON on PowerShell 5.1, use a UTF-8 file with `--params-file params.json` or set `$OutputEncoding` to UTF-8. The repository README's Browser commands table covers navigation, keys, scrolling, evaluation, and CDP parameters.

## Screenshots and video

```sh
node bin/cli.js --browser main screenshot 123 --output screenshot.png
node bin/cli.js --browser main record start 123 --output demo.webm
node bin/cli.js --browser main record list
node bin/cli.js --browser main record stop RECORDING_ID
```

Screenshot files must not exist; `.jpg`/`.jpeg` selects JPEG. Retain the recording ID and stop it when finished. Videos are silent WebM sampled from viewport frames, not audio or native screencasts. Desktop FFmpeg with `libvpx-vp9` must be on PATH or configured by `AGENT_BROWSER_FFMPEG`.

Existing logins permit real account actions; stay within the user's task. Local processes can control the connected browser, so keep the bridge on loopback. Do not export cookies or modify unrelated tabs to establish access.
