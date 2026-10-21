"""Probe 12b: follow-ups after probe 12 died at the undo() call.

Open questions from probe 12:
- undo manager EMPTY after edits -> is it LOCKED? (XUndoManager.lock/unlock/isLocked)
- does one enter/leaveUndoContext around setString become undoable once unlocked?
- multi-shape selection (title + subtitle) via ShapeCollection
- text write with \\n on subtitle + manual OutlinerShape: real paragraphs? separator?
- .uno:InsertSlide retry + .uno:InsertPage + undo of insertNewByIndex
- RecordChanges availability on impress
- selection-changed listener: ctrl.select / setCurrentPage / dispatch
- manual presentation shapes on a blank page
- draw smoke
"""

import uno
import unohelper
from com.sun.star.view import XSelectionChangeListener

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)


def describe_shape(shape):
    try:
        text = shape.getText().getString()
    except Exception:
        text = "<no text>"
    svc = []
    for s in ("com.sun.star.presentation.TitleTextShape",
              "com.sun.star.presentation.OutlinerShape",
              "com.sun.star.presentation.SubtitleShape",
              "com.sun.star.drawing.TextShape"):
        try:
            if shape.supportsService(s):
                svc.append(s.rsplit(".", 1)[-1])
        except Exception:
            pass
    return f"{shape.getShapeType()} svcs={svc} text={text!r}"


def para_texts(shape):
    out = []
    try:
        enum = shape.getText().createEnumeration()
        while enum.hasMoreElements():
            out.append(enum.nextElement().getString())
    except Exception as e:
        out.append(f"<enum failed: {e!r}>")
    return out


print("=== U1: undo manager lock state on a fresh impress doc ===")
imp = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
imp.getCurrentController().getFrame().activate()
um = imp.getUndoManager()
print(f"  isLocked={um.isLocked()} isUndoPossible={um.isUndoPossible()}")
title = imp.getDrawPages().getByIndex(0).getByIndex(0)
title.getText().setString("Before context")
print(f"  after bare setString: isLocked={um.isLocked()} "
      f"isUndoPossible={um.isUndoPossible()}")
um.enterUndoContext("probe")
try:
    title.getText().setString("In context")
finally:
    um.leaveUndoContext()
print(f"  after context edit: isLocked={um.isLocked()} "
      f"isUndoPossible={um.isUndoPossible()}")
if um.isLocked():
    try:
        um.unlock()
        print("  unlock() OK")
    except Exception as e:
        print(f"  unlock() failed: {e!r}")
    title.getText().setString("After unlock")
    print(f"  after unlock+setString: isLocked={um.isLocked()} "
          f"isUndoPossible={um.isUndoPossible()}")
    um.enterUndoContext("probe2")
    try:
        title.getText().setString("In context 2")
    finally:
        um.leaveUndoContext()
    print(f"  after 2nd context edit: isUndoPossible={um.isUndoPossible()}")
    try:
        um.undo()
        print(f"  ONE undo -> title={title.getText().getString()!r}")
    except Exception as e:
        print(f"  undo() failed: {e!r}")

print("=== U2: multi-shape selection (title + subtitle) ===")
ctrl = imp.getCurrentController()
page0 = imp.getDrawPages().getByIndex(0)
sub = page0.getByIndex(1)
coll = smgr.createInstanceWithContext("com.sun.star.drawing.ShapeCollection", ctx)
coll.add(title)
coll.add(sub)
ctrl.select(coll)
sel = ctrl.getSelection()
try:
    print(f"  multi selection count={sel.getCount()} "
          f"shapes={[sel.getByIndex(i).getShapeType() for i in range(sel.getCount())]}")
except Exception as e:
    print(f"  multi selection read failed: {e!r}")

print("=== U3: text write with \\n — subtitle + manual OutlinerShape ===")
sub.getText().setString("Line one\nLine two\nLine three")
raw = sub.getText().getString()
print(f"  subtitle raw={raw!r}")
print(f"  CR present: {chr(13) in raw}; paragraphs={para_texts(sub)}")

