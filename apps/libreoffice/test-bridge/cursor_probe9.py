"""Probe 9: tracked delete of a paragraph that is itself an UNACCEPTED
insertion (the live-session anomaly: bridge reported applied but nothing
happened). Reproduces session-1-insert + session-2-delete.
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


def bridge_insert_after(doc, target, content):
    """Bridge insert-after: tracked, undo context, view cursor."""
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


def bridge_delete_at(doc, target):
    """Bridge delete-at: tracked, undo context, view cursor."""
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
        vc.setString("")
    finally:
        um.leaveUndoContext()
    doc.setPropertyValue("RecordChanges", False)


# Reproduce the live session flow
doc = fresh()
print("start:", state(doc))
bridge_insert_after(doc, 1, "INSERTED")
print("after tracked insert-after p1:", state(doc), "redlines:", redlines(doc))

bridge_delete_at(doc, 2)  # delete the unaccepted insertion
print("after tracked delete-at p2 (unaccepted insertion):", state(doc), "redlines:", redlines(doc))

# Control: tracked delete of ORIGINAL content (p1)
bridge_delete_at(doc, 1)
print("after tracked delete-at p1 (original content):", state(doc), "redlines:", redlines(doc))