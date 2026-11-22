import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WIN32_TYPE_DEF = `
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class AgentBrowserWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

  public const int SW_SHOWNOACTIVATE = 4;
  public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
  public const uint SWP_NOSIZE = 0x0001;
  public const uint SWP_NOMOVE = 0x0002;
  public const uint SWP_NOACTIVATE = 0x0010;

  public static string GetTitle(IntPtr hWnd) {
    int len = GetWindowTextLength(hWnd);
    if (len <= 0) return "";
    var sb = new StringBuilder(len + 1);
    GetWindowText(hWnd, sb, sb.Capacity);
    return sb.ToString();
  }

  public static List<Dictionary<string, object>> ListChrome() {
    var list = new List<Dictionary<string, object>>();
    EnumWindows((hWnd, lParam) => {
      if (!IsWindowVisible(hWnd)) return true;
      var cls = new StringBuilder(64);
      GetClassName(hWnd, cls, cls.Capacity);
      if (cls.ToString() != "Chrome_WidgetWin_1") return true;
      string title = GetTitle(hWnd);
      if (string.IsNullOrEmpty(title)) return true;
      uint pid;
      GetWindowThreadProcessId(hWnd, out pid);
      list.Add(new Dictionary<string, object> {
        { "hwnd", hWnd.ToInt64() },
        { "pid", (long)pid },
        { "title", title },
        { "minimized", IsIconic(hWnd) }
      });
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static Dictionary<string, object> PlaceBehind(long hwndVal) {
    IntPtr hWnd = new IntPtr(hwndVal);
    IntPtr fgBefore = GetForegroundWindow();
    string fgBeforeTitle = GetTitle(fgBefore);
    bool wasMinimized = IsIconic(hWnd);
    if (wasMinimized) {
      ShowWindow(hWnd, SW_SHOWNOACTIVATE);
    }
    SetWindowPos(hWnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    IntPtr fgAfter = GetForegroundWindow();
    string fgAfterTitle = GetTitle(fgAfter);
    return new Dictionary<string, object> {
      { "ok", !IsIconic(hWnd) },
      { "hwnd", hwndVal },
      { "wasMinimized", wasMinimized },
      { "minimized", IsIconic(hWnd) },
      { "foregroundBefore", new Dictionary<string, object> { { "hwnd", fgBefore.ToInt64() }, { "title", fgBeforeTitle } } },
      { "foregroundAfter", new Dictionary<string, object> { { "hwnd", fgAfter.ToInt64() }, { "title", fgAfterTitle } } },
      { "focusPreserved", fgBefore == fgAfter }
    };
  }
}
"@
`;

async function runPowerShell(script, { exec = execFileAsync, timeoutMs = 10000 } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024
  });
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function matchChromeWindow(windows, { beforeHwnds, title, minimizedOnly = false } = {}) {
  if (!Array.isArray(windows) || !windows.length) return null;
  const before = Array.isArray(beforeHwnds) ? new Set(beforeHwnds) : null;
  let candidates = windows;
  if (before) {
    const added = candidates.filter(w => !before.has(w.hwnd));
    if (added.length === 1) return added[0];
    if (added.length > 1) candidates = added;
  }
  if (minimizedOnly) {
    const minimized = candidates.filter(w => w.minimized);
    if (minimized.length) candidates = minimized;
    else return null;
  }
  if (title) {
    const needle = title.toLowerCase();
    const exactPrefix = candidates.find(w => typeof w.title === 'string' && w.title.toLowerCase().startsWith(needle));
    if (exactPrefix) return exactPrefix;
    const partial = candidates.find(w => typeof w.title === 'string' && w.title.toLowerCase().includes(needle));
    if (partial) return partial;
  }
  return candidates.length === 1 ? candidates[0] : (before ? candidates[0] : null);
}

export function createWindowController({ platform = process.platform, exec = execFileAsync } = {}) {
  const supported = platform === 'win32';
  async function listChromeWindows() {
    if (!supported) return { supported: false, platform, foreground: null, windows: [] };
    const script = `${WIN32_TYPE_DEF}
$fg = [AgentBrowserWin32]::GetForegroundWindow()
$out = @{
  supported = $true
  foreground = @{ hwnd = $fg.ToInt64(); title = [AgentBrowserWin32]::GetTitle($fg) }
  windows = [AgentBrowserWin32]::ListChrome()
}
$out | ConvertTo-Json -Depth 5 -Compress
`;
    const result = await runPowerShell(script, { exec });
    const windows = Array.isArray(result?.windows) ? result.windows : result?.windows ? [result.windows] : [];
    return { supported: true, foreground: result?.foreground || null, windows };
  }

  async function placeWindowBehind(hwnd) {
    if (!supported) return { supported: false, platform, ok: false };
    if (!Number.isSafeInteger(hwnd) || hwnd <= 0) throw new Error('hwnd must be a positive integer');
    const script = `${WIN32_TYPE_DEF}
[AgentBrowserWin32]::PlaceBehind(${hwnd}) | ConvertTo-Json -Depth 5 -Compress
`;
    const result = await runPowerShell(script, { exec });
    return { supported: true, ...result };
  }

  async function restoreWindowBehind({ beforeHwnds, title, minimizedOnly = false } = {}) {
    if (!supported) return { supported: false, platform, ok: false };
    const listed = await listChromeWindows();
    const match = matchChromeWindow(listed.windows, { beforeHwnds, title, minimizedOnly });
    if (!match) {
      return {
        supported: true,
        ok: false,
        reason: 'No matching Chrome window found',
        foregroundBefore: listed.foreground,
        foregroundAfter: listed.foreground,
        focusPreserved: true
      };
    }
    return placeWindowBehind(match.hwnd);
  }

  return { supported, platform, listChromeWindows, placeWindowBehind, restoreWindowBehind };
}
