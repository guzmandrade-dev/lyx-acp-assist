"""Probe 12: Impress/Draw UNO mechanics for Phase 3.

Questions (see next-steps.md section 3.1):
1  slide enumeration (getDrawPages / XDrawPages / pages per index)
2  shape roles (supportsService presentation/drawing services, IsPresentationShape)
3  text read separator (getString \\n vs \\r\\n)
4  text write (setString with \\n -> real paragraphs?)
5  current slide (ctrl.getCurrentPage() + index discovery)
6  selection (shape selected; multi-shape; shape collection shapes)
7  insert slide (insertNewByIndex vs .uno:InsertSlide dispatch; placeholders?)
8  undo (one context = one revert)
9  RecordChanges availability
10 selection-changed listener on an Impress controller
11 Draw smoke (private:factory/sdraw)
12 fallback: create presentation shapes by hand on a blank page

Run against the socket-connected soffice, same as earlier probes:
  "C:\\Program Files\\LibreOffice\\program\\python.exe" cursor_probe12.py
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)

SERVICES = (
    "com.sun.star.presentation.TitleTextShape",
    "com.sun.star.presentation.OutlinerShape",
    "com.sun.star.presentation.SubtitleShape",
    "com.sun.star.presentation.NotesShape",
    "com.sun.star.drawing.TextShape",
    "com.sun.star.drawing.OvalShape",
)


def describe_shape(shape):
    svcs = [s.rsplit(".", 1)[-1] for s in SERVICES
            if _supports(shape, s)]
    props = {}
    for prop in ("IsPresentationShape", "IsTitleShape"):
        try:
            props[prop] = shape.getPropertyValue(prop)
        except Exception:
            props[prop] = "<absent>"
    try:
        text = shape.getText().getString()
    except Exception as e:
        text = f"<no text: {e!r}>"
    return f"{shape.getShapeType()} svcs={svcs} props={props} text={text!r}"


def _supports(obj, svc):
    try:
        return obj.supportsService(svc)
    except Exception:
        return False


def dump_pages(doc, label):
    pages = doc.getDrawPages()
    print(f"  [{label}] pageCount={pages.getCount()}")
    current = None
    try:
        current = doc.getCurrentController().getCurrentPage()
    except Exception as e:
        print(f"  getCurrentPage failed: {e!r}")
    for i in range(pages.getCount()):
        page = pages.getByIndex(i)
        name = num = "<absent>"
        try:
            name = page.getName()
        except Exception:
            pass
        try:
            num = page.getPropertyValue("Number")
        except Exception:
            pass
        cur = ""
        try:
            if current is not None and page.getName() == current.getName():
                cur = " <CURRENT>"
        except Exception:
            pass
        print(f"  page[{i}] name={name!r} number={num!r}{cur}")
        for j in range(page.getCount()):
            print(f"    shape[{j}]: {describe_shape(page.getByIndex(j))}")
    return current


def para_texts(shape):
    out = []
    try:
        enum = shape.getText().createEnumeration()
        while enum.hasMoreElements():
            out.append(enum.nextElement().getString())
    except Exception as e:
        out.append(f"<enum failed: {e!r}>")
    return out


# ---------------------------------------------------------------- P1-P4
print("=== P1: Impress factory doc — enumeration, roles, text separators ===")
imp = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
imp.getCurrentController().getFrame().activate()
dump_pages(imp, "fresh simpress")

pages = imp.getDrawPages()
page1 = pages.getByIndex(0)
shapes = [page1.getByIndex(j) for j in range(page1.getCount())]
title = next((s for s in shapes
              if _supports(s, "com.sun.star.presentation.TitleTextShape")), None)
body = next((s for s in shapes
             if _supports(s, "com.sun.star.presentation.OutlinerShape")), None)
print(f"  title found: {title is not None}, body found: {body is not None}")

print("=== P4: text write — setString with \\n ===")
if title is not None:
    title.getText().setString("Written title")
    print(f"  title after setString: {title.getText().getString()!r}")
if body is not None:
    body.getText().setString("First bullet\nSecond bullet\nThird bullet")
    raw = body.getText().getString()
    print(f"  body raw string: {raw!r}")
    print(f"  body \\r\\n present: {chr(13) in raw}")
    print(f"  body paragraphs via enumeration: {para_texts(body)}")

# ---------------------------------------------------------------- P5-P6
print("=== P5: current page + selection ===")
ctrl = imp.getCurrentController()
cur = ctrl.getCurrentPage()
try:
    print(f"  currentPage name={cur.getName()!r} Number={cur.getPropertyValue('Number')!r}")
except Exception as e:
    print(f"  currentPage props failed: {e!r}")
try:
    same = uno.any
except Exception:
    pass
# identity comparison (pyuno rule 9: `is` is always False — check anyway)
print(f"  cur is page1: {cur is page1}; == page1: {cur == page1}")

sel = ctrl.getSelection()
print(f"  selection with nothing selected: type={type(sel).__name__} str={sel!r}")
if title is not None:
    ctrl.select(title)
    sel = ctrl.getSelection()
    print(f"  selection after ctrl.select(title): {sel!r}")
    print(f"     supports ShapeCollection: {_supports(sel, 'com.sun.star.drawing.ShapeCollection')}")
    try:
        print(f"    count={sel.getCount()}, [0]={sel.getByIndex(0).getShapeType()}"
              if sel.getCount() else "    count=0")
    except Exception as e:
        print(f"    as XShapes failed: {e!r}")
    # multi-select: title + body together
    from com.sun.star.drawing import XShapes  # noqa: F401  (import check only)
    coll = smgr.createInstanceWithContext("com.sun.star.drawing.ShapeCollection", ctx)
    coll.add(title)
    coll.add(body)
    ctrl.select(coll)
    sel = ctrl.getSelection()
    print(f"  selection after multi-select: {sel!r}")
    try:
        names = [sel.getByIndex(i).getShapeType() for i in range(sel.getCount())]
        print(f"    multi selection shapes: {names}")
    except Exception as e:
        print(f"    multi as XShapes failed: {e!r}")

# ---------------------------------------------------------------- P7
print("=== P7: insertNewByIndex — what does the new page contain? ===")
pages.insertNewByIndex(1)
dump_pages(imp, "after insertNewByIndex(1)")
p_new = pages.getByIndex(1)
print(f"  new page shapes: {[describe_shape(p_new.getByIndex(j)) for j in range(p_new.getCount())]}")

print("=== P7b: .uno:InsertSlide dispatch — layout placeholders? ===")
# current page is page1 (index 0); dispatch should insert after it
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:InsertSlide", "", 0, ())
    dump_pages(imp, "after .uno:InsertSlide (current page was index 0)")
except Exception as e:
    print(f"  .uno:InsertSlide failed: {e!r}")

# ---------------------------------------------------------------- P8
print("=== P8: undo contexts ===")
um = imp.getUndoManager()
print(f"  undo possible before: {um.isUndoPossible()}")
um.enterUndoContext("ACP probe")
try:
    if title is not None:
        title.getText().setString("Undo me")
finally:
    um.leaveUndoContext()
print(f"  title now: {title.getText().getString()!r}; undo possible: {um.isUndoPossible()}")
um.undo()
print(f"  after ONE undo: {title.getText().getString()!r}")

# ---------------------------------------------------------------- P9
print("=== P9: RecordChanges on Impress ===")
try:
    print(f"  get RecordChanges: {imp.getPropertyValue('RecordChanges')!r}")
except Exception as e:
    print(f"  get RecordChanges FAILED: {e!r}")
try:
    imp.setPropertyValue("RecordChanges", True)
    print("  set RecordChanges True: OK")
except Exception as e:
    print(f"  set RecordChanges FAILED: {e!r}")
try:
    print(f"  getRedlines: {imp.getRedlines()!r}")
except Exception as e:
    print(f"  getRedlines FAILED: {e!r}")

# ---------------------------------------------------------------- P10
print("=== P10: selection-changed listener ===")
import unohelper
from com.sun.star.view import XSelectionChangeListener


class ProbeSelListener(unohelper.Base, XSelectionChangeListener):
    events = []

    def selectionChanged(self, event):
        ProbeSelListener.events.append("sel")

    def disposing(self, source):
        pass


ctrl.addSelectionChangeListener(ProbeSelListener())
# switch slides via XDrawView setCurrentPage
try:
    ctrl.setCurrentPage(pages.getByIndex(2))
except Exception as e:
    print(f"  setCurrentPage failed: {e!r}")
print(f"  events after setCurrentPage: {len(ProbeSelListener.events)}")
if title is not None:
    ctrl.select(title)
print(f"  events after ctrl.select(shape): {len(ProbeSelListener.events)}")
try:
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:NextPage", "", 0, ())
except Exception as e:
    print(f"  .uno:NextPage failed: {e!r}")
print(f"  events after .uno:NextPage dispatch: {len(ProbeSelListener.events)}")

# ---------------------------------------------------------------- P12
print("=== P12: create presentation shapes by hand on a blank page ===")
pages.insertNewByIndex(3)
blank = pages.getByIndex(3)
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
    print(f"  manual page shapes: {[describe_shape(blank.getByIndex(j)) for j in range(blank.getCount())]}")
    print(f"  body paragraphs: {para_texts(b)}")
except Exception as e:
    print(f"  manual shape creation failed: {e!r}")

# ---------------------------------------------------------------- P11
print("=== P11: Draw smoke ===")
drw = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, ())
drw.getCurrentController().getFrame().activate()
dump_pages(drw, "fresh sdraw")
dpage = drw.getDrawPages().getByIndex(0)
t = drw.createInstance("com.sun.star.drawing.TextShape")
dpage.add(t)
t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
t.getText().setString("Draw text\nSecond line")
print(f"  draw shape: {describe_shape(t)}")
print(f"  draw shape paragraphs: {para_texts(t)}")
try:
    print(f"  draw RecordChanges: {drw.getPropertyValue('RecordChanges')!r}")
except Exception as e:
    print(f"  draw RecordChanges FAILED: {e!r}")

print("=== probe 12 done ===")
