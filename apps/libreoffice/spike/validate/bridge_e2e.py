"""Phase 0 spike, step B: end-to-end test of the in-process HTTP bridge.

Prerequisites: LibreOffice running with --accept socket (port 2002) and the
bridge started (service:org.libreofficeacp.bridge?start).

Run with the bundled LibreOffice Python:
  "C:\\Program Files\\LibreOffice\\program\\python.exe" bridge_e2e.py
"""

import json
import os
import threading
import time
import urllib.request
import urllib.error

import uno

RESULTS = []


def check(name, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    RESULTS.append((status, name, detail))
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))


def load_bridge():
    base = os.environ.get("APPDATA")
    bridges = os.path.join(base, "LibreOffice ACP Assist", "bridges")
    records = []
    for fn in os.listdir(bridges):
        with open(os.path.join(bridges, fn), encoding="utf-8") as f:
            records.append(json.load(f))
    if not records:
        raise SystemExit("no bridge discovery records found")
    r = records[-1]
    return r["port"], r["token"]


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


def main():
    global PORT, TOKEN
    PORT, TOKEN = load_bridge()
    check("discovery file read", True, f"port={PORT}")

    # auth check: request without token must be rejected
    code, body = http("GET", "/status", token=None)
    check("auth: request without token rejected", code == 401, f"code={code}")

    ctx = connect_uno()
    smgr = ctx.ServiceManager
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

    # status before any document
    code, status = http("GET", "/status", token=TOKEN)
    check("GET /status (no document)", code == 200 and status.get("active") in (True, False),
          f"code={code}, status={status}")

    # open a Writer doc with seed text (via UNO, main thread)
    doc = desktop.loadComponentFromURL("private:factory/swriter", "_blank", 0, ())
    text = doc.Text
    text.getEnd().setString("Spike paragraph one.")
    cur = text.createTextCursor()
    cur.gotoEnd(False)
    from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
    text.insertControlCharacter(cur, PARAGRAPH_BREAK, False)
    text.insertString(cur, "Spike paragraph two.", False)
    vc = doc.getCurrentController().getViewCursor()
    vc.gotoEnd(False)  # deterministic: inserts land at the cursor

    code, status = http("GET", "/status", token=TOKEN)
    check("GET /status sees active Writer doc",
          code == 200 and status.get("active") and status.get("module") == "writer",
          f"module={status.get('module')}, title={status.get('title')!r}")

    code, docinfo = http("GET", "/document", token=TOKEN)
    ok = (code == 200 and docinfo.get("module") == "writer"
          and [p["text"] for p in docinfo.get("paragraphs", [])]
          == ["Spike paragraph one.", "Spike paragraph two."]
          and docinfo["paragraphs"][0]["style"] in ("Default Style", "Standard", "Text Body"))
    check("GET /document returns paragraphs with styles", ok,
          f"paragraphs={[(p['text'][:18], p['style']) for p in docinfo.get('paragraphs', [])]}")

    code, docs = http("GET", "/documents", token=TOKEN)
    check("GET /documents lists open documents",
          code == 200 and any(d["active"] and d["module"] == "writer"
                              for d in docs.get("documents", [])),
          f"docs={docs.get('documents')}")

    # formatted, tracked insert: leading \n makes it a fresh paragraph
    code, out = http("POST", "/insert", token=TOKEN,
                     payload={"text": "\nSpiked HTTP heading", "style": "Heading 2",
                              "bold": True, "tracked": True})
    check("POST /insert formatted + tracked", code == 200 and out.get("applied"),
          f"out={out}")

    paras = [(p.getString(), p.getPropertyValue("ParaStyleName"),
              p.getPropertyValue("CharWeight"))
             for p in doc.getText().createEnumeration()]
    ok = (len(paras) == 3
          and paras[2][0] == "Spiked HTTP heading"
          and paras[2][1] == "Heading 2"
          and paras[2][2] >= 100.0)
    check("insert applied as fresh Heading 2 + bold paragraph", ok,
          f"paras={[(t[:24], s, w) for t, s, w in paras]}")

    redlines = list(doc.getRedlines().createEnumeration())
    check("insert recorded as redline (tracked changes)",
          len(redlines) >= 1,
          f"{len(redlines)} redline(s)")

    # multi-paragraph insert over HTTP: two fresh paragraphs at the cursor
    code, out = http("POST", "/insert", token=TOKEN,
                     payload={"text": "\nLine A\nLine B", "tracked": True})
    paras = [p.getString() for p in doc.getText().createEnumeration()]
    check("POST /insert multi-paragraph creates real paragraphs",
          code == 200 and out.get("applied")
          and paras == ["Spike paragraph one.", "Spike paragraph two.",
                        "Spiked HTTP heading", "Line A", "Line B"],
          f"{len(paras)} paragraphs: {paras}")

    # events long-poll: subscribe, then change selection via UNO
    events_result = {}

    def poll():
        events_result["resp"] = http("GET", "/events?since=0&timeout=15", token=TOKEN)

    t = threading.Thread(target=poll)
    t.start()
    time.sleep(1.0)
    dispatcher = smgr.createInstanceWithContext("com.sun.star.frame.DispatchHelper", ctx)
    dispatcher.executeDispatch(doc.getCurrentController().getFrame(), ".uno:SelectAll", "", 0, ())
    dispatcher.executeDispatch(doc.getCurrentController().getFrame(), ".uno:GoDown", "", 0, ())
    t.join(timeout=20)
    ev = events_result.get("resp", (0, {}))
    kinds = [e["type"] for e in ev[1].get("events", [])]
    check("GET /events long-poll receives selection-changed",
          ev[0] == 200 and "selection-changed" in kinds,
          f"events={kinds}")

    # undo via HTTP reverts the last insert (one undo context = both paragraphs)
    code, out = http("POST", "/undo", token=TOKEN)
    paras = [p.getString() for p in doc.getText().createEnumeration()]
    check("POST /undo reverts last edit", code == 200 and out.get("undone")
          and paras == ["Spike paragraph one.", "Spike paragraph two.",
                        "Spiked HTTP heading"],
          f"out={out}, {len(paras)} paragraphs")

    # stop the bridge via UNO dispatch (menu path)
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
    sys_exit_code = main()
    raise SystemExit(sys_exit_code)