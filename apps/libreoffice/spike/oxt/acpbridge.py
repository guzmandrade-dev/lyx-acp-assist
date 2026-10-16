"""ACP Assist bridge for LibreOffice — HTTP server inside the office process.

Dispatched from the ACP Assist menu (service:org.libreofficeacp.bridge?start
/ ?stop). The companion (Electron app) discovers this bridge via the
per-user bridges/ directory record and talks HTTP + bearer token.

Design rules (verified by the Phase 0 spike — see AGENTS.md):
- The HTTP thread NEVER touches UNO. Every operation runs on the main
  thread via com.sun.star.awt.AsyncCallback (SolarMutex is not
  thread-safe); the handler blocks on a Python Event with a timeout.
- Edits are applied inside ONE undo-manager transaction, recorded as
  tracked changes (RecordChanges toggled around the transaction).
- Insertion at a cursor is typing semantics: a paragraph break first
  creates a fresh paragraph; runs get direct character formatting and each
  paragraph may carry a Writer paragraph style.
"""

import http.server
import json
import os
import re
import secrets
import sys
import threading
import traceback
from datetime import datetime, timezone

import uno
import unohelper

from com.sun.star.awt import XCallback
from com.sun.star.awt.FontSlant import NONE as FONT_SLANT_NONE
from com.sun.star.awt.FontSlant import ITALIC as FONT_SLANT_ITALIC
from com.sun.star.task import XJobExecutor
from com.sun.star.text.ControlCharacter import PARAGRAPH_BREAK
from com.sun.star.view import XSelectionChangeListener

APP_NAME = "LibreOffice ACP Assist"
IMPL_NAME = "org.libreofficeacp.bridge"
PROTOCOL = 1
TIMEOUT_S = 30

# /document body size (chars) above which only previews are returned.
BODY_LIMIT = 32_000
# Per-paragraph preview length in preview mode.
PREVIEW_LEN = 200

_STATE = {"server": None, "port": None, "token": None, "startedAt": None}
_EVENTS = []
_EVENTS_LOCK = threading.Lock()
_EVENTS_WAKE = threading.Event()
_SEQ = [0]
_REGISTERED = set()  # controllers already listening
_MONO_FONT = "Liberation Mono"


# ---------------------------------------------------------------- context

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
    """Run fn() on the main thread; caller blocks until done or timeout."""

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
    return doc if _module_of(doc) != "unknown" else None


def _doc_url(doc):
    try:
        return doc.getURL() or ""
    except Exception:
        return ""


def _doc_key(doc):
    """Stable identity for a document: its URL, or the title as fallback."""
    return _doc_url(doc) or doc.getTitle()


def _ensure_listener(doc):
    ctrl = doc.getCurrentController()
    if ctrl is None or ctrl in _REGISTERED:
        return
    _REGISTERED.add(ctrl)
    ctrl.addSelectionChangeListener(BridgeSelListener())


def _view_cursor_style(doc):
    try:
        vc = doc.getCurrentController().getViewCursor()
        return str(vc.getPropertyValue("ParaStyleName"))
    except Exception:
        return None


def _writer_paragraphs(doc, preview=False):
    """All paragraphs as {i, text, style}; text truncated in preview mode."""
    out = []
    for i, p in enumerate(doc.getText().createEnumeration()):
        t = p.getString()
        if preview and len(t) > PREVIEW_LEN:
            t = t[:PREVIEW_LEN] + "…"
        out.append({
            "i": i,
            "text": t.replace("\r\n", "\n"),
            "style": str(p.getPropertyValue("ParaStyleName")),
        })
    return out


def _nth_paragraph(doc, n):
    """0-based paragraph accessor for the 1-based [pN] addressing."""
    for i, p in enumerate(doc.getText().createEnumeration()):
        if i == n - 1:
            return p
    raise RuntimeError(f"paragraph [p{n}] does not exist")


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
        "url": _doc_url(doc),
        "recordChanges": bool(doc.getPropertyValue("RecordChanges")),
    }


