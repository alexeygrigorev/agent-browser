"""Helpers for scripts/teach-demo.js on an X11 display (Linux).

  app                 show a small Tk "Accountant notes" window; prints widget
                      screen positions as JSON, then waits until closed
  input               read commands from stdin and inject them through XTest,
                      exactly like a hardware mouse and keyboard:
                        click X Y | type TEXT | key NAME | combo MOD NAME
"""
import json
import sys
import time


def app():
    import tkinter

    root = tkinter.Tk()
    root.title("Accountant notes")
    root.geometry("380x170+860+120")
    tkinter.Label(root, text="Notes for the accountant").pack(pady=6)
    entry = tkinter.Entry(root, width=36)
    entry.pack(pady=4)
    status = tkinter.Label(root, text="")
    button = tkinter.Button(root, text="Save note", command=lambda: status.config(text="Saved: " + entry.get()))
    button.pack(pady=4)
    status.pack()

    def report():
        root.update_idletasks()
        center = lambda widget: [widget.winfo_rootx() + widget.winfo_width() // 2, widget.winfo_rooty() + widget.winfo_height() // 2]
        print(json.dumps({"entry": center(entry), "button": center(button)}), flush=True)

    root.after(800, report)
    root.mainloop()


def inject():
    from Xlib import X, XK, display
    from Xlib.ext import xtest

    d = display.Display()

    def keycode(name):
        keysym = XK.string_to_keysym(name)
        if not keysym and len(name) == 1:
            keysym = ord(name)
        return d.keysym_to_keycode(keysym)

    def tap(name, shift=False):
        names = {" ": "space", "\n": "Return", ".": "period", ",": "comma", ":": "colon", "-": "minus"}
        code = keycode(names.get(name, name))
        if shift:
            xtest.fake_input(d, X.KeyPress, keycode("Shift_L"))
        xtest.fake_input(d, X.KeyPress, code)
        xtest.fake_input(d, X.KeyRelease, code)
        if shift:
            xtest.fake_input(d, X.KeyRelease, keycode("Shift_L"))
        d.sync()
        time.sleep(0.09)

    for line in sys.stdin:
        command, _, rest = line.rstrip("\n").partition(" ")
        if command == "click":
            x, y = map(int, rest.split())
            xtest.fake_input(d, X.MotionNotify, x=x, y=y)
            d.sync()
            time.sleep(0.15)
            xtest.fake_input(d, X.ButtonPress, 1)
            xtest.fake_input(d, X.ButtonRelease, 1)
        elif command == "type":
            for char in rest:
                tap(char.lower() if char.isalpha() else char, shift=char.isupper() or char == ":")
        elif command == "key":
            tap(rest)
        elif command == "combo":
            modifier, name = rest.split()
            xtest.fake_input(d, X.KeyPress, keycode(modifier))
            tap(name)
            xtest.fake_input(d, X.KeyRelease, keycode(modifier))
        d.sync()
        print("ok", flush=True)


if __name__ == "__main__":
    {"app": app, "input": inject}[sys.argv[1]]()
