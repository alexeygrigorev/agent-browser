# Local background connection

A local client uses `http://127.0.0.1:19333` and the extension connects outward to
`ws://127.0.0.1:19333/extension`. There is no local login, token, certificate
pairing, or remote grant. Remote access has a separate security boundary.

## Existing profile

Run these commands **on the Chrome computer**, from its agent-browser checkout:

```powershell
node .\bin\cli.js serve
# In another local terminal:
node .\bin\cli.js browsers
node .\bin\cli.js --browser main status
node .\bin\cli.js --browser main call tabs.list '{}'
```

`serve` is unnecessary if the local bridge is already listening. `status` is a
read-only connectivity check and does not start a bridge. `browsers` lists saved
nicknames, including offline entries. `tabs.list` enumerates tabs without
activating them. Always select the requested nickname or stable ID.

`main` names an extension UUID saved by the bridge. Chrome's `Default` names a
profile directory. A shortcut targeting `--profile-directory=Default` does not
prove that profile is running, has the extension installed/enabled, or owns the
nickname `main`. Confirm those facts in the intended profile before renaming
anything. The bridge never switches to another profile when `main` is offline.

## Keep an existing profile available without opening a window

One-time setup through ordinary Chrome UI, in the intended profile:

1. Install/reload this checkout's unpacked `extension` using
   `chrome://extensions`, with Developer mode enabled.
2. In Chrome **Settings → System**, allow **Continue running background apps
   when Google Chrome is closed**. If policy disables it, stop; do not override
   policy. The option's availability depends on Chrome and platform.
3. Open the extension popup and check **Keep this profile available after
   closing its windows**. This requests only Chrome's optional `background`
   permission. It can also start Chrome when the computer user signs in.
4. Confirm the correct local nickname/UUID with `browsers`. If this profile was
   deliberately paused, Resume is an explicit, separate step.

After setup, closing the last window can leave the profile and extension running;
restarting the bridge reconnects automatically without activating a Chrome window.
Uncheck the checkbox to remove the permission. It does not grant browser access
when Pause is active. Explicitly quitting Chrome still stops it. Removing this
extension's permission cannot stop other background extensions or change Chrome's
System setting.

The setup UI itself requires desktop interaction and can affect foreground focus.
An agent required to preserve the user's foreground must stop before these steps
and record them for sanctioned desktop computerUse. Do not automate an owner's
browser setup through shell commands.

## A profile that is completely stopped

There was no profile-launch or attach command at baseline commit `876e594`.
`src/launcher.js` launches only `node bin/cli.js serve`; `src/client.js` waits for
an extension connection, then reports `Chrome (main) did not connect...`.
`extension/background.js` connects on worker startup and reconnect alarms, but
cannot run while Chrome has not loaded its profile. The old manifest had no
`background` permission. See `test/launcher.test.js` and
`extension/background.test.js` for the bridge-only launcher and automatic recovery.

Chromium has a distinct windowless startup path:

```text
chrome.exe --profile-directory=Default --no-startup-window
```

This is a **candidate desktop shortcut target**, not a bridge command or permission
bypass. It uses the existing profile in place. It needs the extension already
installed, background permission granted, and Chrome background mode allowed.
An absolute executable path must refer to the actual installed Chrome. Do not add
URLs, `--new-window`, debugging switches, or `--start-minimized`.

The Windows CI test below validates this path in bundled Chromium. That does not
guarantee an owner's Google Chrome build, profile, policy, crash-recovery prompts,
or first-run state preserves focus. Until that installed build has equivalent
foreground-event evidence on an isolated desktop, do not execute this shortcut on
the owner's live desktop. For an already-running profile, prefer automatic
connection and background retention; no launch is needed.

## Evidence and verification limits

- [Chrome background permission](https://developer.chrome.com/docs/extensions/reference/permissions-list#background)
  documents early startup and late shutdown. It is optional here and requested
  only from a popup user gesture. Unit tests cover opt-in, removal, denial,
  unavailable permission, and keeping Pause independent.
- [Chromium background application classification](https://github.com/chromium/chromium/blob/main/chrome/browser/background/extensions/background_application_list_model.cc)
  treats extensions with the background permission as persistent background apps.
- [Chromium startup code](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/startup/startup_browser_creator.cc)
  loads a profile for `--no-startup-window` and returns from the silent-launch
  path before opening browser windows. This explains intent; source review alone
  is not a focus measurement.
- `test/background.windows.e2e.js` runs on Windows CI using fresh disposable
  Chromium data. The real popup checkbox grants the optional permission during
  setup. After Chrome fully exits, windowless startup must reconnect the same
  UUID with zero tabs. A bridge restart and closing the last normal window must
  preserve connectivity and foreground focus.
- `test/fixtures/foreground.ps1` holds an unrelated foreground sentinel and uses
  Win32 `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` to catch transient focus
  changes, plus checks the final `GetForegroundWindow` handle. The test fails
  without an interactive desktop. An ordinary disposable Chrome launch must
  produce a focus event as a positive control. Mocks, minimized state, and a
  final screenshot alone are not accepted as focus evidence.

These tests do not inspect a signed-in user profile, copy cookies/profiles,
collect analytics, change identities, or exercise remote access. Desktop
installation and focus validation remain explicit deployment prerequisites.
