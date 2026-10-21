"""Probe 10: tracked delete-at via the DISPATCHER (.uno:Delete) instead of
raw setString, inside the bridge's exact flow (undo context + tracking).
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK


def fresh():
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    for s in ("A", "B"):
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        if s != "A":
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        text.insertString(cur, s, False)
    return doc


def state(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]


def redlines(doc):
    return len(list(doc.getRedlines().createEnumeration()))


def insert_after_tracked(doc, target, content):
    doc.setPropertyValue("RecordChanges", True)
    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        text = doc.getText()
        vc = doc.getCurrentController().getViewCursor()
        para = list(text.createEnumeration())[target - 1]
        vc.gotoRange(para.getEnd(), False)
        text.insertControlCharacter(vc, PARAGRAPH_BREAK, False)
        text.insertString(vc, content, False)
    finally:
        um.leaveUndoContext()
    doc.setPropertyValue("RecordChanges", False)


def delete_at_dispatch(doc, target):
    doc.setPropertyValue("RecordChanges", True)
    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        text = doc.getText()
        vc = doc.getCurrentController().getViewCursor()
        para = list(text.createEnumeration())[target - 1]
        vc.gotoRange(para.getStart(), False)
        ok = vc.goRight(len(para.getString()) + 1, True)
        if not ok:
            vc.goRight(len(para.getString()), True)
        frame = doc.getCurrentController().getFrame()
        dispatcher = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.frame.DispatchHelper", ctx)
        dispatcher.executeDispatch(frame, ".uno:Delete", "", 0, ())
    finally:
        um.leaveUndoContext()
    doc.setPropertyValue("RecordChanges", False)


# D1: original content, tracked, dispatch delete
doc = fresh()
print("D1 start:", state(doc))
delete_at_dispatch(doc, 1)
print("D1 dispatch delete p1 (original, tracked):", state(doc), "redlines:", redlines(doc))

# D2: unaccepted insertion, tracked, dispatch delete
doc = fresh()
insert_after_tracked(doc, 1, "INSERTED")
print("D2 after insert:", state(doc), "redlines:", redlines(doc))
delete_at_dispatch(doc, 2)
print("D2 dispatch delete p2 (unaccepted insertion):", state(doc), "redlines:", redlines(doc))

# D3: accept-all after D1-style pending deletion — does the paragraph vanish?
doc = fresh()
delete_at_dispatch(doc, 1)
print("D3 before accept:", state(doc), "redlines:", redlines(doc))
dispatcher = ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.frame.DispatchHelper", ctx)
dispatcher.executeDispatch(doc.getCurrentController().getFrame(), ".uno:AcceptAllTrackedChanges", "", 0, ())
print("D3 after accept-all:", state(doc), "redlines:", redlines(doc))