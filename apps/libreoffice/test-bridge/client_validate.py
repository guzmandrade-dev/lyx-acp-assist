"""Phase 0 spike, step A: validate UNO mechanisms against a live LibreOffice.

Run against a LibreOffice instance started with:
  soffice --accept="socket,host=localhost,port=2002;urp;" --nodefault --norestore

Usage:
  "C:\\Program Files\\LibreOffice\\program\\python.exe" client_validate.py
"""

import sys
import threading

import uno
import unohelper

from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.view import XSelectionChangeListener
from com.sun.star.awt import XCallback

RESULTS = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    RESULTS.append((status, name, detail))
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def connect(host="localhost", port=2002):
    local_ctx = uno.getComponentContext()
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx
    )
    url = f"uno:socket,host={host},port={port};urp;StarOffice.ComponentContext"
    return resolver.resolve(url)


class SelListener(unohelper.Base, XSelectionChangeListener):
    def __init__(self):
        self.fired = 0
        self.event = None

    def selectionChanged(self, ev):
        self.fired += 1
        self.event = ev

    def disposing(self, src):
        pass


class AsyncCallbackProbe(unohelper.Base, XCallback):
    def __init__(self):
        self.done = threading.Event()
        self.data = None
        self.thread = None

    def notify(self, data):
        self.data = data
        self.thread = threading.current_thread().name
        self.done.set()


def selection_text(doc):
    sel = doc.getCurrentController().getSelection()
    if sel.supportsService("com.sun.star.text.TextRanges"):
        # UNO reports paragraph separators as \r\n; normalize for comparison
        return [sel.getByIndex(i).getString().replace("\r\n", "\n") for i in range(sel.getCount())]
    return None


def append_para(text, s):
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, s, False)
    cur.goLeft(len(s), True)  # select the inserted run
    return cur


def main():
    ctx = connect()
    smgr = ctx.ServiceManager
    check("connect to running LibreOffice over UNO socket", True)

    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    # 1. Open a Writer document, detect module type
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    check("open Writer document", True)
    check(
        "module detection (Writer)",
        doc.supportsService("com.sun.star.text.TextDocument")
        and not doc.supportsService("com.sun.star.sheet.SpreadsheetDocument"),
    )

    text = doc.Text
    text.getEnd().setString("Spike paragraph one.")
    append_para(text, "Spike paragraph two.")
    full = text.getString()
    check("read document text", "Spike paragraph one." in full and "Spike paragraph two." in full, repr(full[:50]))

    paras = [p.getString() for p in text.createEnumeration()]
    check(
        "paragraph enumeration",
        paras == ["Spike paragraph one.", "Spike paragraph two."],
        str(paras),
    )

    # 2. Selection-change listener + programmatic selection
    ctrl = doc.getCurrentController()
    listener = SelListener()
    ctrl.addSelectionChangeListener(listener)
    dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:SelectAll", "", 0, ())
    check("selection-change listener fires", listener.fired >= 1, f"fired={listener.fired}")
    check(
        "read selection text",
        selection_text(doc) == ["Spike paragraph one.\nSpike paragraph two."],
        str(selection_text(doc)),
    )
    dispatcher.executeDispatch(ctrl.getFrame(), ".uno:GoDown", "", 0, ())
    ctrl.removeSelectionChangeListener(listener)

    # 3. Insert at view cursor inside one undo transaction
    vc = ctrl.getViewCursor()
    vc.gotoStart(False)
    um = doc.getUndoManager()
    before = text.getString()
    um.enterUndoContext("ACP spike insert")
    text.insertString(vc, "[INSERTED] ", False)
    um.leaveUndoContext()
    check(
        "insert at view cursor",
        text.getString().startswith("[INSERTED] Spike paragraph one."),
        repr(text.getString()[:30]),
    )
    um.undo()
    check(
        "one undo transaction reverts whole edit",
        text.getString() == before,
        repr(text.getString()[:30]),
    )

    # 4. AsyncCallback: marshal work onto the main thread (bridge design)
    try:
        cb_svc = smgr.createInstanceWithContext("com.sun.star.awt.AsyncCallback", ctx)
        probe = AsyncCallbackProbe()
        cb_svc.addCallback(probe, "ping")
        ok = probe.done.wait(timeout=5)
        check(
            "AsyncCallback round-trip onto main thread",
            ok and probe.data == "ping",
            f"data={probe.data!r}, thread={probe.thread}",
        )
    except Exception as e:
        check("AsyncCallback round-trip onto main thread", False, repr(e))

    # 5. Tracked changes: edit recorded as a redline
    doc.setPropertyValue("RecordChanges", True)
    append_para(text, "TRACKED spike insertion")
    redlines = list(doc.getRedlines().createEnumeration())
    types = []
    for r in redlines:
        try:
            types.append(str(r.getPropertyValue("RedlineType")))
        except Exception:
            types.append("<unreadable>")
    check(
        "tracked change recorded as redline",
        len(redlines) >= 1 and "Insert" in types,
        f"{len(redlines)} redline(s), types={types}",
    )
    doc.setPropertyValue("RecordChanges", False)

    # 6. Formatted insertion: Heading 1 paragraph + bold run
    run = append_para(text, "Spiked Heading")
    run.setPropertyValue("CharWeight", 150.0)  # BOLD
    run.setPropertyValue("ParaStyleName", "Heading 1")
    heading = next((p for p in text.createEnumeration() if p.getString() == "Spiked Heading"), None)
    if heading is not None:
        style = heading.getPropertyValue("ParaStyleName")
        weight = heading.getPropertyValue("CharWeight")
        check(
            "formatted insertion (Heading 1 + bold)",
            style == "Heading 1" and weight >= 100.0,
            f"style={style}, CharWeight={weight}",
        )
    else:
        check("formatted insertion (Heading 1 + bold)", False, "heading para not found")

    # 7. Calc smoke test: module detection + cell/formula access
    calc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, ())
    try:
        is_calc = calc.supportsService("com.sun.star.sheet.SpreadsheetDocument")
        sheet = calc.getSheets().getByIndex(0)
        sheet.getCellByPosition(0, 0).setString("hello")
        sheet.getCellByPosition(1, 0).setFormula("=1+1")
        val = sheet.getCellByPosition(1, 0).getValue()
        check("module detection (Calc) + cell access", is_calc and val == 2.0, f"A1, B1={val}")
    except Exception as e:
        check("module detection (Calc) + cell access", False, repr(e))

    print("\n--- summary ---")
    fails = [r for r in RESULTS if r[0] == "FAIL"]
    print(f"{len(RESULTS) - len(fails)}/{len(RESULTS)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())