"""Probe 12c: which Impress/Draw operations create undo actions?

Probe 12b showed: API setString + insertNewByIndex leave the undo stack
EMPTY (isUndoPossible False, undo() raises EmptyUndoStackException), while
the .uno:InsertPage dispatch did insert a page. This probe maps:

A  text edits: setString vs cursor insertString vs cursor setString
B  page ops: insertNewByIndex vs .uno:InsertPage vs .uno:DuplicatePage
C  shape ops: createInstance+page.add vs shape.dispose()
D  where dispatch-inserted pages land relative to the current page
E  mixed contexts: undoable dispatch op + non-undoable setString inside ONE
   undo context — does one undo remove everything?
F  page Name/Number after inserts; whether text typed on an API-created
   shape disappears with the page on undo
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)


def fresh_impress():
    doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
    doc.getCurrentController().getFrame().activate()
    return doc


def undo_state(doc, label):
    um = doc.getUndoManager()  # fresh wrapper every time
    try:
        return f"{label}: undoPossible={um.isUndoPossible()}"
    except Exception as e:
        return f"{label}: isUndoPossible failed {e!r}"


def do_undo(doc, label):
    um = doc.getUndoManager()
    if not um.isUndoPossible():
        print(f"  {label}: NOTHING TO UNDO")
        return
    try:
        um.undo()
        print(f"  {label}: undo OK")
    except Exception as e:
        print(f"  {label}: undo failed {e!r}")


def page_state(doc):
    pages = doc.getDrawPages()
    out = []
    for i in range(pages.getCount()):
        p = pages.getByIndex(i)
        try:
            name = p.getName()
        except Exception:
            name = "?"
        try:
            num = p.getPropertyValue("Number")
        except Exception:
            num = "?"
        texts = []
        for j in range(p.getCount()):
            try:
                texts.append(p.getByIndex(j).getText().getString())
            except Exception:
                texts.append("<none>")
        out.append((name, num, texts))
    return out


# ---------------------------------------------------------------- A
print("=== A: text edits and undo ===")
doc = fresh_impress()
title = doc.getDrawPages().getByIndex(0).getByIndex(0)
undo_state(doc, "fresh")
title.getText().setString("A1 setString")
undo_state(doc, "after bare setString")

doc2 = fresh_impress()
title2 = doc2.getDrawPages().getByIndex(0).getByIndex(0)
um = doc2.getUndoManager()
um.enterUndoContext("A2")
try:
    cur = title2.getText().createTextCursor()
    cur.gotoEnd(False)
    title2.getText().insertString(cur, "A2 insertString", False)
finally:
    um.leaveUndoContext()
undo_state(doc2, "after cursor insertString in context")
do_undo(doc2, "cursor insertString")

doc3 = fresh_impress()
title3 = doc3.getDrawPages().getByIndex(0).getByIndex(0)
um = doc3.getUndoManager()
um.enterUndoContext("A3")
try:
    cur = title3.getText().createTextCursor()
    cur.gotoEnd(False)
    cur.setString("A3 cursor-setString")
finally:
    um.leaveUndoContext()
undo_state(doc3, "after cursor setString in context")
do_undo(doc3, "cursor setString")
print(f"  title3 text now: {title3.getText().getString()!r}")

# ---------------------------------------------------------------- B/C
print("=== B: page insertion routes and undo ===")
doc = fresh_impress()
pages = doc.getDrawPages()
um = doc.getUndoManager()
um.enterUndoContext("B-insert")
try:
    pages.insertNewByIndex(1)
finally:
    um.leaveUndoContext()
undo_state(doc, "insertNewByIndex in context")
print(f"  state: {page_state(doc)}")
do_undo(doc, "insertNewByIndex")
print(f"  state after undo: {page_state(doc)}")

print("=== B2: .uno:InsertPage — position + undo ===")
ctrl = doc.getCurrentController()
print(f"  before: {page_state(doc)}; current={ctrl.getCurrentPage().getName()!r}")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertPage", "", 0, ())
print(f"  after InsertPage (current was page1): {page_state(doc)}")
undo_state(doc, "after InsertPage dispatch")
do_undo(doc, "InsertPage dispatch")
print(f"  after undo: {page_state(doc)}")

print("=== B3: .uno:InsertPage with current page = 2nd of 3 ===")
pages.insertNewByIndex(0)  # now 3 pages: p0 blank, p1 orig, p2 blank
pages.insertNewByIndex(3)
print(f"  before: {page_state(doc)}")
ctrl.setCurrentPage(pages.getByIndex(1))
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertPage", "", 0, ())
print(f"  after InsertPage (current was index 1): {page_state(doc)}")

print("=== B4: .uno:DuplicatePage ===")
ctrl.setCurrentPage(pages.getByIndex(1))
n_before = pages.getCount()
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DuplicatePage", "", 0, ())
print(f"  pages {n_before} -> {pages.getCount()}")
print(f"  state: {page_state(doc)}")

print("=== C: shape add / dispose and undo ===")
doc = fresh_impress()
page = doc.getDrawPages().getByIndex(0)
um = doc.getUndoManager()
um.enterUndoContext("C-add")
try:
    sh = doc.createInstance("com.sun.star.drawing.TextShape")
    page.add(sh)
    sh.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
    sh.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
    sh.getText().setString("C added shape text")
finally:
    um.leaveUndoContext()
undo_state(doc, "after page.add in context")
do_undo(doc, "page.add")
print(f"  state after undo: {page_state(doc)}")

doc = fresh_impress()
page = doc.getDrawPages().getByIndex(0)
um = doc.getUndoManager()
um.enterUndoContext("C-dispose")
try:
    page.getByIndex(1).dispose()  # remove the subtitle shape
finally:
    um.leaveUndoContext()
undo_state(doc, "after shape dispose in context")
do_undo(doc, "shape dispose")
print(f"  shapes on page0 after undo: {page_state(doc)}")

# ---------------------------------------------------------------- E
print("=== E: mixed context — dispatch insert + API setString ===")
doc = fresh_impress()
pages = doc.getDrawPages()
ctrl = doc.getCurrentController()
um = doc.getUndoManager()
um.enterUndoContext("E-mixed")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertPage", "", 0, ())
    new_page = pages.getByIndex(1)
    t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
    new_page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3000))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 1000))
    t.getText().setString("E title on new page")
    b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    new_page.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 12000))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5000))
    b.getText().setString("E bullet one\nE bullet two")
finally:
    um.leaveUndoContext()
print(f"  state: {page_state(doc)}")
undo_state(doc, "after mixed edit")
do_undo(doc, "mixed edit")
print(f"  after ONE undo: {page_state(doc)}")

print("=== E2: mixed context — shape.add + setString on EXISTING page ===")
doc = fresh_impress()
pages = doc.getDrawPages()
page0 = pages.getByIndex(0)
um = doc.getUndoManager()
um.enterUndoContext("E2")
try:
    t = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    page0.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 8000))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5000))
    t.getText().setString("E2 body line 1\nE2 body line 2")
    title = page0.getByIndex(0)
    title.getText().setString("E2 rewritten title")
finally:
    um.leaveUndoContext()
undo_state(doc, "after E2")
do_undo(doc, "E2")
print(f"  after ONE undo: {page_state(doc)}")

print("=== probe 12c done ===")
