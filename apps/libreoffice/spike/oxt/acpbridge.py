"""ACP Assist bridge (spike) — HTTP server running inside LibreOffice.

Started from the Tools > Add-ons menu ("ACP Assist > Start bridge") or via
Tools > Macros > Python. All UNO work is marshaled onto the main thread via
com.sun.star.awt.AsyncCallback; the HTTP thread never touches UNO directly.

Discovery: writes <bridges-dir>/<pid>.json with {pid, port, token, startedAt}.
Every request must carry "Authorization: Bearer <token>".
"""

import http.server
import json
import os
import secrets
import sys
import threading
import traceback
from datetime import datetime, timezone

import uno
import unohelper

from com.sun.star.awt import XCallback
from com.sun.star.task import XJobExecutor
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.view import XSelectionChangeListener

APP_NAME = "LibreOffice ACP Assist"
PROTOCOL = 0  # spike
TIMEOUT_S = 30

_STATE = {"server": None, "port": None, "token": None, "startedAt": None}
_EVENTS = []          # [{seq, type, ts}]
_EVENTS_LOCK = threading.Lock()
_EVENTS_WAKE = threading.Event()
_SEQ = [0]
_REGISTERED = set()  # controllers already listening


# ---------------------------------------------------------------- helpers

def _context():
    try:
        return XSCRIPTCONTEXT.getComponentContext()
    except NameError:
        return uno.getComponentContext()


def _desktop():
    ctx = _context()
    return ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.Desktop", ctx)


def _bridges_dir():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
        return os.path.join(base, APP_NAME, "bridges")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library",
                            "Application Support", APP_NAME, "bridges")
    base = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(base, APP_NAME, "bridges")


def _discovery_path():
    return os.path.join(_bridges_dir(), f"{os.getpid()}.json")


def _record_event(kind):
    with _EVENTS_LOCK:
        _SEQ[0] += 1
        _EVENTS.append({"seq": _SEQ[0], "type": kind,
                        "ts": datetime.now(timezone.utc).isoformat()})
        if len(_EVENTS) > 500:
            del _EVENTS[:250]
    _EVENTS_WAKE.set()


class MainThreadCall(unohelper.Base, XCallback):
    """Run fn() on the main thread; caller blocks on done until timeout."""

    def __init__(self, fn):
        self.fn = fn
        self.done = threading.Event()
        self.result = None
        self.error = None

    def notify(self, data):
        try:
            self.result = self.fn()
        except Exception as e:
            self.error = e
        self.done.set()

    def run(self, timeout=TIMEOUT_S):
        ctx = _context()
        cb = ctx.ServiceManager.createInstanceWithContext(
            "com.sun.star.awt.AsyncCallback", ctx)
        cb.addCallback(self, None)
        if not self.done.wait(timeout):
            raise TimeoutError("main thread did not respond in time")
        if self.error is not None:
            raise self.error
        return self.result


class BridgeSelListener(unohelper.Base, XSelectionChangeListener):
    def selectionChanged(self, event):
        _record_event("selection-changed")

    def disposing(self, source):
        pass


def _module_of(doc):
    for name, svc in (
        ("writer", "com.sun.star.text.TextDocument"),
        ("calc", "com.sun.star.sheet.SpreadsheetDocument"),
        ("impress", "com.sun.star.presentation.PresentationDocument"),
        ("draw", "com.sun.star.drawing.DrawingDocument"),
    ):
        if doc.supportsService(svc):
            return name
    return "unknown"


def _active_doc(desktop):
    doc = desktop.getCurrentComponent()
    if doc is None or not hasattr(doc, "supportsService"):
        return None
    m = _module_of(doc)
    return doc if m != "unknown" else None


def _ensure_listener(doc):
    """Register the selection listener on this doc's controller once."""
    ctrl = doc.getCurrentController()
    if ctrl is None or ctrl in _REGISTERED:
        return
    _REGISTERED.add(ctrl)
    ctrl.addSelectionChangeListener(BridgeSelListener())


