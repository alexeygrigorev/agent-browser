# Teach recording: design decision

Goal: Alexey records a browser walkthrough with his voice; Orin turns the bundle into a DataOps SOP. This replaces the Loom plus Grace flow.

## Is the existing extension enough?

Not unchanged; with an update, yes. No separate recorder app is needed.

- **Actions.** The old extension could only observe pages through `chrome.debugger`. Attaching it to every tab shows Chrome's debugging banner on each tab and, in this extension, moves each tab into the agent's tab group. Neither fits watching a person work in their own tabs. The update adds an observe-only content script (`extension/teach-content.js`), registered for all frames of all sites only while a session runs, plus `chrome.tabs`, `chrome.windows` and `chrome.webNavigation` listeners for new tabs, windows, tab switches, page loads and single-page-app navigation.
- **Screenshots.** `chrome.tabs.captureVisibleTab` captures the visible tab without the debugger, spaced to Chrome's limit of two per second. Video was left out: the existing `record` command can still make a silent WebM of one tab, but per-action screenshots are easier for an agent to read.
- **Microphone.** A browser extension can only record the microphone from a visible page with a permission prompt. The bridge already runs on the same computer and already uses FFmpeg for video, so it records the microphone with FFmpeg (DirectShow on Windows) in user scope.
- **One clock.** Browser events carry `Date.now()` from the same computer, the bridge sets the session start `t0`, and FFmpeg's progress output places the first audio sample on that clock.
- **Transcription.** faster-whisper runs locally in user scope, with segment timestamps. No paid service.
- **Bundle.** The bridge writes the bundle on the computer with Chrome and, on Windows, copies it to Hetzner over the existing `ssh hetzner` access.

## Not built

- Masking of one-time codes or card numbers (Alexey, t1251u: keep it simple). Only `input[type=password]` values are skipped.
- Logging of every keystroke: typing is recorded as one `type` event per field with its final value.
- Scroll and hover logging.