print("=== U4: insertNewByIndex + undo of it ===")
pages = imp.getDrawPages()
pages.insertNewByIndex(1)
print(f"  after insertNewByIndex(1): count={pages.getCount()} "
      f"new page shapes={[describe_shape(pages.getByIndex(1).getByIndex(j)) for j in range(pages.getByIndex(1).getCount())]}")
print(f"  isUndoPossible={um.isUndoPossible()}")
if um.isUndoPossible():
    um.undo()
    print(f"  after undo: count={pages.getCount()}")

print("=== U5: .uno:InsertSlide retry ===")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertSlide", "", 0, ())
    print(f"  after .uno:InsertSlide: count={pages.getCount()}")
    for i in range(pages.getCount()):
        p = pages.getByIndex(i)
        print(f"    page[{i}] shapes={[describe_shape(p.getByIndex(j)) for j in range(p.getCount())]}")
except Exception as e:
    print(f"  failed: {e!r}")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertPage", "", 0, ())
    print(f"  after .uno:InsertPage: count={pages.getCount()}")
except Exception as e:
    print(f"  InsertPage failed: {e!r}")

print("=== U6: RecordChanges on impress ===")
try:
    print(f"  get: {imp.getPropertyValue('RecordChanges')!r}")
except Exception as e:
    print(f"  get FAILED: {e!r}")
try:
    imp.setPropertyValue("RecordChanges", True)
    print("  set True: OK")
except Exception as e:
    print(f"  set FAILED: {e!r}")
try:
    print(f"  getRedlines: {imp.getRedlines()!r}")
except Exception as e:
    print(f"  getRedlines FAILED: {e!r}")

print("=== U7: selection-changed listener ===")


class ProbeSelListener(unohelper.Base, XSelectionChangeListener):
    hits = 0

    def selectionChanged(self, event):
        ProbeSelListener.hits += 1

    def disposing(self, source):
        pass


ctrl.addSelectionChangeListener(ProbeSelListener())
ctrl.select(sub)
print(f"  after ctrl.select(shape): hits={ProbeSelListener.hits}")
ctrl.setCurrentPage(pages.getByIndex(1))
print(f"  after setCurrentPage: hits={ProbeSelListener.hits}")
dispatcher.executeDispatch(ctrl.getFrame(), ".uno:NextPage", "", 0, ())
print(f"  after .uno:NextPage: hits={ProbeSelListener.hits}")

print("=== U8: manual presentation shapes on a blank page ===")
blank = pages.getByIndex(1) if pages.getCount() > 1 else None
try:
    t = imp.createInstance("com.sun.star.presentation.TitleTextShape")
    blank.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 3000))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 1000))
    t.getText().setString("Manual title")
    b = imp.createInstance("com.sun.star.presentation.OutlinerShape")
    blank.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 24000, 12000))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 2000, 5000))
    b.getText().setString("Manual bullet one\nManual bullet two")
    print(f"  shapes: {[describe_shape(blank.getByIndex(j)) for j in range(blank.getCount())]}")
    print(f"  outliner raw={b.getText().getString()!r}")
    print(f"  outliner paragraphs={para_texts(b)}")
except Exception as e:
    print(f"  manual creation failed: {e!r}")

print("=== U9: draw smoke ===")
drw = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, ())
drw.getCurrentController().getFrame().activate()
dpage = drw.getDrawPages().getByIndex(0)
t = drw.createInstance("com.sun.star.drawing.TextShape")
dpage.add(t)
t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
t.getText().setString("Draw text\nSecond line")
print(f"  shape: {describe_shape(t)}")
print(f"  paragraphs={para_texts(t)}")
dum = drw.getUndoManager()
print(f"  draw isLocked={dum.isLocked()} isUndoPossible={dum.isUndoPossible()}")
try:
    print(f"  draw RecordChanges: {drw.getPropertyValue('RecordChanges')!r}")
except Exception as e:
    print(f"  draw RecordChanges FAILED: {e!r}")

print("=== probe 12b done ===")
