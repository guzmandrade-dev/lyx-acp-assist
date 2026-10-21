"""Probe 12d: per-operation undo isolation in Impress.

Probe 12c gave contradictory signals (undo "OK" but state unchanged; a
presentation-shape add seemingly removed by undo while a setString was not).
This probe isolates every operation on a fresh document, marks everything
with unique texts, and prints state before/after undo (and redo).

Scenarios (each on a fresh simpress doc):
 s1  ctx { title setString }
 s2  ctx { add plain drawing.TextShape }
 s3  ctx { add presentation.OutlinerShape }
 s4  ctx { add presentation.TitleTextShape }
 s5  ctx { insertNewByIndex(1) }
 s6  ctx { .uno:InsertPage dispatch }
 s7  ctx { shape dispose }
 s8  ctx { shape setPosition }
 s9  no ctx { title setString }  (bare)
 s10 no ctx { insertNewByIndex(1) } (bare)
 s11 ctx { add OutlinerShape + setString on it }
 s12 ctx { title setString; THEN add OutlinerShape; then setString again }
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)


def fresh():
    doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
    doc.getCurrentController().getFrame().activate()
    return doc


def state(doc):
    """Marked state: page texts per page + shape types."""
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


def make_shape(doc, svc, text, w=24000, h=3000, x=2000, y=2000):
    sh = doc.createInstance(svc)
    doc.getDrawPages().getByIndex(0).add(sh)
    sh.setSize(uno.createUnoStruct("com.sun.star.awt.Size", w, h))
    sh.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", x, y))
    sh.getText().setString(text)
    return sh


def run(name, ops, context=True, undo_after=True):
    doc = fresh()
    um = doc.getUndoManager()
    print(f"--- {name} (context={context}) ---")
    if context:
        um.enterUndoContext(name)
    try:
        ops(doc)
    finally:
        if context:
            um.leaveUndoContext()
    print(f"  after ops:      undoPossible={um.isUndoPossible()} state={state(doc)}")
    if undo_after and um.isUndoPossible():
        um.undo()
        print(f"  after undo:     redoPossible={um.isRedoPossible()} state={state(doc)}")
        if um.isRedoPossible():
            um.redo()
            print(f"  after redo:     state={state(doc)}")
    return doc


run("s1 ctx title setString",
    lambda d: d.getDrawPages().getByIndex(0).getByIndex(0)
    .getText().setString("S1 TITLE"))

run("s2 ctx add drawing.TextShape",
    lambda d: make_shape(d, "com.sun.star.drawing.TextShape", "S2 plain", h=2000))

run("s3 ctx add presentation.OutlinerShape",
    lambda d: make_shape(d, "com.sun.star.presentation.OutlinerShape", "S3 outliner"))

run("s4 ctx add presentation.TitleTextShape",
    lambda d: make_shape(d, "com.sun.star.presentation.TitleTextShape", "S4 title"))

run("s5 ctx insertNewByIndex(1)",
    lambda d: d.getDrawPages().insertNewByIndex(1))

run("s6 ctx .uno:InsertPage",
    lambda d: dispatcher.executeDispatch(
        d.getCurrentController().getFrame(), ".uno:InsertPage", "", 0, ()))


def s7(d):
    page = d.getDrawPages().getByIndex(0)
    page.getByIndex(1).dispose()  # subtitle shape


run("s7 ctx shape dispose", s7)


def s8(d):
    page = d.getDrawPages().getByIndex(0)
    t = page.getByIndex(0)
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 9000, 9000))


run("s8 ctx shape move", s8)

run("s9 BARE title setString",
    lambda d: d.getDrawPages().getByIndex(0).getByIndex(0)
    .getText().setString("S9 TITLE"), context=False)

run("s10 BARE insertNewByIndex(1)",
    lambda d: d.getDrawPages().insertNewByIndex(1), context=False)


def s11(d):
    sh = make_shape(d, "com.sun.star.presentation.OutlinerShape", "S11 line1\nS11 line2")
    sh.getText().setString("S11 AGAIN")


run("s11 ctx add outliner + setString on it", s11)


def s12(d):
    page = d.getDrawPages().getByIndex(0)
    page.getByIndex(0).getText().setString("S12 step1")
    make_shape(d, "com.sun.star.presentation.OutlinerShape", "S12 outliner")
    page.getByIndex(0).getText().setString("S12 step3")


run("s12 ctx setString, add, setString", s12)

print("=== probe 12d done ===")