def _doc_list(desktop):
    out = []
    active = _active_doc(desktop)
    active_key = _doc_key(active) if active is not None else None
    enum = desktop.getComponents().createEnumeration()
    while enum.hasMoreElements():
        d = enum.nextElement()
        try:
            # pyuno returns a fresh wrapper per call; compare by identity key.
            out.append({
                "title": d.getTitle(),
                "url": _doc_url(d),
                "module": _module_of(d),
                "active": _doc_key(d) == active_key,
            })
        except Exception:
            pass
    return {"documents": out}


def _read_document(desktop):
    doc = _active_doc(desktop)
    if doc is None:
        return {"active": False}
    _ensure_listener(doc)
    base = {
        "active": True,
        "module": _module_of(doc),
        "title": doc.getTitle(),
        "url": _doc_url(doc),
        "cursorStyle": _view_cursor_style(doc),
    }
    if base["module"] != "writer":
        return base

    paras_full = _writer_paragraphs(doc, preview=False)
    body_size = sum(len(p["text"]) for p in paras_full)
    if body_size <= BODY_LIMIT:
        paras, truncated = paras_full, False
    else:
        paras, truncated = _writer_paragraphs(doc, preview=True), True

    sel = None
    s = doc.getCurrentController().getSelection()
    if s.supportsService("com.sun.star.text.TextRanges"):
        texts = [s.getByIndex(j).getString().replace("\r\n", "\n")
                 for j in range(s.getCount())]
        if any(t for t in texts):
            sel = texts
    base["paragraphs"] = paras
    base["truncated"] = truncated
    base["selection"] = sel
    return base


def _read_paragraph(desktop, index):
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) != "writer":
        raise RuntimeError("no active Writer document")
    for i, p in enumerate(doc.getText().createEnumeration()):
        if i == index:
            return {"i": i, "text": p.getString().replace("\r\n", "\n"),
                    "style": str(p.getPropertyValue("ParaStyleName"))}
    raise RuntimeError(f"paragraph [p{index + 1}] does not exist")


def _activate_document(desktop, url_or_title):
    target = str(url_or_title or "")
    if not target:
        raise RuntimeError("url is required")
    enum = desktop.getComponents().createEnumeration()
    while enum.hasMoreElements():
        d = enum.nextElement()
        try:
            if _doc_url(d) == target or d.getTitle() == target:
                d.getCurrentController().getFrame().activate()
                return {"activated": target}
        except Exception:
            pass
    raise RuntimeError(f"no open document matches {target!r}")


def _write_paragraphs(doc, cursor, paragraphs, break_mode):
    """Write structured paragraphs at the view cursor (typing semantics).

    break_mode:
    - 'before': paragraph break before EVERY paragraph (insert modes) —
      content lands as fresh paragraph(s) below the cursor.
    - 'between': break only BETWEEN paragraphs (rewrite modes) — the
      first paragraph fills the current (emptied) position.
    - 'after': content first, break after EVERY paragraph (insert-top) —
      verified: break-before at the document start degenerates.
    Run properties are set explicitly ON and OFF so text typed after
    formatted text does not inherit the formatting (typing continuation).
    """
    text = doc.getText()
    n = len(paragraphs)
    for idx, para in enumerate(paragraphs):
        if break_mode == "before" or (break_mode == "between" and idx > 0):
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)
        for run in para.get("runs") or []:
            s = run.get("text", "")
            if s == "":
                continue
            text.insertString(cursor, s, False)
            # Direct character formatting on the just-written run
            # (verified pattern: select the run, set the properties,
            # collapse after it).
            try:
                cursor.goLeft(len(s), True)
                cursor.setPropertyValue("CharWeight",
                                        150.0 if run.get("bold") else 100.0)
                cursor.setPropertyValue("CharPosture",
                                        FONT_SLANT_ITALIC if run.get("italic") else FONT_SLANT_NONE)
                if run.get("code"):
                    cursor.setPropertyValue("CharFontName", _MONO_FONT)
                cursor.goRight(len(s), False)
            except Exception:
                pass
        if para.get("style"):
            try:
                cursor.setPropertyValue("ParaStyleName", para["style"])
            except Exception:
                pass  # unknown style name: keep the default, never fail
        if break_mode == "after":
            text.insertControlCharacter(cursor, PARAGRAPH_BREAK, False)


