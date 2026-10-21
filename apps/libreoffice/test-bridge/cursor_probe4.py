"""Probe 4: view-cursor choreography for all bridge edit modes (tracked).

All variants run with RecordChanges ON on fresh documents, mirroring the
planned bridge implementation exactly.
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
    for s in ("A", "B", "C"):
        if s != "A":
            cur = text.createTextCursor()
            cur.gotoEnd(False)
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        text.insertString(cur, s, False)
    doc.setPropertyValue("RecordChanges", track)
    return doc


def write_paragraphs(doc, cursor, paragraphs, first_break):
    """Planned bridge helper: view-cursor typing semantics."""
    text = doc.getText()
    for idx, para in enumerate(paragraphs):
        if idx > 0 or first_break:
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        for run in para["runs"]:
            s = run["text"]
            if s == "":
                continue
            text.insertString(cursor, s, False)
            props = []
            if run.get("bold"):
                props.append(("CharWeight", 150.0))
            if props:
                cursor.goLeft(len(s), True)
                for name, value in props:
                    cursor.setPropertyValue(name, value)
                cursor.goRight(len(s), False)
        if para.get("style"):
            cursor.setPropertyValue("ParaStyleName", para["style"])


def state(doc, with_props=False):
    out = [p.getString() for p in doc.getText().createEnumeration()]
    if with_props:
        props = [(p.getPropertyValue("ParaStyleName"), p.getPropertyValue("CharWeight"))
                 for p in doc.getText().createEnumeration()]
        return out, props
    return out


# P1: insert-after p1, two paragraphs, style + bold
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
para = list(doc.getText().createEnumeration())[0]
vc.gotoRange(para.getEnd(), False)
write_paragraphs(doc, vc, [
    {"runs": [{"text": "N1", "bold": True}], "style": "Heading 3"},
    {"runs": [{"text": "N2"}]},
], first_break=True)
print("P1 insert-after p1:", state(doc, with_props=True))

# P2: rewrite-at p2 into R1/R2 with bold + Heading 3
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
para = list(doc.getText().createEnumeration())[1]
n = len(para.getString())
vc.gotoRange(para, False)
vc.goRight(n, True)
vc.setString("")
write_paragraphs(doc, vc, [
    {"runs": [{"text": "R1", "bold": True}], "style": "Heading 3"},
    {"runs": [{"text": "R2"}]},
], first_break=False)
print("P2 rewrite-at p2:", state(doc, with_props=True))

# P3: delete-at p2 (tracked; ghost stays in model until accept)
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
para = list(doc.getText().createEnumeration())[1]
n = len(para.getString())
vc.gotoRange(para, False)
ok = vc.goRight(n + 1, True)
if not ok:
    vc.goRight(n, True)
vc.setString("")
print("P3 delete-at p2 (model):", state(doc))
print("P3 redlines:", len(list(doc.getRedlines().createEnumeration())))

# P4: delete-at p3 (LAST paragraph)
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
para = list(doc.getText().createEnumeration())[2]
n = len(para.getString())
vc.gotoRange(para, False)
ok = vc.goRight(n + 1, True)
if not ok:
    vc.goRight(n, True)
vc.setString("")
print("P4 delete-at p3 last (model):", state(doc))

# P5: insert-top
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
vc.gotoStart(False)
write_paragraphs(doc, vc, [{"runs": [{"text": "TOP", "bold": True}], "style": "Heading 1"}], first_break=True)
print("P5 insert-top:", state(doc, with_props=True))

# P6: rewrite-at p1 into two paragraphs
doc = fresh()
ctrl = doc.getCurrentController()
vc = ctrl.getViewCursor()
para = list(doc.getText().createEnumeration())[0]
n = len(para.getString())
vc.gotoRange(para, False)
vc.goRight(n, True)
vc.setString("")
write_paragraphs(doc, vc, [
    {"runs": [{"text": "X1"}], "style": "Heading 2"},
    {"runs": [{"text": "X2"}]},
], first_break=False)
print("P6 rewrite-at p1:", state(doc, with_props=True))
doc.setPropertyValue("RecordChanges", False)