"""Probe 12k: which WindowDescriptor shape makes Toolkit.createWindow
return a usable button (createWindow returned None for service 'button').
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
tk = smgr.createInstanceWithContext("com.sun.star.awt.Toolkit", ctx)
from com.sun.star.awt import WindowDescriptor, Rectangle
from com.sun.star.awt.WindowClass import SIMPLE, TOP
from com.sun.star.awt.WindowAttribute import SHOW

# invisible top parent
wd = WindowDescriptor()
wd.Type = TOP
wd.WindowServiceName = "window"
wd.Bounds = Rectangle(0, 0, 300, 200)
wd.WindowAttributes = 0
parent = tk.createWindow(wd)
print("parent:", parent is not None)

def try_make(service, attrs, parent_index=None):
    d = WindowDescriptor()
    d.Type = SIMPLE
    d.Parent = parent
    d.WindowServiceName = service
    d.Bounds = Rectangle(10, 10, 100, 24)
    d.WindowAttributes = attrs
    if parent_index is not None:
        d.ParentIndex = parent_index
    try:
        win = tk.createWindow(d)
        label = None
        if win is not None:
            try:
                win.setLabel("X")
                label = "setLabel OK"
            except Exception as e:
                label = f"setLabel -> {e}"
        print(f"service={service!r} attrs={attrs} parentIndex={parent_index}: win={win is not None} {label}")
    except Exception as e:
        print(f"service={service!r} attrs={attrs} parentIndex={parent_index}: THREW {e}")

for service in ("button", "pushbutton", "okbutton", "fixedtext", "imagebutton"):
    try_make(service, SHOW)
try_make("button", 0)
try_make("button", SHOW, 0)

# Alternative: UnoControlDialog-less control via UnoControlButton service?
for ctrl in ("com.sun.star.awt.UnoControlButton", "com.sun.awt.UnoControlButton"):
    try:
        c = smgr.createInstanceWithContext(ctrl, ctx)
        print(f"{ctrl}: created={c is not None}")
        if c is not None:
            c.createPeer(tk, parent)
            c.setLabel("Y")
            print("  createPeer+setLabel OK")
    except Exception as e:
        print(f"{ctrl}: THREW {e}")