def _require_writer(desktop):
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) != "writer":
        raise RuntimeError("no active Writer document")
    _ensure_listener(doc)
    return doc


def _dispatch_delete(doc):
    """Delete the view-cursor selection via the UI's own edit route.

    Raw setString('') on a selection that includes the paragraph break
    silently no-ops or coalesces unpredictably under RecordChanges inside
    undo contexts (probes 8-9); the dispatch path records a clean
    pending-deletion redline (probe 10) and coalesces never-accepted
    insertions the way the UI does.
    """
    ctx = _context()
    dispatcher = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.DispatchHelper", ctx)
    dispatcher.executeDispatch(
        doc.getCurrentController().getFrame(), ".uno:Delete", "", 0, ())


def _edit(desktop, payload):
    mode = payload.get("mode")
    if mode not in ("insert", "insert-top", "insert-after",
                    "rewrite", "rewrite-at", "delete-at"):
        raise RuntimeError(f"unknown edit mode {mode!r}")

    doc = _require_writer(desktop)
    text = doc.getText()
    ctrl = doc.getCurrentController()

    paragraphs = payload.get("paragraphs")
    if mode != "delete-at" and not paragraphs:
        raise RuntimeError(f"mode {mode!r} requires paragraphs")
    target = payload.get("target")
    if mode in ("insert-after", "rewrite-at", "delete-at"):
        if not isinstance(target, int) or target < 1:
            raise RuntimeError(f"mode {mode!r} requires a 1-based target")
        count = len(_writer_paragraphs(doc))
        if target > count:
            raise RuntimeError(
                f"paragraph [p{target}] does not exist (document has {count})")

    tracked = bool(payload.get("tracked", True))
    was_tracking = doc.getPropertyValue("RecordChanges")
    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", True)

    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        vc = ctrl.getViewCursor()
        if mode == "insert":
            _write_paragraphs(doc, vc, paragraphs, break_mode="before")

        elif mode == "insert-top":
            vc.gotoStart(False)
            _write_paragraphs(doc, vc, paragraphs, break_mode="after")

        elif mode == "insert-after":
            para = _nth_paragraph(doc, target)
            vc.gotoRange(para.getEnd(), False)
            _write_paragraphs(doc, vc, paragraphs, break_mode="before")

        elif mode == "rewrite-at":
            # Verified choreography (probe 7): collapse at the paragraph
            # START, select its text, delete, then type the replacement
            # (first paragraph fills the emptied paragraph).
            para = _nth_paragraph(doc, target)
            vc.gotoRange(para.getStart(), False)
            vc.goRight(len(para.getString()), True)
            vc.setString("")
            _write_paragraphs(doc, vc, paragraphs, break_mode="between")

        elif mode == "rewrite":
            sel = ctrl.getSelection()
            if not sel.supportsService("com.sun.star.text.TextRanges") or sel.getCount() == 0:
                raise RuntimeError("no active selection to rewrite")
            sel_text = "".join(
                sel.getByIndex(j).getString() for j in range(sel.getCount()))
            if sel_text == "":
                raise RuntimeError("the active selection is empty")
            vc.setString("")  # delete the selection; view cursor at its start
            _write_paragraphs(doc, vc, paragraphs, break_mode="between")

        elif mode == "delete-at":
            para = _nth_paragraph(doc, target)
            vc.gotoRange(para.getStart(), False)
            if not vc.goRight(len(para.getString()) + 1, True):
                vc.goRight(len(para.getString()), True)
            _dispatch_delete(doc)
            # Coalescing artifact (probe 11): deleting a never-accepted
            # insertion cancels its text but leaves an EMPTY paragraph.
            # It is content-free, so remove it UNTRACKED inside the same
            # undo transaction — the user sees no stray empty line and
            # one undo restores everything.
            paras = _writer_paragraphs(doc)
            if len(paras) >= target and paras[target - 1]["text"] == "":
                if tracked:
                    doc.setPropertyValue("RecordChanges", False)
                try:
                    empty = _nth_paragraph(doc, target)
                    vc.gotoRange(empty.getStart(), False)
                    vc.goRight(1, True)
                    vc.setString("")
                finally:
                    if tracked:
                        doc.setPropertyValue("RecordChanges", True)
    finally:
        um.leaveUndoContext()

    if tracked and not was_tracking:
        doc.setPropertyValue("RecordChanges", was_tracking)

    _record_event("document-edited")
    return {"applied": True, "title": doc.getTitle(), "mode": mode,
            "target": target}


