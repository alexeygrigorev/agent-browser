# Teach recording: design decision

Goal: Alexey records a walkthrough with his voice; Orin turns the bundle into a DataOps SOP. This replaces the Loom plus Grace flow.

## Is the browser extension enough?

No. Alexey's tasks (t1256u) span the whole Windows desktop, not only Chrome. The extension cannot see other apps or the microphone, so the recording has two layers on one clock:

1. **Desktop core** (`src/teach-recorder.js`, started by `teach start` in Alexey's own desktop session):
   - Screen video with FFmpeg `gdigrab` (X11 `x11grab` on Linux) at 3 frames per second, H.264 with `-tune zerolatency` so its start time is known. Screenshots for actions are cut from the video afterwards, with a red box at each click.
   - Microphone with FFmpeg DirectShow. If there is none, the reason is reported from the device list and the Windows microphone privacy settings, and the other layers keep recording.
   - Mouse, keyboard and foreground window through `scripts/teach-hooks.py` (pynput low-level hooks, Win32 `GetForegroundWindow`, optional UI Automation for the name of the clicked control).
   - FFmpeg's progress output places the first audio sample and video frame on the session clock; hooks and the extension stamp events with the same computer clock.
2. **Browser layer** (optional): the existing extension, updated with an observe-only content script and `chrome.tabs.captureVisibleTab`. The old way of watching pages, `chrome.debugger`, shows a banner on every tab and moves tabs into the agent's group, so it was not used. The bridge writes these events into the same bundle; processing folds a desktop click, key or typing burst into the matching browser event.

The pieces are standard and run in user scope: FFmpeg (already installed), Python packages installed with `pip --user`, Node.js. No admin rights, services or paid APIs.

## Start, stop and processing

`teach start` (or the Ctrl+Alt+F9 Desktop shortcut) creates the bundle, launches the detached recorder and asks the bridge to start the browser layer if Chrome is connected. `teach stop` (Ctrl+Alt+F10) stops both, then transcribes with faster-whisper (audio decoded without PyAV, whose newer releases break faster-whisper's file decoding), builds `timeline.json` and `timeline.md`, and copies the bundle to `hetzner:~/tmp/teach-recordings/<id>/`.

The recorder must run in the interactive desktop session: a process started over SSH or by a background service cannot see the screen, input or (often) the microphone. That is why start and stop are local commands and shortcuts rather than bridge calls.

## Not built

- Masking of one-time codes or card numbers (Alexey, t1251u: keep it simple). Chrome password fields are skipped, and the matching desktop keystrokes are redacted when the browser layer is on.
- Per-keystroke logging: typing is grouped into bursts with their final text.
- Window-under-pointer detection on Linux; clicks there carry the window that became active.
