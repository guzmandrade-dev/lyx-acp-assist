"""Probe 6: replicate the bridge's exact _edit flow for each mode,
including undo contexts and RecordChanges toggling, and observe what
paragraph reads report (ghost redline text or not).
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
    for s in ("Spike paragraph one.", "Spike paragraph two."):
        cur = text.createTextCursor()
        cur.gotoEnd(False)
        if s != "Spike paragraph one.":
            text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
        text.insertString(cur, s, False)
    return doc


def state(doc):
    return [p.getString() for p in doc.getText().createEnumeration()]


def bridge_edit(doc, mode, paragraphs=None, target=None, tracked=True):
    """Mirror of the bridge _edit (view-cursor version under test)."""
    text = doc.getText()
    ctrl = doc.getCurrentController()
    was_tracking = doc.getPropertyValue("RecordChanges")
    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", True)
    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        vc = ctrl.getViewCursor()
        if mode == "insert":
            write_paragraphs(doc, vc, paragraphs, first_break=True)
        elif mode == "insert-after":
            para = nth(doc, target)
            vc.gotoRange(para.getEnd(), False)
            write_paragraphs(doc, vc, paragraphs, first_break=True)
        elif mode == "rewrite-at":
            para = nth(doc, target)
            n = len(para.getString())
            vc.gotoRange(para, False)
            vc.goRight(n, True)
            vc.setString("")
            write_paragraphs(doc, vc, paragraphs, first_break=False)
        elif mode == "rewrite":
            vc.setString("")  # selection was set by the caller
            write_paragraphs(doc, vc, paragraphs, first_break=False)
        elif mode == "delete-at":
            para = nth(doc, target)
            n = len(para.getString())
            vc.gotoRange(para, False)
            ok = vc.goRight(n + 1, True)
            if not ok:
                vc.goRight(n, True)
            vc.setString("")
    finally:
        um.leaveUndoContext()
    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", was_tracking)
    print(f"  state after {mode}:", state(doc))
    print("  redlines:", len(list(doc.getRedlines().createEnumeration())))


def write_paragraphs(doc, cursor, paragraphs, first_break):
    text = doc.getText()
    for idx, para in enumerate(paragraphs):
        if idx > 0 or first_break:
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        for run in para["runs"]:
            s = run["text"]
            if s == "":
                continue
            text.insertString(cursor, s, False)
        if para.get("style"):
            cursor.setPropertyValue("ParaStyleName", para["style"])


def nth(doc, n):
    return list(doc.getText().createEnumeration())[n - 1]


# Step 1: insert at end
doc = fresh()
vc = doc.getCurrentController().getViewCursor()
vc.gotoEnd(False)
bridge_edit(doc, "insert", [{"runs": [{"text": "Spiked heading"}], "style": "Heading 2"},
                            {"runs": [{"text": "plain tail"}]}])

# Step 2: insert-after p1
bridge_edit(doc, "insert-after", [{"runs": [{"text": "After one"}], "style": "Heading 3"}], target=1)

# Step 3: rewrite-at p3 (two paragraphs)
bridge_edit(doc, "rewrite-at", [{"runs": [{"text": "Two dot A"}]},
                                {"runs": [{"text": "Two dot B"}]}], target=3)

# Step 4: rewrite the selection of the LAST paragraph (controller.select)
para = list(doc.getText().createEnumeration())[5]
sel = doc.getText().createTextCursorByRange(para)
doc.getCurrentController().select(sel)
bridge_edit(doc, "rewrite", [{"runs": [{"text": "replaced tail"}]}])

# Step 5: delete-at p2
bridge_edit(doc, "delete-at", target=2)

print("final state:", state(doc))
print("final redlines:", len(list(doc.getRedlines().createEnumeration())))