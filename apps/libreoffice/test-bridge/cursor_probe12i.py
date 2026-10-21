"""Probe 12i: Draw controller view APIs (needed for the journal revert).

Verify on private:factory/sdraw: getCurrentPage, setCurrentPage,
getSelection, and .uno:DeletePage with setCurrentPage steering.
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)

doc = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, ())
doc.getCurrentController().getFrame().activate()
pages = doc.getDrawPages()
while pages.getCount() < 3:
    idx = pages.getCount()
    pages.insertNewByIndex(idx)
    sh = doc.createInstance("com.sun.star.drawing.TextShape")
    pages.getByIndex(idx).add(sh)
    sh.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
    sh.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
    sh.getText().setString(f"D{idx + 1}")

ctrl = doc.getCurrentController()
try:
    cur = ctrl.getCurrentPage()
    match = [i for i in range(pages.getCount()) if cur == pages.getByIndex(i)]
    print(f"getCurrentPage matches index {match}")
except Exception as e:
    print(f"getCurrentPage FAILED: {e!r}")
try:
    ctrl.setCurrentPage(pages.getByIndex(1))
    cur = ctrl.getCurrentPage()
    match = [i for i in range(pages.getCount()) if cur == pages.getByIndex(i)]
    print(f"after setCurrentPage(1): matches {match}")
except Exception as e:
    print(f"setCurrentPage FAILED: {e!r}")
try:
    sel = ctrl.getSelection()
    print(f"getSelection with nothing: {sel!r}")
except Exception as e:
    print(f"getSelection FAILED: {e!r}")
sh = pages.getByIndex(1).getByIndex(0)
ctrl.select(sh)
sel = ctrl.getSelection()
try:
    print(f"selection: count={sel.getCount()} [0]={sel.getByIndex(0).getShapeType()}")
except Exception as e:
    print(f"selection read failed: {e!r}")

um = doc.getUndoManager()
um.lock()
try:
    ctrl.setCurrentPage(pages.getByIndex(1))
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:DeletePage", "", 0, ())
finally:
    um.unlock()
texts = []
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    texts.append([p.getByIndex(j).getText().getString() for j in range(p.getCount())])
print(f"after locked DeletePage(current=D2): count={pages.getCount()} texts={texts}")
print(f"undoPossible={um.isUndoPossible()} (want False)")
