"""Phase 1 bridge e2e: HTTP suite for the in-process bridge (.oxt).

Prerequisites: LibreOffice running with --accept socket (port 2002), the
bridge extension installed, and the bridge started
(service:org.libreofficeacp.bridge?start).

Run with the bundled LibreOffice Python:
  "C:\\Program Files\\LibreOffice\\program\\python.exe" bridge_e2e.py
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request

import uno

RESULTS = []
PORT = None
TOKEN = None


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    RESULTS.append((status, name))
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def load_bridge():
    """Newest LIVE bridge record: stale records from previous soffice
    processes accumulate in the discovery directory."""
    base = os.environ.get("APPDATA")
    bridges = os.path.join(base, "LibreOffice ACP Assist", "bridges")
    records = []
    for fn in os.listdir(bridges):
        with open(os.path.join(bridges, fn), encoding="utf-8") as f:
            records.append(json.load(f))
    live = [r for r in records if _pid_alive(r["pid"])]
    if not live:
        raise SystemExit("no live bridge discovery records found")
    live.sort(key=lambda r: r["startedAt"])
    return live[-1]["port"], live[-1]["token"]


def _pid_alive(pid):
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(1, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            kernel32.CloseHandle(handle)
            return True
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def http(method, path, payload=None, token=None, timeout=40):
    url = f"http://127.0.0.1:{PORT}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def connect_uno(port=2002):
    local_ctx = uno.getComponentContext()
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx)
    return resolver.resolve(
        f"uno:socket,host=localhost,port={port};urp;StarOffice.ComponentContext")


def para_runs(runs, style=None):
    p = {"runs": runs}
    if style:
        p["style"] = style
    return p


def main():
    global PORT, TOKEN
    PORT, TOKEN = load_bridge()
    check("discovery file read", True, f"port={PORT}")

    code, body = http("GET", "/status", token=None)
    check("auth: request without token rejected", code == 401, f"code={code}")

    ctx = connect_uno()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    code, status = http("GET", "/status", token=TOKEN)
    check("GET /status (no document)", code == 200 and status.get("active") is False,
          f"code={code}, status={status}")

    # Seed a Writer document via UNO (main thread): two paragraphs.
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
    text.getEnd().setString("Spike paragraph one.")
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "Spike paragraph two.", False)
    vc = doc.getCurrentController().getViewCursor()
    vc.gotoEnd(False)  # deterministic: cursor after the last paragraph
    # A doc loaded over the socket is not focused automatically; the bridge
    # serves the desktop's CURRENT component, so activate the frame.
    doc.getCurrentController().getFrame().activate()
    time.sleep(0.3)

    code, status = http("GET", "/status", token=TOKEN)
    check("GET /status sees active Writer doc",
          code == 200 and status.get("active") and status.get("module") == "writer",
          f"module={status.get('module')}, url={status.get('url')!r}")

    code, docinfo = http("GET", "/document", token=TOKEN)
    check("GET /document returns paragraphs + cursorStyle + selection",
          code == 200
          and [p["text"] for p in docinfo.get("paragraphs", [])]
          == ["Spike paragraph one.", "Spike paragraph two."]
          and isinstance(docinfo.get("cursorStyle"), str)
          and docinfo.get("selection") is None,
          f"paras={[(p['text'][:18], p['style']) for p in docinfo.get('paragraphs', [])]}")

    code, docs = http("GET", "/documents", token=TOKEN)
    check("GET /documents lists the document with url",
          code == 200 and len(docs["documents"]) == 1 and docs["documents"][0]["active"],
          f"docs={docs.get('documents')}")

    # --- edit: insert at cursor (fresh paragraph below, heading + bold run)
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert",
        "paragraphs": [
            para_runs([{"text": "Spiked ", "bold": True}, {"text": "heading"}],
                      style="Heading 2"),
            para_runs([{"text": "plain tail"}]),
        ],
    })
    paras = [(p.getString(), p.getPropertyValue("ParaStyleName"),
              p.getPropertyValue("CharWeight")) for p in text.createEnumeration()]
    check("edit insert: fresh paragraphs at cursor with style + bold run",
          code == 200 and out.get("applied")
          and [p[0] for p in paras]
          == ["Spike paragraph one.", "Spike paragraph two.",
              "Spiked heading", "plain tail"]
          and paras[2][1] == "Heading 2" and paras[2][2] >= 100.0,
          f"paras={[(t[:20], s, w) for t, s, w in paras]}")

    # --- edit: insert-after p1
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-after", "target": 1,
        "paragraphs": [para_runs([{"text": "After one"}], style="Heading 3")],
    })
    paras = [p.getString() for p in text.createEnumeration()]
    check("edit insert-after p1 lands between p1 and p2",
          code == 200 and out.get("applied")
          and paras == ["Spike paragraph one.", "After one", "Spike paragraph two.",
                        "Spiked heading", "plain tail"],
          f"paras={paras}")

    # --- edit: rewrite-at p3 (replace whole paragraph with two paragraphs)
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite-at", "target": 3,
        "paragraphs": [
            para_runs([{"text": "Two dot A", "italic": True}]),
            para_runs([{"text": "Two dot B"}]),
        ],
    })
    paras = [p.getString() for p in text.createEnumeration()]
    # Tracked changes keep the deleted text in the MODEL (the user sees it
    # struck through pending accept); the typed replacement precedes it.
    check("edit rewrite-at p3 replaces and splits the paragraph",
          code == 200 and out.get("applied")
          and len(paras) == 6
          and paras[2].startswith("Two dot A")
          and paras[2].endswith("Spike paragraph two.")
          and paras[3] == "Two dot B",
          f"paras={paras}")

    # --- edit: rewrite (selection)
    enum5 = list(text.createEnumeration())
    sel_cursor = text.createTextCursorByRange(enum5[5])  # "plain tail"
    doc.getCurrentController().select(sel_cursor)
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite",
        "paragraphs": [para_runs([{"text": "replaced tail"}])],
    })
    paras = [p.getString() for p in text.createEnumeration()]
    check("edit rewrite replaces the selection in place",
          code == 200 and out.get("applied")
          and paras[-1] == "replaced tail" and len(paras) == 6,
          f"paras={paras}")

    # --- tracked changes recorded
    rls = list(doc.getRedlines().createEnumeration())
    check("edits recorded as redlines (tracked changes)", len(rls) >= 4,
          f"{len(rls)} redlines")

    # --- lazy paragraph fetch
    code, one = http("GET", "/document/p/1", token=TOKEN)
    check("GET /document/p/1 returns the full paragraph",
          code == 200 and one["text"] == "After one" and one["i"] == 1,
          f"one={one}")

    # --- out-of-range target is refused, nothing written
    before = [p.getString() for p in text.createEnumeration()]
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "delete-at", "target": 99,
    })
    after = [p.getString() for p in text.createEnumeration()]
    check("out-of-range target refused without touching the document",
          code == 500 and "does not exist" in str(out.get("error")) and before == after,
          f"code={code}")

    # --- edit: delete-at p2, UNTRACKED (real deletion so undo is observable)
    before = [p.getString() for p in text.createEnumeration()]
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "delete-at", "target": 2, "tracked": False,
    })
    paras = [p.getString() for p in text.createEnumeration()]
    check("edit delete-at p2 removes the paragraph (untracked)",
          code == 200 and out.get("applied")
          and paras == ["Spike paragraph one.",
                        "Two dot ASpike paragraph two.", "Two dot B",
                        "Spiked heading", "replaced tail"],
          f"paras={paras}")

    # --- undo reverts the delete (one labeled transaction)
    code, out = http("POST", "/undo", token=TOKEN)
    paras = [p.getString() for p in text.createEnumeration()]
    check("undo reverts the last edit as one transaction",
          code == 200 and out.get("undone") and paras == before,
          f"paras={paras}")

    # --- events long-poll sees selection-changed
    events_result = {}

    def poll():
        events_result["resp"] = http("GET", "/events?since=0&timeout=15", token=TOKEN)

    t = threading.Thread(target=poll)
    t.start()
    time.sleep(1.0)
    dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
    frame = doc.getCurrentController().getFrame()
    dispatcher.executeDispatch(frame, ".uno:SelectAll", "", 0, ())
    dispatcher.executeDispatch(frame, ".uno:GoDown", "", 0, ())
    t.join(timeout=20)
    ev = events_result.get("resp", (0, {}))
    kinds = [e["type"] for e in ev[1].get("events", [])]
    check("GET /events long-poll receives selection-changed",
          ev[0] == 200 and "selection-changed" in kinds,
          f"{len(kinds)} events")

    # --- Calc: /document read + write-cells / insert-rows ------------------
    calc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, ())
    time.sleep(0.5)
    csheet = calc.getSheets().getByIndex(0)
    csheet.getCellByPosition(0, 0).setString("Name")
    csheet.getCellByPosition(1, 0).setString("Qty")
    csheet.getCellByPosition(0, 1).setString("Widget")
    csheet.getCellByPosition(1, 1).setValue(5)
    csheet.getCellByPosition(1, 2).setFormula("=B2*2")
    # loadComponentFromURL from the socket does NOT focus the new doc —
    # activate its frame explicitly (same reason the /activate check exists).
    calc.getCurrentController().getFrame().activate()
    time.sleep(0.5)
    calc.getCurrentController().select(csheet.getCellRangeByName("A1:B3"))

    code, st = http("GET", "/status", token=TOKEN)
    check("calc: GET /status sees the active Calc document",
          code == 200 and st.get("active") and st.get("module") == "calc",
          f"module={st.get('module')}, recordChanges={st.get('recordChanges')!r}")

    code, d = http("GET", "/document", token=TOKEN)
    sel = (d.get("calc") or {}).get("selection") or {}
    check("calc: /document returns sheets + selection values and formulas",
          code == 200 and d.get("module") == "calc"
          and [s["name"] for s in d.get("calc", {}).get("sheets", [])] == ["Sheet1"]
          and d["calc"]["sheets"][0]["usedRange"] == "A1:B3"
          and sel.get("ranges") == ["Sheet1!A1:B3"]
          and sel.get("anchor") == "A1"
          and sel.get("values") == [["Name", "Qty"], ["Widget", "5"], ["", "10"]]
          and (sel.get("formulas") or [])[2][1] == "=B2*2"
          and (d.get("calc", {}).get("data") or {}).get("range") == "A1:B3"
          and d["calc"]["data"]["values"] == [["Name", "Qty"], ["Widget", "5"], ["", "10"]],
          f"sel={ {k: v for k, v in sel.items() if k != 'values'} }")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "write-cells", "anchor": "C1",
        "rows": [["Total"], ["=SUM(B2:B3)"]],
    })
    check("calc: write-cells writes text and formulas at the anchor",
          code == 200 and out.get("applied") and out.get("anchor") == "C1"
          and csheet.getCellByPosition(2, 0).getString() == "Total"
          and csheet.getCellByPosition(2, 1).getFormula() == "=SUM(B2:B3)"
          and csheet.getCellByPosition(2, 1).getValue() == 15,
          f"out={out}")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-rows", "anchor": "A2", "count": 1,
    })
    check("calc: insert-rows shifts data down and keeps formulas",
          code == 200 and out.get("applied")
          and csheet.getCellByPosition(0, 1).getString() == ""
          and csheet.getCellByPosition(0, 2).getString() == "Widget"
          # the =B2*2 ref followed the moved data: B3*2 (value preserved)
          and csheet.getCellByPosition(1, 3).getFormula() == "=B3*2"
          and csheet.getCellByPosition(1, 3).getValue() == 10,
          f"out={out}")

    code, out = http("POST", "/undo", token=TOKEN)
    check("calc: undo reverts the insert-rows edit",
          code == 200 and out.get("undone")
          and csheet.getCellByPosition(0, 1).getString() == "Widget"
          and csheet.getCellByPosition(1, 2).getString() == "10",
          f"out={out}")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "write-cells", "anchor": "!!", "rows": [["x"]],
    })
    check("calc: bad anchor refused with a clear error",
          code == 500 and "not a valid A1" in str(out.get("error")),
          f"code={code}, err={out.get('error')!r}")

    code, out = http("POST", "/edit", token=TOKEN, payload={"mode": "sum-all"})
    check("calc: unknown edit mode refused",
          code == 500 and "unknown edit mode" in str(out.get("error")),
          f"code={code}, err={out.get('error')!r}")

    # --- Impress: /document read + slide edits + journal undo -------------
    imp = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
    imp.getCurrentController().getFrame().activate()
    time.sleep(0.5)
    ipages = imp.getDrawPages()
    ipages.getByIndex(0).getByIndex(0).getText().setString("Q1 Results")
    ipages.getByIndex(0).getByIndex(1).getText().setString("Revenue up\nCosts flat")

    def deck_texts(doc):
        pages = doc.getDrawPages()
        out = []
        for i in range(pages.getCount()):
            p = pages.getByIndex(i)
            out.append([(p.getByIndex(j).getShapeType().rsplit(".", 1)[-1],
                         p.getByIndex(j).getText().getString())
                        for j in range(p.getCount())])
        return out

    code, st = http("GET", "/status", token=TOKEN)
    check("impress: GET /status sees the active Impress document",
          code == 200 and st.get("active") and st.get("module") == "impress"
          and st.get("recordChanges") is None,
          f"module={st.get('module')}, recordChanges={st.get('recordChanges')!r}")

    code, d = http("GET", "/document", token=TOKEN)
    slides = d.get("slides", [])
    check("impress: /document returns the slide outline with kinds",
          code == 200 and d.get("module") == "impress"
          and len(slides) == 1 and slides[0]["current"] is True
          and [(s["kind"], s["text"]) for s in slides[0]["shapes"]]
          == [("title", "Q1 Results"), ("body", "Revenue up\nCosts flat")]
          and d.get("selection") is None and d.get("truncated") is False,
          f"slides={slides}")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-slide-after", "slide": 1,
        "title": "Agenda", "body": ["First point", "Second point"],
    })
    check("impress: insert-slide-after s1 adds a title+body slide",
          code == 200 and out.get("applied") and out.get("slide") == 1
          and deck_texts(imp) == [
              [("TitleTextShape", "Q1 Results"), ("SubtitleShape", "Revenue up\nCosts flat")],
              [("TitleTextShape", "Agenda"), ("OutlinerShape", "First point\nSecond point")]],
          f"deck={deck_texts(imp)}")

    code, out = http("POST", "/undo", token=TOKEN)
    check("impress: undo reverts the slide insert as one step",
          code == 200 and out.get("undone") and len(deck_texts(imp)) == 1
          and deck_texts(imp)[0][0][1] == "Q1 Results",
          f"deck={deck_texts(imp)}")

    # re-insert (deck grows to 2 for the rest of the section)
    http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-slide-after", "slide": 1,
        "title": "Agenda", "body": ["First point", "Second point"],
    })

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-slide-after", "slide": 0,
        "title": "Cover", "body": [],
    })
    deck = deck_texts(imp)
    check("impress: insert-slide-after s0 swaps content to the very start",
          code == 200 and out.get("applied")
          and deck[0] == [("TitleTextShape", "Cover"), ("SubtitleShape", "")]
          and deck[1][0] == ("TitleTextShape", "Q1 Results")
          and deck[1][1] == ("OutlinerShape", "Revenue up\nCosts flat")
          and deck[2][0] == ("TitleTextShape", "Agenda"),
          f"deck={deck}")

    code, out = http("POST", "/undo", token=TOKEN)
    deck = deck_texts(imp)
    check("impress: undo reverts s0 (texts restored, page removed)",
          code == 200 and out.get("undone") and len(deck) == 2
          and deck[0] == [("TitleTextShape", "Q1 Results"),
                          ("SubtitleShape", "Revenue up\nCosts flat")]
          and deck[1][1] == ("OutlinerShape", "First point\nSecond point"),
          f"deck={deck}")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite-slide", "slide": 0,
        "title": "Q1 Results v2",
        "body": ["Revenue up", "Costs flat", "Margins up"],
    })
    check("impress: rewrite-slide replaces title and body",
          code == 200 and out.get("applied")
          and deck_texts(imp)[0]
          == [("TitleTextShape", "Q1 Results v2"),
              ("SubtitleShape", "Revenue up\nCosts flat\nMargins up")],
          f"deck={deck_texts(imp)}")

    code, out = http("POST", "/undo", token=TOKEN)
    check("impress: undo reverts the rewrite-slide as one step",
          code == 200 and out.get("undone")
          and deck_texts(imp)[0]
          == [("TitleTextShape", "Q1 Results"),
              ("SubtitleShape", "Revenue up\nCosts flat")],
          f"deck={deck_texts(imp)}")

    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite-frame", "slide": 1, "shape": 1,
        "paragraphs": ["Replaced point one", "Replaced point two"],
    })
    check("impress: rewrite-frame replaces one shape's text",
          code == 200 and out.get("applied")
          and deck_texts(imp)[1][1]
          == ("OutlinerShape", "Replaced point one\nReplaced point two"),
          f"deck={deck_texts(imp)}")

    # selection: select the title of slide 2 via UNO, then read /document
    ctrl = imp.getCurrentController()
    ctrl.select(ipages.getByIndex(1).getByIndex(0))
    code, d = http("GET", "/document", token=TOKEN)
    sel = d.get("selection")
    check("impress: /document reports the selected frame with indices",
          code == 200 and sel and sel[0]["slide"] == 1 and sel[0]["shape"] == 0
          and sel[0]["kind"] == "title" and sel[0]["text"] == "Agenda",
          f"sel={sel}")

    code, one = http("GET", "/document/s/1", token=TOKEN)
    check("impress: GET /document/s/1 returns the full slide",
          code == 200 and one["slide"]["i"] == 1
          and [(s["kind"], s["text"]) for s in one["slide"]["shapes"]]
          == [("title", "Agenda"),
              ("body", "Replaced point one\nReplaced point two")],
          f"one={one}")

    before = deck_texts(imp)
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite-slide", "slide": 9, "title": "x", "body": ["y"],
    })
    code2, out2 = http("POST", "/edit", token=TOKEN, payload={
        "mode": "insert-slide-after", "slide": 9, "title": "x", "body": [],
    })
    check("impress: out-of-range slide edits refused without touching the deck",
          code == 500 and "does not exist" in str(out.get("error"))
          and code2 == 500 and "does not exist" in str(out2.get("error"))
          and before == deck_texts(imp),
          f"err={out.get('error')!r} / {out2.get('error')!r}")

    code, out = http("POST", "/undo", token=TOKEN)
    check("impress: undo reverts the rewrite-frame as one step",
          code == 200 and out.get("undone")
          and deck_texts(imp)[1][1] == ("OutlinerShape", "First point\nSecond point"),
          f"deck={deck_texts(imp)}")

    # events: switching slides (setCurrentPage) fires selection-changed
    events_result = {}

    def poll_impress():
        events_result["resp"] = http("GET", "/events?since=0&timeout=15", token=TOKEN)

    t = threading.Thread(target=poll_impress)
    t.start()
    time.sleep(1.0)
    ctrl.setCurrentPage(ipages.getByIndex(1))
    t.join(timeout=20)
    ev = events_result.get("resp", (0, {}))
    kinds = [e["type"] for e in ev[1].get("events", [])]
    check("impress: /events long-poll receives slide-change events",
          ev[0] == 200 and "selection-changed" in kinds,
          f"{len(kinds)} events")

    # --- Draw smoke --------------------------------------------------------
    drw = desktop.loadComponentFromURL("private:factory/sdraw", "_blank", 0, ())
    drw.getCurrentController().getFrame().activate()
    time.sleep(0.5)
    dpage = drw.getDrawPages().getByIndex(0)
    dframe = drw.createInstance("com.sun.star.drawing.TextShape")
    dpage.add(dframe)
    dframe.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 8000, 2000))
    dframe.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1000, 1000))
    dframe.getText().setString("Draw frame one\nsecond para")

    code, st = http("GET", "/status", token=TOKEN)
    code, d = http("GET", "/document", token=TOKEN)
    check("draw: /document reads a plain TextShape frame",
          code == 200 and st.get("module") == "draw" and d.get("module") == "draw"
          and len(d.get("slides", [])) == 1
          and d["slides"][0]["shapes"][0]["kind"] == "text"
          and d["slides"][0]["shapes"][0]["text"] == "Draw frame one\nsecond para",
          f"slides={d.get('slides')}")

    drw.getCurrentController().select(dframe)
    code, d = http("GET", "/document", token=TOKEN)
    sel = d.get("selection")
    code, out = http("POST", "/edit", token=TOKEN, payload={
        "mode": "rewrite-frame", "slide": 0, "shape": 0,
        "paragraphs": ["Replaced draw text"],
    })
    check("draw: rewrite-frame replaces the frame text",
          code == 200 and out.get("applied") and sel
          and sel[0] == {"slide": 0, "shape": 0, "kind": "text",
                         "text": "Draw frame one\nsecond para"}
          and dframe.getText().getString() == "Replaced draw text",
          f"sel={sel}")

    code, out = http("POST", "/undo", token=TOKEN)
    check("draw: undo restores the frame text",
          code == 200 and out.get("undone")
          and dframe.getText().getString() == "Draw frame one\nsecond para",
          f"text={dframe.getText().getString()!r}")

    # --- activate (second document)
    doc2 = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    doc2.Text.getEnd().setString("Second document body.")
    time.sleep(0.5)
    code, out = http("POST", "/activate", token=TOKEN,
                     payload={"url": doc.getURL() or doc.getTitle()})
    time.sleep(0.5)
    code2, st = http("GET", "/status", token=TOKEN)
    active_title = st.get("title")
    check("POST /activate switches the active document",
          code == 200 and out.get("activated") and active_title == doc.getTitle(),
          f"activated={out.get('activated')!r}, now active={active_title!r}")

    # --- stop shuts the server down (discovery record removed)
    dispatcher.executeDispatch(desktop, "service:org.libreofficeacp.bridge?stop", "", 0, ())
    time.sleep(1)
    try:
        http("GET", "/status", token=TOKEN, timeout=5)
        stopped = False
    except Exception:
        stopped = True
    check("service:?stop shuts the server down", stopped)

    print("\n--- summary ---")
    fails = [r for r in RESULTS if r[0] == "FAIL"]
    print(f"{len(RESULTS) - len(fails)}/{len(RESULTS)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())