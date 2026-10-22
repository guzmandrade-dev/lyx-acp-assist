"""Probe 5: does a tracked view-cursor setString("") deletion leave ghost
text in the model, and does it depend on crossing a paragraph mark?
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
desktop = ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK


def fresh(track=True):
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    for s in ("hello world", "second"):
        if s != "hello world":
            cur = text.createTextCursor()
            cur.gotoEnd(False)
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        text.insertString(cur, s, False)
    doc.setPropertyValue("RecordChanges", track)
    return doc


def state(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]


# Q1: mid-paragraph selection delete, tracked
doc = fresh()
text = doc.Text
vc = doc.getCurrentController().getViewCursor()
para = list(text.createEnumeration())[0]
start = para.getStart()
vc.gotoRange(start, False)
vc.goRight(6, True)  # select "hello "
print("Q1 selection:", repr(vc.getString()))
vc.setString("")
print("Q1 mid-para tracked delete:", state(doc))
print("Q1 redlines:", len(list(doc.getRedlines().createEnumeration())))

# Q2: whole-paragraph selection delete (no break), tracked
doc = fresh()
text = doc.Text
vc = doc.getCurrentController().getViewCursor()
para = list(text.createEnumeration())[1]
n = len(para.getString())
vc.gotoRange(para, False)
vc.goRight(n, True)
vc.setString("")
print("Q2 whole-para (no break) tracked delete:", state(doc))

# Q3: whole paragraph + break delete, tracked
doc = fresh()
text = doc.Text
vc = doc.getCurrentController().getViewCursor()
para = list(text.createEnumeration())[0]
n = len(para.getString())
vc.gotoRange(para, False)
ok = vc.goRight(n + 1, True)
vc.setString("")
print("Q3 para+break tracked delete:", state(doc), "extend-ok:", ok)

# Q4: same as Q3 but insert replacement text afterwards
doc = fresh()
text = doc.Text
vc = doc.getCurrentController().getViewCursor()
para = list(text.createEnumeration())[0]
n = len(para.getString())
vc.gotoRange(para, False)
vc.goRight(n, True)
vc.setString("")
text.insertString(vc, "NEW", False)
print("Q4 delete-then-type:", state(doc))
doc.setPropertyValue("RecordChanges", False)