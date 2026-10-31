---
name: teach-recording
description: Start or stop a teach recording of a person's own desktop walkthrough with voice (screen, mouse, keyboard, windows, optional Chrome page details), find the resulting bundle (timeline.md, screenshots, audio, transcript), and turn it into an SOP. Use when Alexey wants to show how he does a task, or when a teach bundle needs reading.
---

Resolve the repository root as `../..` from this skill directory. A teach session records what the person does: it never clicks or types itself. Do not drive the browser or desktop during someone else's session unless asked, because your actions would be recorded too.

## Start and stop

On Alexey's desktop DESKTOP-FP4OP26 (checkout `C:\Users\User\git\agent-browser`), he presses **Ctrl+Alt+F9** to start and **Ctrl+Alt+F10** to stop, or double-clicks **Teach - Start recording** / **Teach - Stop recording** on the Desktop (created by `windows\install-teach-shortcuts.ps1`). From a terminal he opened:

```sh
node bin/cli.js teach start --name "paypal monthly report"
node bin/cli.js teach stop
```

The recorder must start in Alexey's own desktop session; starting it over SSH or from an agent session on that machine records no screen or input. `teach start` lists each layer (microphone, screen, mouse/keyboard/windows, browser details) and why any is off. `teach status` shows the running session.

## Where the bundle lands

- Desktop: `C:\Users\User\teach-recordings\<id>\`.
- Hetzner: `~/tmp/teach-recordings/<id>/`, copied by `teach stop` over `ssh hetzner`; `teach stop` prints the path.

`<id>` is the UTC start time plus the name, for example `20261031-131407-paypal-monthly-report`. If sync or transcription failed, `timeline.md` says why; fix it and run `node bin/cli.js teach process <id>` on the desktop.

## Read a bundle and write the SOP

1. Read `timeline.md` first. `say` lines are Alexey's speech; other lines are actions. `(desktop)` actions come from the whole screen and name the app and window; the others come from Chrome with element names, selectors and tabs. Times are minutes:seconds from the start.
2. Use `timeline.json` for detail: each action has `said` (speech from 3 s before to 1 s after) and the full event. `manifest.json` has the state of each layer.
3. Open the linked screenshots when the wording is unclear: `d*.jpg` are desktop stills with a red box where he clicked; the others show the Chrome tab. `screen.mkv` is the full video at 3 frames per second.
4. Write the SOP as numbered steps: goal, starting app or URL, each step with what to click or type and why (from the speech), checks he mentions, and the output. Replace values specific to this run (dates, amounts) with what they mean. Leave out passwords; one-time codes in the log are expired, but never copy them into the SOP.

## Install or update on the desktop

```powershell
cd C:\Users\User\git\agent-browser; git pull; npm ci
C:\Users\User\.local\bin\python.exe -m pip install --user pynput faster-whisper uiautomation
powershell -ExecutionPolicy Bypass -File windows\install-teach-shortcuts.ps1
```

Then reload the Agent Browser Bridge extension once at `chrome://extensions` (or `node bin/cli.js extension reload` once a version with that command is loaded) and restart the bridge so it has the teach browser layer.
