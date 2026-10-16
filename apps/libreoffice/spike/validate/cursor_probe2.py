"""Probe 2: delete-a-paragraph choreography under tracked changes.

Candidates:
A) range cursor over para, goRight(1, True) (extend over break), setString("")
B) collapsed cursor at para start, goRight(len+1, True), setString("")
Both with RecordChanges on (the bridge's real operating mode).
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
text = doc.Text

def seed():
    text.setString("")
    cur = text.createTextCursor()
    text.insertString(cur, "A", False)
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "B", False)
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "C", False)

def paras():
    return [p.getString() for p in text.createEnumeration()]

seed()
print("start:", paras())

# Variant A: range cursor + goRight(1, True)
doc.setPropertyValue("RecordChanges", True)
p = list(text.createEnumeration())[1]  # "B"
cur = text.createTextCursorByRange(p)
cur.goRight(1, True)
print("A selection text:", repr(cur.getString()))
cur.setString("")
print("variant A:", paras())
print("redlines:", [r.getPropertyValue("RedlineType") for r in doc.getRedlines().createEnumeration()])

# undo to reset
doc.getUndoManager().undo()
print("after undo:", paras())

# Variant B: collapsed at start, goRight(len+1, True)
p = list(text.createEnumeration())[1]  # "B"
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
ok = cur.goRight(n + 1, True)
print("B could extend over break:", ok, "selection:", repr(cur.getString()))
cur.setString("")
print("variant B:", paras())
doc.getUndoManager().undo()
print("after undo:", paras())

# Variant C: delete LAST paragraph (no break to eat) with variant B logic
p = list(text.createEnumeration())[2]  # "C"
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
ok = cur.goRight(n + 1, True)
print("C could extend over break:", ok, "selection:", repr(cur.getString()))
cur.setString("")
print("variant C:", paras())
doc.getUndoManager().undo()
print("after undo:", paras())

# Variant D: rewrite-at full choreography (setString("") + re-anchor + insert)
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
p = list(text.createEnumeration())[1]  # "B"
cur = text.createTextCursorByRange(p)
cur.setString("")
cur = text.createTextCursorByRange(p.getStart())
text.insertString(cur, "R1 first", False)
cur.goLeft(len("R1 first"), True)
cur.setPropertyValue("CharWeight", 150.0)
cur.goRight(len("R1 first"), False)
cur.setPropertyValue("ParaStyleName", "Heading 3")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "R2 second", False)
cur.goLeft(len("R2 second"), True)
cur.setPropertyValue("CharWeight", 100.0)
cur.goRight(len("R2 second"), False)
print("variant D (rewrite-at choreography):", paras())
enum = list(text.createEnumeration())
print("  styles:", [e.getPropertyValue("ParaStyleName") for e in enum])
print("  weights:", [e.getPropertyValue("CharWeight") for e in enum])
doc.setPropertyValue("RecordChanges", False)