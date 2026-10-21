"""Probe 8: tracked delete-at inside an undo context (the bridge flow).

Isolates which combination fails silently: tracking x undo context x
selection including the paragraph break.
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)


def fresh():
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    for s in ("A", "B", "C"):
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        if s != "A":
            from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        text.insertString(cur, s, False)
    return doc


def state(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]


def redlines(doc):
    return len(list(doc.getRedlines().createEnumeration()))


# V1: tracked + NO undo context + text+break selection
doc = fresh()
doc.setPropertyValue("RecordChanges", True)
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[1]
vc.gotoRange(para.getStart(), False)
vc.goRight(len(para.getString()) + 1, True)
print("V1 sel:", repr(vc.getString()))
vc.setString("")
print("V1 tracked, no undo ctx, text+break:", state(doc), "redlines:", redlines(doc))

# V2: tracked + undo context + text+break selection (the bridge flow)
doc = fresh()
doc.setPropertyValue("RecordChanges", True)
um = doc.getUndoManager()
um.enterUndoContext("ACP edit")
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[1]
vc.gotoRange(para.getStart(), False)
ok = vc.goRight(len(para.getString()) + 1, True)
print("V2 sel:", repr(vc.getString()), "ok:", ok)
vc.setString("")
print("V2 sel after setString:", repr(vc.getString()))
um.leaveUndoContext()
print("V2 tracked, undo ctx, text+break:", state(doc), "redlines:", redlines(doc))

# V3: tracked + undo context + TEXT-ONLY selection (rewrite-at shape)
doc = fresh()
doc.setPropertyValue("RecordChanges", True)
um = doc.getUndoManager()
um.enterUndoContext("ACP edit")
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[1]
vc.gotoRange(para.getStart(), False)
vc.goRight(len(para.getString()), True)
print("V3 sel:", repr(vc.getString()))
vc.setString("")
print("V3 sel after setString:", repr(vc.getString()))
um.leaveUndoContext()
print("V3 tracked, undo ctx, text-only:", state(doc), "redlines:", redlines(doc))