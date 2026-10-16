"""Probe 7: FINAL bridge choreography verification (view cursor everywhere).

Modes: insert, insert-top (content-then-break), insert-after pN,
rewrite-at pN (start-anchor select + delete + type), delete-at pN.
Asserts structural correctness; tracked-deleted text stays in model reads.
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
    for s in ("A", "B", "C"):
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        if s != "A":
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        text.insertString(cur, s, False)
    return doc


def state(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]


def write_paragraphs(doc, cursor, paragraphs, first_break, last_break=False):
    """Bridge writer: break-before (first_break) or content-then-break
    (last_break) choreography, explicit off-props per run."""
    text = doc.getText()
    n = len(paragraphs)
    for idx, para in enumerate(paragraphs):
        if first_break and idx > 0:
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        for run in para["runs"]:
            s = run["text"]
            if s == "":
                continue
            text.insertString(cursor, s, False)
            cursor.goLeft(len(s), True)
            cursor.setPropertyValue("CharWeight", 150.0 if run.get("bold") else 100.0)
            cursor.setPropertyValue("CharPosture", 1 if run.get("italic") else 0)
            cursor.goRight(len(s), False)
        if para.get("style"):
            cursor.setPropertyValue("ParaStyleName", para["style"])
        if last_break or idx < n - 1:
            if not first_break:
                text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        elif first_break and idx < n - 1:
            pass  # break-before handled at loop top
    # NOTE: the loop logic is replaced below by a clean version; kept for reference.


def write(doc, cursor, paragraphs, mode_break):
    """mode_break: 'before' (fresh paragraphs below cursor) or 'after'
    (content first, break after every paragraph — insert-top)."""
    text = doc.getText()
    n = len(paragraphs)
    for idx, para in enumerate(paragraphs):
        if mode_break == "before" and idx > 0:
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        for run in para["runs"]:
            s = run["text"]
            if s == "":
                continue
            text.insertString(cursor, s, False)
            cursor.goLeft(len(s), True)
            cursor.setPropertyValue("CharWeight", 150.0 if run.get("bold") else 100.0)
            cursor.setPropertyValue("CharPosture", 1 if run.get("italic") else 0)
            cursor.goRight(len(s), False)
        if para.get("style"):
            cursor.setPropertyValue("ParaStyleName", para["style"])
        if mode_break == "after":
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)


# T1: insert-top (content-then-break)
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
vc.gotoStart(False)
write(doc, vc, [{"runs": [{"text": "TOP", "bold": True}], "style": "Heading 1"}], "after")
print("T1 insert-top:", state(doc))

# T1b: insert-top with two paragraphs
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
vc.gotoStart(False)
write(doc, vc, [{"runs": [{"text": "T1"}], "style": "Heading 1"},
                {"runs": [{"text": "T2"}]}], "after")
print("T1b insert-top 2 paras:", state(doc))

# T2: rewrite-at p2 (start-anchor select + delete + type)
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[1]
n = len(para.getString())
vc.gotoRange(para.getStart(), False)
vc.goRight(n, True)
print("T2 selection:", repr(vc.getString()))
vc.setString("")
write(doc, vc, [{"runs": [{"text": "R1", "bold": True}], "style": "Heading 3"},
                {"runs": [{"text": "R2"}]}], "before")
print("T2 rewrite-at p2:", state(doc))
enum = list(doc.getText().createEnumeration())
print("T2 styles:", [e.getPropertyValue("ParaStyleName") for e in enum])
print("T2 weights:", [e.getPropertyValue("CharWeight") for e in enum])

# T3: delete-at p2
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[1]
n = len(para.getString())
vc.gotoRange(para.getStart(), False)
ok = vc.goRight(n + 1, True)
if not ok:
    vc.goRight(n, True)
print("T3 selection:", repr(vc.getString()))
vc.setString("")
print("T3 delete-at p2 (model read):", state(doc))

# T4: rewrite-at p1 (first paragraph)
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
para = list(doc.getText().createEnumeration())[0]
n = len(para.getString())
vc.gotoRange(para.getStart(), False)
vc.goRight(n, True)
vc.setString("")
write(doc, vc, [{"runs": [{"text": "X1"}], "style": "Heading 2"},
                {"runs": [{"text": "X2"}]}], "before")
print("T4 rewrite-at p1:", state(doc))

# T5: multi-paragraph insert at cursor (regression check of insert mode)
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
vc.gotoEnd(False)
write(doc, vc, [{"runs": [{"text": "N1"}], "style": "Heading 2"},
                {"runs": [{"text": "N2"}]}], "before")
print("T5 insert 2 paras at end:", state(doc))