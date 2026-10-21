"""Probe 3: tracked-changes-safe choreography for delete-at / rewrite-at.

Each variant gets a FRESH document. Checks whether paragraph enumeration
includes redlined-deleted text, and which delete/replace choreography
behaves correctly under RecordChanges.
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK

def fresh(track):
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    cur = text.createTextCursor()
    text.insertString(cur, "A", False)
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "B", False)
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "C", False)
    doc.setPropertyValue("RecordChanges", track)
    return doc, doc.getText()

def paras(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]

# V1: delete middle paragraph (text + break) with tracking ON
doc, text = fresh(track=True)
p = list(text.createEnumeration())[1]
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
ok = cur.goRight(n + 1, True)
print("V1 extend over break:", ok, "selection:", repr(cur.getString()))
cur.setString("")
print("V1 (tracked delete of B):", paras(doc))

# V2: delete via removeTextContent with tracking ON
doc, text = fresh(track=True)
p = list(text.createEnumeration())[1]
text.removeTextContent(p)
print("V2 (tracked removeTextContent of B):", paras(doc))

# V3: rewrite middle paragraph with tracking ON: select old text, absorb replace
doc, text = fresh(track=True)
p = list(text.createEnumeration())[1]
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
cur.goRight(n, True)
text.insertString(cur, "R1", True)  # absorb=True replaces the selection
cur.goLeft(2, True)
cur.setPropertyValue("CharWeight", 150.0)
cur.goRight(2, False)
cur.setPropertyValue("ParaStyleName", "Heading 3")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "R2", False)
print("V3 (tracked rewrite-at of B into R1/R2):", paras(doc))

# V4: same as V3 without tracking
doc, text = fresh(track=False)
p = list(text.createEnumeration())[1]
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
cur.goRight(n, True)
text.insertString(cur, "R1", True)
cur.goLeft(2, True)
cur.setPropertyValue("CharWeight", 150.0)
cur.goRight(2, False)
cur.setPropertyValue("ParaStyleName", "Heading 3")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "R2", False)
print("V4 (untracked rewrite-at of B into R1/R2):", paras(doc))

# V5: what does /document-style enumeration report after a tracked deletion
# of the WHOLE first paragraph (text + break)?
doc, text = fresh(track=True)
p = list(text.createEnumeration())[0]
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
cur.goRight(n + 1, True)
cur.setString("")
print("V5 (tracked delete of A):", paras(doc))

# V6: rewrite of the FIRST paragraph via absorb, multiple paragraphs
doc, text = fresh(track=True)
p = list(text.createEnumeration())[0]
n = len(p.getString())
cur = text.createTextCursorByRange(p.getStart())
cur.goRight(n, True)
text.insertString(cur, "X1", True)
cur.setPropertyValue("ParaStyleName", "Heading 2")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "X2", False)
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "X3", False)
print("V6 (tracked rewrite of A into X1/X2/X3):", paras(doc))
doc.setPropertyValue("RecordChanges", False)