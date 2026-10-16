"""Probe: text-cursor insert semantics for the bridge's _write_paragraphs.

Question: with a cursor anchored at a paragraph END (boundary), does the
break-then-insert sequence create separate paragraphs, or degenerate?

Run against a socket-connected LibreOffice.
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
text = doc.Text
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK

cur = text.createTextCursor()
text.insertString(cur, "A", False)
cur = text.createTextCursor()
cur.gotoEnd(False)
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "B", False)

def paras():
    return [p.getString() for p in text.createEnumeration()]

print("start:", paras())

# Variant 1: anchor at end of paragraph A (getEnd of enumerated para 0)
p_a = list(text.createEnumeration())[0]
cur = text.createTextCursorByRange(p_a.getEnd())
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "X1", False)
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "X2", False)
print("variant1 (break,insert,break,insert at para end):", paras())

# Variant 2: setString replace, then break+insert (rewrite-at shape)
p = list(text.createEnumeration())[3]  # paragraph "B"
print("target para:", repr(p.getString()))
cur = text.createTextCursorByRange(p)
cur.setString("R1")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "R2", False)
print("variant2 (setString then break+insert):", paras())

# Variant 3: same but with absorb=True on the break
p = list(text.createEnumeration())[0]  # "A"
cur = text.createTextCursorByRange(p)
cur.setString("S1")
text.insertControlCharacter(cur, PARAGRAPH_BREAK, True)
text.insertString(cur, "S2", False)
print("variant3 (break absorb=True):", paras())

# Variant 4: setString, then gotoEnd-of-range re-anchor before continuing
p = list(text.createEnumeration())[1]
print("variant4 target:", repr(p.getString()))
cur = text.createTextCursorByRange(p)
cur.setString("T1")
# re-anchor at the end of the (now modified) paragraph range
cur2 = text.createTextCursorByRange(p.getEnd())
text.insertControlCharacter(cur2, PARAGRAPH_BREAK, False)
text.insertString(cur2, "T2", False)
print("variant4 (re-anchor at para end after setString):", paras())

# Variant 5: insert-at-start via getStart, insert content, then break at cursor
p = list(text.createEnumeration())[3]
print("variant5 target:", repr(p.getString()))
cur = text.createTextCursorByRange(p)
cur.setString("")
cur = text.createTextCursorByRange(p.getStart())
text.insertString(cur, "U1", False)
cur.goRight(0, False)
text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
text.insertString(cur, "U2", False)
print("variant5:", paras())