"""Probe 12f: locked undo manager as the suppressor for Phase 3 edits.

enterHiddenUndoContext is unusable (needs a previous undo action). XUndoManager
.lock() / .unlock() should suppress undo recording entirely while held.

L1  um.lock() { insertNewByIndex + presentation shape adds + texts } um.unlock()
    -> applied? native stack empty?
L2  removeByIndex journal revert after L1 -> original state?
L3  lock around a dispatch (.uno:InsertPage) -> does the dispatch action land
    on the stack anyway? (curiosity; design uses API route only)
L4  shape identity via == (selection -> slide/shape index)
L5  Draw choreography under lock
L6  getCurrentPage index via == after inserts; Number property
L7  .uno:InsertPage placeholder geometry (reference for manual creation)
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
    out = []
    for i in range(pages.getCount()):
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


def apply_slide(doc, idx, title_text, body_text):
    pages = doc.getDrawPages()
    page = pages.getByIndex(idx)
    t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3500))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 875))
    t.getText().setString(title_text)
    b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    page.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 12000))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5600))
    b.getText().setString(body_text)
    return t, b


print("=== L1/L2: locked { page insert + shapes + text } + journal revert ===")
doc = fresh()
pages = doc.getDrawPages()
pages.getByIndex(0).getByIndex(0).getText().setString("MARKER ONE")
um = doc.getUndoManager()
print(f"  before lock: isLocked={um.isLocked()} undoPossible={um.isUndoPossible()}")
um.lock()
try:
    pages.insertNewByIndex(1)
    apply_slide(doc, 1, "L1 title", "L1 bullet one\nL1 bullet two")
finally:
    um.unlock()
print(f"  state: {state(doc)}")
print(f"  after unlock: isLocked={um.isLocked()} "
      f"undoPossible={um.isUndoPossible()} (want False)")
pages.getByIndex(1).dispose()
print(f"  after journal revert page.dispose(): {state(doc)}")
print(f"  undoPossible still: {um.isUndoPossible()}")

print("=== L3: lock around .uno:InsertPage dispatch ===")
doc = fresh()
pages = doc.getDrawPages()
um = doc.getUndoManager()
um.lock()
try:
    dispatcher.executeDispatch(doc.getCurrentController().getFrame(),
                               ".uno:InsertPage", "", 0, ())
finally:
    um.unlock()
print(f"  count={pages.getCount()} undoPossible={um.isUndoPossible()}")

print("=== L4: shape identity via == ===")
doc = fresh()
pages = doc.getDrawPages()
sub = pages.getByIndex(0).getByIndex(1)
doc.getCurrentController().select(sub)
sel = doc.getCurrentController().getSelection()
target = sel.getByIndex(0)
found = None
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    for j in range(p.getCount()):
        if p.getByIndex(j) == target:
            found = (i, j)
print(f"  selected shape located at (slide, shape): {found} (want (0, 1))")

print("=== L5: Draw choreography under lock ===")
doc = fresh("private:factory/sdraw")
pages = doc.getDrawPages()
print(f"  draw pages: {pages.getCount()} name={pages.getByIndex(0).getName()!r}")
um = doc.getUndoManager()
um.lock()
try:
    pages.insertNewByIndex(1)
    page = pages.getByIndex(1)
    t = doc.createInstance("com.sun.star.drawing.TextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 4000))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 2000))
    t.getText().setString("L5 frame\nSecond paragraph")
finally:
    um.unlock()
print(f"  applied: {state(doc)} undoPossible={um.isUndoPossible()} (want False)")
pages.getByIndex(1).dispose()
print(f"  after dispose(): {state(doc)}")
try:
    print(f"  draw getCurrentPage == pages[0]: "
          f"{doc.getCurrentController().getCurrentPage() == pages.getByIndex(0)}")
except Exception as e:
    print(f"  draw getCurrentPage failed: {e!r}")

print("=== L6: getCurrentPage index via ==; Number property ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(0)
ctrl = doc.getCurrentController()
for i in range(pages.getCount()):
    ctrl.setCurrentPage(pages.getByIndex(i))
    cur = ctrl.getCurrentPage()
    match = [k for k in range(pages.getCount()) if cur == pages.getByIndex(k)]
    print(f"  setCurrentPage({i}) -> matches {match}, Number={cur.getPropertyValue('Number')}")

print("=== L7: .uno:InsertPage placeholder geometry (reference values) ===")
doc = fresh()
dispatcher.executeDispatch(doc.getCurrentController().getFrame(),
                          ".uno:InsertPage", "", 0, ())
pages = doc.getDrawPages()
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    for j in range(p.getCount()):
        s = p.getByIndex(j)
        pos = s.getPosition()
        size = s.getSize()
        try:
            name = s.getPropertyValue("Name")
        except Exception:
            name = "?"
        print(f"  page[{i}].shape[{j}] {s.getShapeType().rsplit('.', 1)[-1]}"
              f" name={name!r} pos=({pos.X},{pos.Y}) size=({size.Width},{size.Height})")

print("=== probe 12f done ===")
