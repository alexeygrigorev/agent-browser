# Isolated CI desktop only. This form owns the foreground while the test runs.
param([string]$ReadyFile, [string]$EventsFile, [string]$StopFile, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public class ForegroundProbe : Form {
    delegate void WinEventDelegate(IntPtr hook, uint evt, IntPtr hwnd, int obj, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventDelegate callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
    WinEventDelegate callback;
    IntPtr hook;
    bool recording;
    public ForegroundProbe(string ready, string events, string stop, string result) {
        Text = "Agent Browser isolated foreground sentinel";
        Width = 540; Height = 160;
        callback = (h, e, hwnd, o, c, t, ms) => {
            if (recording && hwnd != Handle) File.AppendAllText(events, hwnd.ToInt64() + "\n");
        };
        Shown += (s, e) => {
            hook = SetWinEventHook(3, 3, IntPtr.Zero, callback, 0, 0, 0); // EVENT_SYSTEM_FOREGROUND, OUTOFCONTEXT
            if (hook == IntPtr.Zero) throw new Exception("Cannot observe Windows foreground events");
            Activate(); SetForegroundWindow(Handle);
            var timer = new Timer { Interval = 1000 };
            timer.Tick += (sender, args) => {
                if (!recording) {
                    if (GetForegroundWindow() != Handle) throw new Exception("No interactive foreground desktop");
                    File.WriteAllText(events, "");
                    recording = true;
                    File.WriteAllText(ready, Handle.ToInt64().ToString());
                }
                if (File.Exists(stop)) {
                    File.WriteAllText(result, GetForegroundWindow().ToInt64().ToString());
                    timer.Stop(); recording = false; UnhookWinEvent(hook); Close();
                }
            };
            timer.Start();
        };
    }
}
'@
[System.Windows.Forms.Application]::Run([ForegroundProbe]::new($ReadyFile, $EventsFile, $StopFile, $ResultFile))
