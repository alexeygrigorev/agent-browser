---
name: teach-recording
description: Start or stop a teach recording of a person's own Chrome walkthrough with voice, find the resulting bundle (timeline.md, screenshots, audio, transcript), and turn it into an SOP. Use when Alexey wants to show how he does a browser task, or when a teach bundle needs reading.
---

Resolve the repository root as `../..` from this skill directory. A teach session records what the person does in Chrome: it never clicks or types itself. Do not drive the browser during someone else's session unless asked, because your actions would be recorded too.

## Start and stop

On the computer with Chrome (Alexey's desktop DESKTOP-FP4OP26, checkout `C:\Users\User\git\agent-browser`):

```sh
node bin/cli.js teach start --name "paypal monthly report"
node bin/cli.js teach stop
```

Alexey can instead double-click **Teach - Start recording** and **Teach - Stop recording** on his Desktop (created by `windows\install-teach-shortcuts.ps1`; they run `windows\teach-start.cmd` and `windows\teach-stop.cmd`).

From Hetzner, while the desktop runs `node bin/cli.js tunnel hetzner`, the same commands work remotely with `--no-autostart` before `teach`. `teach status` shows the running session.

`teach start` prints the microphone it uses or, if there is none, the exact reason (for example Windows blocking desktop apps from the microphone). Actions are still recorded without audio. `--no-audio` skips the microphone.

## Where the bundle lands

- Desktop: `%USERPROFILE%\teach-recordings\<id>\` (`C:\Users\User\teach-recordings\<id>\`).
- Hetzner: `~/tmp/teach-recordings/<id>/`, copied by `teach stop` over `ssh hetzner`; `teach stop` prints the path.

`<id>` is the UTC start time plus the name, for example `20261031-131407-paypal-monthly-report`. If sync or transcription failed, `timeline.md` says why; fix it and run `teach process <id>` on the desktop.

## Read a bundle and write the SOP

1. Read `timeline.md` first. `say` lines are Alexey's speech; other lines are actions with element names, CSS selectors, tab IDs and screenshot links. Times are minutes:seconds from the start.
2. Use `timeline.json` for detail: each action has `said` (speech from 3 s before to 1 s after it) and the full event (URL, title, element role, accessible name, id, name, selector, bounding box). `events.jsonl` is the raw log; `manifest.json` has session times and audio status.
3. Open the linked `screenshots/*.jpg` when the wording is unclear; they show the visible tab at clicks, submits, page loads and tab switches.
4. Write the SOP as numbered steps: goal, where to start (URL), each step with what to click or type and why (from the speech), checks Alexey mentions, and the output. Replace typed values that are specific to this run (dates, amounts) with what they mean. Leave out passwords; one-time codes in the log are expired, but never copy them into the SOP.