# ------------------------------------------------ main-thread operations

def _doc_status(desktop):
    doc = _active_doc(desktop)
    if doc is None:
        return {"active": False}
    _ensure_listener(doc)
    return {
        "active": True,
        "module": _module_of(doc),
        "title": doc.getTitle(),
        "recordChanges": bool(doc.getPropertyValue("RecordChanges")),
    }


def _doc_list(desktop):
    out = []
    active = _active_doc(desktop)
    active_title = active.getTitle() if active is not None else None
    enum = desktop.getComponents().createEnumeration()
    while enum.hasMoreElements():
        d = enum.nextElement()
        try:
            # pyuno wraps each reference differently, so compare by title
            out.append({
                "title": d.getTitle(),
                "module": _module_of(d),
                "active": d.getTitle() == active_title,
            })
        except Exception:
            pass
    return {"documents": out}


def _read_writer(doc):
    paras = []
    for i, p in enumerate(doc.getText().createEnumeration()):
        paras.append({
            "i": i,
            "text": p.getString(),
            "style": p.getPropertyValue("ParaStyleName"),
        })
    ctrl = doc.getCurrentController()
    sel = ctrl.getSelection()
    texts = None
    if sel.supportsService("com.sun.star.text.TextRanges"):
        texts = [sel.getByIndex(j).getString().replace("\r\n", "\n")
                 for j in range(sel.getCount())]
    return {
        "module": "writer",
        "title": doc.getTitle(),
        "paragraphs": paras,
        "text": doc.getText().getString().replace("\r\n", "\n"),
        "selection": texts,
    }


def _read_document(desktop):
    doc = _active_doc(desktop)
    if doc is None:
        return {"active": False}
    _ensure_listener(doc)
    if _module_of(doc) == "writer":
        return _read_writer(doc)
    return {"active": True, "module": _module_of(doc),
            "title": doc.getTitle()}


def _insert(desktop, payload):
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) != "writer":
        raise RuntimeError("no active Writer document")
    _ensure_listener(doc)

    text = payload.get("text", "")
    tracked = payload.get("tracked", True)
    style = payload.get("style")
    bold = payload.get("bold", False)

    was_tracking = doc.getPropertyValue("RecordChanges")
    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", True)

    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        ctrl = doc.getCurrentController()
        vc = ctrl.getViewCursor()
        for i, line in enumerate(text.split("\n")):
            if i > 0:
                doc.getText().insertControlCharacter(vc, PARAGRAPH_BREAK, False)
            if line:
                doc.getText().insertString(vc, line, False)
                if bold:
                    vc.goLeft(len(line), True)
                    vc.setPropertyValue("CharWeight", 150.0)
                    # end with the cursor just after the inserted run
                    vc.goRight(len(line), False)
                if style:
                    vc.setPropertyValue("ParaStyleName", style)
    finally:
        um.leaveUndoContext()

    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", was_tracking)

    _record_event("document-edited")
    return {"applied": True, "title": doc.getTitle(),
            "recordChanges": tracked}


def _undo(desktop):
    doc = _active_doc(desktop)
    if doc is None:
        raise RuntimeError("no active document")
    um = doc.getUndoManager()
    if not um.isUndoPossible():
        return {"undone": False, "reason": "nothing undoable"}
    um.undo()
    _record_event("document-edited")
    return {"undone": True}


OPS = {
    "status": _doc_status,
    "documents": _doc_list,
    "document": _read_document,
    "insert": _insert,
    "undo": _undo,
}


# ------------------------------------------------------------ HTTP layer

class BridgeHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _check_auth(self):
        expected = f"Bearer {_STATE['token']}"
        if self.headers.get("Authorization") != expected:
            self._json(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        try:
            if not self._check_auth():
                return
            if self.path == "/status":
                out = MainThreadCall(lambda: _doc_status(_desktop())).run()
                out["pid"] = os.getpid()
                out["port"] = _STATE["port"]
                out["startedAt"] = _STATE["startedAt"]
                self._json(200, out)
            elif self.path == "/document":
                self._json(200, MainThreadCall(
                    lambda: _read_document(_desktop())).run())
            elif self.path == "/documents":
                self._json(200, MainThreadCall(
                    lambda: _doc_list(_desktop())).run())
            elif self.path.startswith("/events"):
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                since = int(q.get("since", ["0"])[0])
                timeout = float(q.get("timeout", ["20"])[0])
                self._events(since, timeout)
            else:
                self._json(404, {"error": f"no route {self.path}"})
        except Exception as e:
            self._json(500, {"error": repr(e),
                             "trace": traceback.format_exc()})

    def _events(self, since, timeout):
        import time as _time
        deadline = _time.monotonic() + min(timeout, 120)
        while True:
            with _EVENTS_LOCK:
                fresh = [e for e in _EVENTS if e["seq"] > since]
            if fresh or _time.monotonic() >= deadline:
                last = since
                if fresh:
                    last = fresh[-1]["seq"]
                self._json(200, {"events": fresh, "last": last})
                return
            _EVENTS_WAKE.wait(timeout=1.0)
            _EVENTS_WAKE.clear()

    def do_POST(self):
        try:
            if not self._check_auth():
                return
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            if self.path.startswith("/insert"):
                op = "insert"
            elif self.path == "/undo":
                op = "undo"
            else:
                self._json(404, {"error": f"no route {self.path}"})
                return
            fn = OPS[op]
            if op == "insert":
                out = MainThreadCall(
                    lambda: fn(_desktop(), payload)).run()
            else:
                out = MainThreadCall(lambda: fn(_desktop())).run()
            self._json(200, out)
        except Exception as e:
            self._json(500, {"error": repr(e),
                             "trace": traceback.format_exc()})


def _start_server():
    if _STATE["server"] is not None:
        return {"status": "already-running", "port": _STATE["port"],
                "discovery": _discovery_path()}
    # Warm up UNO handles on the main thread before background traffic starts.
    desktop = _desktop()

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BridgeHandler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    token = secrets.token_hex(16)

    os.makedirs(_bridges_dir(), exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    record = {
        "app": "libreoffice-acp-assist-spike",
        "protocol": PROTOCOL,
        "pid": os.getpid(),
        "port": port,
        "token": token,
        "startedAt": started,
        "platform": sys.platform,
    }
    with open(_discovery_path(), "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)

    _STATE.update(server=httpd, port=port, token=token, startedAt=started)
    t = threading.Thread(target=httpd.serve_forever, daemon=True,
                         name="acp-bridge-http")
    t.start()
    # Register a listener on the active doc right away (if any).
    doc = _active_doc(desktop)
    if doc is not None:
        _ensure_listener(doc)
    return {"status": "running", "port": port, "pid": os.getpid(),
            "discovery": _discovery_path()}


def _stop_server():
    if _STATE["server"] is None:
        return {"status": "not-running"}
    httpd = _STATE["server"]
    httpd.shutdown()
    httpd.server_close()  # release the port so clients fail fast
    _STATE["server"] = None
    try:
        os.remove(_discovery_path())
    except OSError:
        pass
    return {"status": "stopped", "port": _STATE["port"]}


# ------------------------------------------------------- script entry points

def start(*args):
    result = _start_server()
    return json.dumps(result)


def stop(*args):
    return json.dumps(_stop_server())


# ----------------------------------------------------- UNO component entry

class BridgeJob(unohelper.Base, XJobExecutor):
    """Instantiated via menu URLs service:org.libreofficeacp.bridge?start"""

    def __init__(self, ctx):
        self.ctx = ctx

    def trigger(self, event):
        event = (event or "").strip().lower()
        if event == "start":
            return json.dumps(_start_server())
        if event == "stop":
            return json.dumps(_stop_server())
        return json.dumps({"error": f"unknown event {event!r}"})


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(
    BridgeJob,
    "org.libreofficeacp.bridge",
    ("com.sun.star.task.Job",),
)