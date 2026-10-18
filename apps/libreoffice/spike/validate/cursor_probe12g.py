"""Probe 12g: removing a Draw page via UNO — page.dispose() semantics.

12f: um.lock() {insert page + shapes + text} um.unlock() works (native stack
empty). But the journal revert page.dispose() left the pages collection in a
broken state (RuntimeException on getByIndex). Isolate:

G1  fresh doc, dispose page[1] of 2 -> count? getByIndex? readable state?
G2  fresh doc, dispose page[0] of 2 -> same
G3  does a page.dispose() leave the doc usable for further inserts?
G4  alternative removal routes: XDrawPages has none; try page.dispose()
    vs Sfx dispatcher .uno:DeletePage / .uno:DeleteSlide (position semantics)
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)


def fresh(url="private:factory/simpress"):
    doc = desktop.loadComponentFromURL(url, "_blank", 0, ())
    doc.getCurrentController().getFrame().activate()
    return doc


def state(doc):
    pages = doc.getDrawPages()
    n = pages.getCount()
    out = []
    for i in range(n):
        p = pages.getByIndex(i)
        shapes = []
        for j in range(p.getCount()):
            s = p.getByIndex(j)
            try:
                t = s.getText().getString()
            except Exception:
                t = "<none>"
            shapes.append(f"{s.getShapeType().rsplit('.', 1)[-1]}:{t!r}")
        out.append(shapes)
    return out


def try_state(doc, label):
    try:
        print(f"  {label}: {state(doc)}")
    except Exception as e:
        print(f"  {label}: STATE READ FAILED {e!r}")
        try:
            print(f"    count now: {doc.getDrawPages().getCount()}")
        except Exception as e2:
            print(f"    count read failed too: {e2!r}")


print("=== G1: dispose page[1] of 2 ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(1)
pages.getByIndex(0).getByIndex(0).getText().setString("P0")
print(f"  before: count={pages.getCount()}")
pages.getByIndex(1).dispose()
try_state(doc, "after dispose(page[1])")

print("=== G2: dispose page[0] of 2 ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(1)
pages.getByIndex(0).getByIndex(0).getText().setString("P0")
pages.getByIndex(0).dispose()
try_state(doc, "after dispose(page[0])")

print("=== G3: doc usable after page dispose? ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(1)
pages.getByIndex(1).dispose()
try:
    pages.insertNewByIndex(1)
    print(f"  insert after dispose: count={pages.getCount()}")
    try_state(doc, "state")
except Exception as e:
    print(f"  insert after dispose FAILED: {e!r}")

print("=== G4: .uno:DeletePage dispatch ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(1)
pages.insertNewByIndex(2)
pages.getByIndex(0).getByIndex(0).getText().setString("P0")
ctrl = doc.getCurrentController()
print(f"  before: count={pages.getCount()}")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
    print(f"  after .uno:DeletePage: count={pages.getCount()}")
    try_state(doc, "state")
except Exception as e:
    print(f"  DeletePage failed: {e!r}")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeleteSlide", "", 0, ())
    print(f"  after .uno:DeleteSlide: count={pages.getCount()}")
except Exception as e:
    print(f"  DeleteSlide failed: {e!r}")

print("=== probe 12g done ===")
