"""Probe 11: two-pass delete-at via dispatch — the second pass removes the
empty paragraph left behind when deleting never-accepted insertions.
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


def dispatch_delete(doc):
    dispatcher = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.DispatchHelper", ctx)
    dispatcher.executeDispatch(doc.getCurrentController().getFrame(), ".uno:Delete", "", 0, ())


def delete_at(doc, target, two_pass=True):
    doc.setPropertyValue("RecordChanges", True)
    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        text = doc.getText()
        vc = doc.getCurrentController().getViewCursor()
        para = _nth(doc, target)
        vc.gotoRange(para.getStart(), False)
        if not vc.goRight(len(para.getString()) + 1, True):
            vc.goRight(len(para.getString()), True)
        dispatch_delete(doc)
        if two_pass:
            paras = [p.getString() for p in text.createEnumeration()]
            if len(paras) >= target and paras[target - 1] == "":
                # Coalescing artifact: the paragraph was a never-accepted
                # insertion; its text cancelled but an empty paragraph
                # remains. Remove the empty paragraph too.
                empty = _nth(doc, target)
                vc.gotoRange(empty.getStart(), False)
                vc.goRight(1, True)
                dispatch_delete(doc)
    finally:
        um.leaveUndoContext()
    doc.setPropertyValue("RecordChanges", False)


def _nth(doc, n):
    return list(doc.getText().createEnumeration())[n - 1]


# P1: delete never-accepted insertion, two-pass
doc = fresh()
insert_after_tracked(doc, 1, "INSERTED")
print("P1 after insert:", state(doc))
delete_at(doc, 2)
print("P1 two-pass delete of insertion:", state(doc), "redlines:", redlines(doc))

# P2: delete original content, two-pass (second pass must NOT fire)
doc = fresh()
delete_at(doc, 1)
print("P2 two-pass delete of original:", state(doc), "redlines:", redlines(doc))

# P3: undo the P1-style delete — one transaction restores everything
doc = fresh()
insert_after_tracked(doc, 1, "INSERTED")
delete_at(doc, 2)
print("P3 before undo:", state(doc), "redlines:", redlines(doc))
doc.getUndoManager().undo()
print("P3 after ONE undo:", state(doc), "redlines:", redlines(doc))