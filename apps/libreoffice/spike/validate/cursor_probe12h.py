"""Probe 12h: DeletePage dispatch semantics + lock suppression + slide styling.

Known so far:
- um.lock()/unlock() suppresses API-op undo actions (12f L1)
- page.dispose() does NOT remove the page (corrupts it) — never use
- .uno:DeletePage dispatch removes a page; which one is TBD (current?)
- XDrawPages has no removeByIndex

To answer:
H1  DeletePage target: 3 marker pages, setCurrentPage(middle) -> which dies?
H2  lock() around DeletePage -> native stack stays empty?
H3  DeletePage without lock -> undoable? undo restores the page?
H4  .uno:InsertPage placeholder geometry + paragraph style/CharHeight
H5  manual title/outliner: default style; setting ParaStyleName Title/Outline
H6  full s0 choreography: insertNewByIndex(0)+shapes+text under lock; revert
    via setCurrentPage+DeletePage under lock
H7  selected shape == comparison across pages
H8  .uno:InsertSlide / .uno:DuplicatePage position with verified current page
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


def marker_deck(doc):
    """3 slides; slide 0 keeps its factory title+subtitle (S1), slides
    1-2 are API-inserted (empty) and get a marker TextShape."""
    pages = doc.getDrawPages()
    pages.getByIndex(0).getByIndex(0).getText().setString("S1")
    while pages.getCount() < 3:
        idx = pages.getCount()
        pages.insertNewByIndex(idx)
        sh = doc.createInstance("com.sun.star.drawing.TextShape")
        pages.getByIndex(idx).add(sh)
        sh.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
        sh.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
        sh.getText().setString(f"S{idx + 1}")
    return pages


print("=== H1: DeletePage target ===")
doc = fresh()
pages = marker_deck(doc)
ctrl = doc.getCurrentController()
ctrl.setCurrentPage(pages.getByIndex(1))
cur = ctrl.getCurrentPage()
cur_title = cur.getByIndex(0).getText().getString()
print(f"  current page title: {cur_title!r} (want S2)")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
print(f"  after DeletePage: {state(doc)}")

print("=== H2: lock around DeletePage ===")
doc = fresh()
pages = marker_deck(doc)
ctrl = doc.getCurrentController()
um = doc.getUndoManager()
um.lock()
try:
    ctrl.setCurrentPage(pages.getByIndex(1))
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
finally:
    um.unlock()
print(f"  state: {state(doc)}")
print(f"  undoPossible={um.isUndoPossible()} (want False)")

print("=== H3: DeletePage WITHOUT lock -> undo ===")
doc = fresh()
pages = marker_deck(doc)
ctrl = doc.getCurrentController()
um = doc.getUndoManager()
ctrl.setCurrentPage(pages.getByIndex(1))
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
print(f"  state: {state(doc)}; undoPossible={um.isUndoPossible()}")
if um.isUndoPossible():
    um.undo()
    print(f"  after ONE undo: {state(doc)}")

print("=== H4: InsertPage placeholder geometry + styles ===")
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
        style = height = "?"
        try:
            enum = s.getText().createEnumeration()
            if enum.hasMoreElements():
                para = enum.nextElement()
                style = para.getPropertyValue("ParaStyleName")
                height = para.getPropertyValue("CharHeight")
        except Exception as e:
            style = f"<err {e!r}>"
        print(f"  page[{i}].shape[{j}] {s.getShapeType().rsplit('.', 1)[-1]}"
              f" pos=({pos.X},{pos.Y}) size=({size.Width},{size.Height})"
              f" style={style!r} charHeight={height}")

print("=== H5: manual presentation shapes - default styling + ParaStyleName ===")
doc = fresh()
page = doc.getDrawPages().getByIndex(0)
t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
page.add(t)
t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3500))
t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 875))


def para_info(shape, label):
    para = shape.getText().createEnumeration().nextElement()
    style = height = "?"
    try:
        style = para.getPropertyValue("ParaStyleName")
    except Exception as e:
        style = f"<{type(e).__name__}>"
    try:
        height = para.getPropertyValue("CharHeight")
    except Exception as e:
        height = f"<{type(e).__name__}>"
    print(f"  {label}: style={style!r} charHeight={height}")
    return para


t.getText().setString("Manual raw")
para_info(t, "manual title after setString (default style)")
para = t.getText().createEnumeration().nextElement()
try:
    para.setPropertyValue("ParaStyleName", "Title")
    para_info(t, "after ParaStyleName=Title")
except Exception as e:
    print(f"  set ParaStyleName failed: {e!r}")
b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
page.add(b)
b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 25199, 9134))
b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1400, 3685))
b.getText().setString("Bullet A\nBullet B")
para_info(b, "manual outliner after setString")
para = b.getText().createEnumeration().nextElement()
try:
    para.setPropertyValue("ParaStyleName", "Outline")
    para_info(b, "outliner after ParaStyleName=Outline")
except Exception as e:
    print(f"  set Outline failed: {e!r}")

print("=== H6: full s0 choreography + journal revert ===")
doc = fresh()
pages = marker_deck(doc)
um = doc.getUndoManager()
orig = state(doc)
um.lock()
try:
    pages.insertNewByIndex(0)
    page = pages.getByIndex(0)
    t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3500))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 875))
    t.getText().setString("NEW FIRST")
    b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    page.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 12000))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5600))
    b.getText().setString("First new bullet\nSecond new bullet")
finally:
    um.unlock()
after_insert = state(doc)
print(f"  after insert-at-0: {after_insert}")
print(f"  undoPossible={um.isUndoPossible()} (want False)")
# journal revert: delete the page we added (index 0)
ctrl = doc.getCurrentController()
um.lock()
try:
    ctrl.setCurrentPage(pages.getByIndex(0))
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
finally:
    um.unlock()
print(f"  after revert: {state(doc)}")
print(f"  original was: {orig}")
print(f"  undoPossible={um.isUndoPossible()} (want False)")

print("=== H7: selected shape == across pages ===")
doc = fresh()
pages = marker_deck(doc)
ctrl = doc.getCurrentController()
target_shape = pages.getByIndex(2).getByIndex(0)  # title of S3
ctrl.select(target_shape)
sel = ctrl.getSelection()
got = sel.getByIndex(0)
found = None
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    for j in range(p.getCount()):
        if p.getByIndex(j) == got:
            found = (i, j)
print(f"  selected shape found at (slide, shape): {found} (want (2, 0))")

print("=== H8: InsertSlide / DuplicatePage with verified current page ===")
doc = fresh()
pages = marker_deck(doc)
ctrl = doc.getCurrentController()
ctrl.setCurrentPage(pages.getByIndex(1))
print(f"  current is S2: {ctrl.getCurrentPage().getByIndex(0).getText().getString()!r}")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertSlide", "", 0, ())
print(f"  after .uno:InsertSlide: {state(doc)}")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DuplicatePage", "", 0, ())
print(f"  after .uno:DuplicatePage: {state(doc)}")

print("=== probe 12h done ===")
