"""Probe 12e: the Phase 3 edit choreography — hidden undo contexts + journal revert.

Established facts (12b/12c/12d):
- text setString: NEVER undoable (API text edits bypass the undo manager)
- insertNewByIndex: pushes a BROKEN undo action (undo() does not remove the page)
- presentation-shape adds / shape moves: natively undoable
- .uno:InsertPage dispatch: fully undoable + creates Title+Outliner placeholders
- dispose / plain TextShape adds: not undoable

Candidate design: Impress edits never touch the native undo stack
(enterHiddenUndoContext around shape/page ops), and the bridge keeps its
own per-edit journal; /undo applies the journal entry (restore texts or
removeByIndex the inserted page). This probe verifies the primitives:

E1  hidden ctx: insertNewByIndex + presentation shape adds + texts
    -> applied, native stack still empty?
E2  hidden ctx: insertNewByIndex alone -> native stack empty?
E3  presentation shape add WITHOUT any context -> native stack?
E4  .uno:InsertPage placeholder geometry (to clone for manual creation)
    + position relative to the current page
E5  shape identity via == across calls (selection -> slide/shape index)
E6  removeByIndex journal revert: insert+fill then removeByIndex -> original?
E7  Draw: same choreography on private:factory/sdraw
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


def undo_possible(doc):
    return doc.getUndoManager().isUndoPossible()


print("=== E1: hidden ctx — page insert + presentation shapes + text ===")
doc = fresh()
pages = doc.getDrawPages()
pages.getByIndex(0).getByIndex(0).getText().setString("MARKER ONE")
um = doc.getUndoManager()
um.enterHiddenUndoContext()
try:
    pages.insertNewByIndex(1)
    page = pages.getByIndex(1)
    t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3500))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 875))
    t.getText().setString("E1 new title")
    b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    page.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 12000))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5600))
    b.getText().setString("E1 bullet one\nE1 bullet two")
finally:
    um.leaveUndoContext()
print(f"  applied state: {state(doc)}")
print(f"  native undoPossible={undo_possible(doc)} (want False)")
pages.removeByIndex(1)
print(f"  after journal revert removeByIndex(1): {state(doc)}")

print("=== E2: hidden ctx — insertNewByIndex alone ===")
doc = fresh()
pages = doc.getDrawPages()
um = doc.getUndoManager()
um.enterHiddenUndoContext()
try:
    pages.insertNewByIndex(1)
finally:
    um.leaveUndoContext()
print(f"  count={pages.getCount()} native undoPossible={undo_possible(doc)} (want False)")

print("=== E3: presentation shape add with NO context ===")
doc = fresh()
pages = doc.getDrawPages()
um = doc.getUndoManager()
print(f"  before: undoPossible={um.isUndoPossible()}")
t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
pages.getByIndex(0).add(t)
print(f"  after bare add (no context): undoPossible={um.isUndoPossible()}")
if um.isUndoPossible():
    um.undo()
    print(f"  after undo: {state(doc)}")

print("=== E4: .uno:InsertPage placeholder geometry + position ===")
doc = fresh()
pages = doc.getDrawPages()
pages.getByIndex(0).getByIndex(0).getText().setString("SLIDE A")
pages.insertNewByIndex(1)
pages.getByIndex(1).add(doc.createInstance("com.sun.star.drawing.TextShape"))
pages.getByIndex(1).getByIndex(0).getText().setString("SLIDE B")
ctrl = doc.getCurrentController()
print(f"  before: {state(doc)}")
ctrl.setCurrentPage(pages.getByIndex(0))
cur = ctrl.getCurrentPage()
print(f"  current page == pages[0]: {cur == pages.getByIndex(0)}")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertPage", "", 0, ())
print(f"  after: {state(doc)}")
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    for j in range(p.getCount()):
        s = p.getByIndex(j)
        pos = s.getPosition()
        size = s.getSize()
        print(f"    page[{i}].shape[{j}] {s.getShapeType().rsplit('.', 1)[-1]}"
              f" pos=({pos.X},{pos.Y}) size=({size.Width},{size.Height})")

print("=== E5: shape identity via == (selection -> indices) ===")
doc = fresh()
pages = doc.getDrawPages()
title = pages.getByIndex(0).getByIndex(0)
sub = pages.getByIndex(0).getByIndex(1)
ctrl = doc.getCurrentController()
ctrl.select(sub)
sel = ctrl.getSelection()
target = sel.getByIndex(0)
found = None
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    for j in range(p.getCount()):
        if p.getByIndex(j) == target:
            found = (i, j)
print(f"  selected shape located at slide/shape: {found} (want (0, 1))")

print("=== E6: Draw choreography ===")
doc = fresh("private:factory/sdraw")
pages = doc.getDrawPages()
print(f"  draw pages: {pages.getCount()} name={pages.getByIndex(0).getName()!r}")
um = doc.getUndoManager()
um.enterHiddenUndoContext()
try:
    pages.insertNewByIndex(1)
    page = pages.getByIndex(1)
    t = doc.createInstance("com.sun.star.drawing.TextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 4000))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 2000))
    t.getText().setString("E6 draw frame\nSecond paragraph")
finally:
    um.leaveUndoContext()
print(f"  applied: {state(doc)} native undoPossible={undo_possible(doc)} (want False)")
pages.removeByIndex(1)
print(f"  after removeByIndex(1): {state(doc)}")
try:
    print(f"  draw RecordChanges: {doc.getPropertyValue('RecordChanges')!r}")
except Exception as e:
    print(f"  draw RecordChanges absent: {e!r}")
try:
    cur = doc.getCurrentController().getCurrentPage()
    print(f"  draw getCurrentPage == pages[0]: {cur == pages.getByIndex(0)}")
except Exception as e:
    print(f"  draw getCurrentPage failed: {e!r}")

print("=== E7: getCurrentPage index after inserts (== comparison) ===")
doc = fresh()
pages = doc.getDrawPages()
pages.insertNewByIndex(0)
ctrl = doc.getCurrentController()
for i in range(pages.getCount()):
    ctrl.setCurrentPage(pages.getByIndex(i))
    cur = ctrl.getCurrentPage()
    match = [k for k in range(pages.getCount()) if cur == pages.getByIndex(k)]
    print(f"  setCurrentPage({i}) -> getCurrentPage matches index {match}, "
          f"Number={cur.getPropertyValue('Number')}")

print("=== probe 12e done ===")