def _undo(desktop):
    doc = _active_doc(desktop)
    if doc is None:
        raise RuntimeError("no active document")
    um = doc.getUndoManager()
    if not um.isUndoPossible():
        return {"undone": False, "reason": "nothing to undo"}
    um.undo()
    _record_event("document-edited")
    return {"undone": True}


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

    def _main(self, fn):
        """Marshal a UNO operation onto the main thread with a timeout."""
        try:
            return MainThreadCall(fn).run()
        except Exception as e:
            self._json(500, {"error": repr(e), "trace": traceback.format_exc()})
        return None

    def do_GET(self):
        if not self._check_auth():
            return
        m = re.match(r"^/document/p/(\d+)$", self.path)
        if m is not None:
            index = int(m.group(1))
            out = self._main(lambda: _read_paragraph(_desktop(), index))
            if out is not None:
                self._json(200, out)
        elif self.path == "/status":
            def status():
                out = _doc_status(_desktop())
                out.update(pid=os.getpid(), port=_STATE["port"],
                           startedAt=_STATE["startedAt"])
                return out
            out = self._main(status)
            if out is not None:
                self._json(200, out)
        elif self.path == "/document":
            out = self._main(lambda: _read_document(_desktop()))
            if out is not None:
                self._json(200, out)
        elif self.path == "/documents":
            out = self._main(lambda: _doc_list(_desktop()))
            if out is not None:
                self._json(200, out)
        elif self.path.startswith("/events"):
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            since = int(q.get("since", ["0"])[0])
            timeout = float(q.get("timeout", ["20"])[0])
            self._events(since, timeout)
        else:
            self._json(404, {"error": f"no route {self.path}"})

    def _events(self, since, timeout):
        import time as _time
        deadline = _time.monotonic() + min(timeout, 120)
        while True:
            with _EVENTS_LOCK:
                fresh = [e for e in _EVENTS if e["seq"] > since]
            if fresh or _time.monotonic() >= deadline:
                last = fresh[-1]["seq"] if fresh else since
                self._json(200, {"events": fresh, "last": last})
                return
            _EVENTS_WAKE.wait(timeout=1.0)
            _EVENTS_WAKE.clear()

    def do_POST(self):
        if not self._check_auth():
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._json(400, {"error": f"bad JSON body: {e!r}"})
            return
        if self.path == "/edit":
            out = self._main(lambda: _edit(_desktop(), payload))
        elif self.path == "/activate":
            out = self._main(lambda: _activate_document(_desktop(), payload.get("url")))
        elif self.path == "/undo":
            out = self._main(lambda: _undo(_desktop()))
        else:
            self._json(404, {"error": f"no route {self.path}"})
            return
        if out is not None:
            self._json(200, out)


def _start_server():
    if _STATE["server"] is not None:
        return {"status": "already-running", "port": _STATE["port"],
                "discovery": _discovery_path()}
    # Warm up UNO handles on the main thread before background traffic.
    desktop = _desktop()

    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), BridgeHandler)
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    token = secrets.token_hex(16)

    os.makedirs(_bridges_dir(), exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    record = {
        "app": "libreoffice-acp-assist",
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


# ------------------------------------------------------- UNO component entry

class BridgeJob(unohelper.Base, XJobExecutor):
    """Instantiated via menu URLs service:org.libreofficeacp.bridge?start."""

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
    IMPL_NAME,
    ("com.sun.star.task.Job",),
)