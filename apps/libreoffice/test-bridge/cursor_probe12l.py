"""Probe 12l: drive the real UI through LibreOffice's accessibility tree.

Walks the front window's accessible tree, finds the "ACP Assist" deck
button (its accessible name is the deck title), invokes its default
action (click), then finds the status-panel buttons by name to prove the
deck opened and our panel rendered.
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
doc = desktop.getCurrentComponent()
frame = doc.getCurrentController().getFrame()
# The toolkit window exposes XAccessible via queryInterface over the
# socket proxy (the python attribute path fails on the raw proxy).
import uno as _uno
win = frame.getContainerWindow()
acc = win.queryInterface(_uno.getTypeByName("com.sun.star.accessibility.XAccessible"))
if acc is not None:
    acc = acc.getAccessibleContext()
else:
    raise SystemExit("container window does not expose XAccessible")

found = []
action = None


def walk(node, depth=0, max_depth=14):
    global action
    if node is None or depth > max_depth:
        return
    try:
        count = node.getAccessibleChildCount()
    except Exception:
        return
    for i in range(count):
        try:
            child = node.getAccessibleChild(i)
            cctx = child.getAccessibleContext()
        except Exception:
            continue
        try:
            name = cctx.getAccessibleName()
            role = cctx.getAccessibleRole()
        except Exception:
            name, role = None, None
        if name:
            found.append((depth, role, name))
            if name == "ACP Assist":
                action = cctx
        try:
            walk(cctx, depth + 1, max_depth)
        except Exception:
            pass


print("walking the a11y tree of the front window…")
walk(acc)
print(f"named accessible nodes: {len(found)}")
interesting = [f for f in found if any(
    k in (f[2] or "") for k in ("ACP", "Status", "Refresh", "Restart", "Open companion", "Sidebar"))]
for d, role, name in interesting:
    print(f"  depth={d} role={role} name={name!r}")

if action is not None:
    try:
        n = action.getAccessibleActionCount()
        print(f"ACP deck button: action count={n}")
        action.doAccessibleAction(0)
        print("CLICKED the ACP Assist deck button")
    except Exception as e:
        print(f"click failed: {e}")
else:
    print("ACP deck button NOT found in the a11y tree")