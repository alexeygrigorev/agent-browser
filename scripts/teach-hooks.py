"""Desktop input and window log for teach recording.

Prints one JSON object per line on stdout: mouse clicks, scrolls, typed text
(grouped per burst), special keys and shortcuts, and foreground window
changes, each with a millisecond Unix timestamp. Exits when stdin closes.
Needs pynput (python -m pip install --user pynput). On Windows, the optional
uiautomation package adds the name and type of the clicked control.
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

WINDOWS = sys.platform == "win32"
if WINDOWS:
    import ctypes
    from ctypes import wintypes

    try:  # Report physical pixels, matching FFmpeg's gdigrab frames.
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

try:
    from pynput import keyboard, mouse
except Exception as error:  # Reported to the recorder, which keeps recording without hooks.
    print(json.dumps({"kind": "hooks_error", "ts": time.time() * 1000, "error": f"pynput unavailable: {error}. Install it with: python -m pip install --user pynput"}), flush=True)
    sys.exit(3)

lock = threading.Lock()


def now():
    return round(time.time() * 1000)


def emit(event):
    with lock:
        sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# Foreground window ---------------------------------------------------------
if WINDOWS:
    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32

    def foreground():
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None
        length = user32.GetWindowTextLengthW(hwnd)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        app = None
        handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            size = wintypes.DWORD(1024)
            path = ctypes.create_unicode_buffer(1024)
            if kernel32.QueryFullProcessImageNameW(handle, 0, path, ctypes.byref(size)):
                app = os.path.basename(path.value)
            kernel32.CloseHandle(handle)
        rect = wintypes.RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rect))
        return {"id": int(hwnd), "title": buffer.value, "app": app, "pid": pid.value,
                "bbox": {"x": rect.left, "y": rect.top, "width": rect.right - rect.left, "height": rect.bottom - rect.top}}

    def screen_origin():
        return {"x": user32.GetSystemMetrics(76), "y": user32.GetSystemMetrics(77),
                "width": user32.GetSystemMetrics(78), "height": user32.GetSystemMetrics(79)}
else:
    from Xlib import X, display as xdisplay

    _display = xdisplay.Display()
    _root = _display.screen().root
    _atoms = {name: _display.intern_atom(name) for name in ("_NET_ACTIVE_WINDOW", "_NET_WM_NAME", "_NET_WM_PID", "UTF8_STRING")}

    def foreground():
        try:
            prop = _root.get_full_property(_atoms["_NET_ACTIVE_WINDOW"], X.AnyPropertyType)
            window = _display.create_resource_object("window", prop.value[0]) if prop and prop.value[0] else _display.get_input_focus().focus
            name = window.get_full_property(_atoms["_NET_WM_NAME"], _atoms["UTF8_STRING"])
            title = name.value.decode("utf-8", "replace") if name else (window.get_wm_name() or "")
            wm_class = window.get_wm_class()
            pid_prop = window.get_full_property(_atoms["_NET_WM_PID"], X.AnyPropertyType)
            pid = int(pid_prop.value[0]) if pid_prop else None
            return {"id": int(window.id), "title": title if isinstance(title, str) else title.decode("utf-8", "replace"),
                    "app": wm_class[1] if wm_class else None, "pid": pid}
        except Exception:
            return None

    def screen_origin():
        geometry = _root.get_geometry()
        return {"x": 0, "y": 0, "width": geometry.width, "height": geometry.height}


current = {"window": None}
foreground_lock = threading.Lock()


def active_window():
    with foreground_lock:
        return foreground()


def brief(window):
    return {"title": window.get("title"), "app": window.get("app")} if window else None


def watch_windows():
    last = None
    while True:
        info = active_window()
        key = (info or {}).get("id"), (info or {}).get("title")
        if info and key != last:
            last = key
            if typing.window != brief(info):  # Typing that continues in the new window stays one burst.
                typing.flush()
            current["window"] = info
            emit({"kind": "window", "ts": now(), "window": info})
        time.sleep(0.2)


def window_brief():
    return brief(current["window"])


# Control under the pointer (Windows UI Automation, optional) ---------------
clicks = queue.Queue()


def describe_clicks():
    automation = None
    if WINDOWS:
        try:
            import uiautomation as automation
        except Exception:
            automation = None
    initializer = automation.UIAutomationInitializerInThread() if automation else None
    if initializer:
        initializer.__enter__()
    while True:
        event = clicks.get()
        # Focus moves after the button press; the window active a moment
        # later is the one that was clicked.
        delay = event["ts"] / 1000 + 0.3 - time.time()
        if delay > 0:
            time.sleep(delay)
        event["window"] = brief(active_window()) or event.get("window")
        if automation:
            try:
                control = automation.ControlFromPoint(event["x"], event["y"])
                if control:
                    rect = control.BoundingRectangle
                    event["element"] = {"name": (control.Name or "")[:150], "role": control.ControlTypeName,
                                        "id": control.AutomationId or None, "className": control.ClassName or None,
                                        "bbox": {"x": rect.left, "y": rect.top, "width": rect.width(), "height": rect.height()}}
            except Exception:
                pass
        emit(event)


# Typing --------------------------------------------------------------------
class Typing:
    def __init__(self):
        self.text = ""
        self.started = None
        self.last = None
        self.timer = None
        self.window = None

    def add(self, char):
        if not self.text:
            window = brief(active_window())
        with lock:
            if not self.text:
                self.started = now()
                self.window = window
            self.text += char
            self.last = now()
            self._arm()

    def backspace(self):
        with lock:
            if self.text:
                self.text = self.text[:-1]
                self.last = now()
                self._arm()
                return True
        return False

    def _arm(self):
        if self.timer:
            self.timer.cancel()
        self.timer = threading.Timer(1.5, self.flush)
        self.timer.daemon = True
        self.timer.start()

    def flush(self):
        with lock:
            text, started, last, window = self.text, self.started, self.last, self.window
            self.text = ""
            self.window = None
            if self.timer:
                self.timer.cancel()
                self.timer = None
        if text:
            emit({"kind": "type", "ts": started, "endTs": last, "text": text, "window": window or window_brief()})


typing = Typing()
modifiers = set()
MODIFIERS = {"ctrl": "ctrl", "ctrl_l": "ctrl", "ctrl_r": "ctrl", "alt": "alt", "alt_l": "alt", "alt_r": "alt", "alt_gr": "alt",
             "shift": "shift", "shift_l": "shift", "shift_r": "shift", "cmd": "win", "cmd_l": "win", "cmd_r": "win"}
SPECIAL = {"enter", "tab", "esc", "delete", "up", "down", "left", "right", "page_up", "page_down", "home", "end",
           "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12"}


def key_name(key):
    if isinstance(key, keyboard.Key):
        return key.name
    if getattr(key, "char", None):
        return key.char
    vk = getattr(key, "vk", None)
    if vk is not None and (48 <= vk <= 57 or 65 <= vk <= 90):
        return chr(vk).lower()
    return f"vk{vk}" if vk is not None else str(key)


def on_press(key):
    name = key_name(key)
    if name in MODIFIERS:
        modifiers.add(MODIFIERS[name])
        return
    combo = modifiers - {"shift"}
    if combo:
        typing.flush()
        emit({"kind": "key", "ts": now(), "key": name, "modifiers": sorted(modifiers), "window": window_brief()})
    elif name == "space":
        typing.add(" ")
    elif name == "backspace":
        if not typing.backspace():
            emit({"kind": "key", "ts": now(), "key": "backspace", "modifiers": [], "window": window_brief()})
    elif isinstance(key, keyboard.KeyCode) and getattr(key, "char", None):
        typing.add(key.char)
    elif name in SPECIAL:
        typing.flush()
        emit({"kind": "key", "ts": now(), "key": name, "modifiers": sorted(modifiers), "window": window_brief()})


def on_release(key):
    name = key_name(key)
    if name in MODIFIERS:
        modifiers.discard(MODIFIERS[name])


def on_click(x, y, button, pressed):
    if not pressed:
        return
    typing.flush()
    clicks.put({"kind": "click", "ts": now(), "x": int(x), "y": int(y), "button": getattr(button, "name", str(button)), "window": window_brief()})


scrolling = {"ts": None, "dx": 0, "dy": 0, "x": 0, "y": 0, "timer": None}


def flush_scroll():
    with lock:
        event = {"kind": "scroll", "ts": scrolling["ts"], "x": scrolling["x"], "y": scrolling["y"], "dx": scrolling["dx"], "dy": scrolling["dy"]}
        scrolling.update(ts=None, dx=0, dy=0, timer=None)
    if event["ts"]:
        event["window"] = window_brief()
        emit(event)


def on_scroll(x, y, dx, dy):
    with lock:
        if scrolling["ts"] is None:
            scrolling.update(ts=now(), x=int(x), y=int(y))
        scrolling["dx"] += dx
        scrolling["dy"] += dy
        if scrolling["timer"]:
            scrolling["timer"].cancel()
        scrolling["timer"] = threading.Timer(0.8, flush_scroll)
        scrolling["timer"].daemon = True
        scrolling["timer"].start()


def main():
    threading.Thread(target=watch_windows, daemon=True).start()
    threading.Thread(target=describe_clicks, daemon=True).start()
    mouse.Listener(on_click=on_click, on_scroll=on_scroll).start()
    keyboard.Listener(on_press=on_press, on_release=on_release).start()
    emit({"kind": "hooks_ready", "ts": now(), "screen": screen_origin(), "platform": sys.platform})
    for _ in sys.stdin:  # The recorder closes stdin to stop.
        pass
    typing.flush()
    flush_scroll()
    time.sleep(0.6)  # Let pending control lookups print.
    return 0


if __name__ == "__main__":
    sys.exit(main())
