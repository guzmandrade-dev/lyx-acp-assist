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
# Calc: max rows/cols of a selected range returned per /document read.
CALC_MAX_ROWS = 200
CALC_MAX_COLS = 20

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


# ----------------------------------------------------------- calc helpers

def _col_letters(col):
    """0-based column index -> A1 letters (0 -> 'A', 25 -> 'Z', 26 -> 'AA')."""
    s = ""
    n = col + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _a1_range(addr):
    """CellRangeAddress -> 'A1:C3' (sheet-relative)."""
    return (f"{_col_letters(addr.StartColumn)}{addr.StartRow + 1}:"
            f"{_col_letters(addr.EndColumn)}{addr.EndRow + 1}")


def _parse_a1(token):
    """'B12' -> (col, row) 0-based; user-facing error on bad addresses."""
    m = re.match(r"^([A-Za-z]{1,4})([1-9][0-9]{0,6})$", str(token).strip())
    if m is None:
        raise RuntimeError(f"{token!r} is not a valid A1 cell address (e.g. B2)")
    col = 0
    for ch in m.group(1).upper():
        col = col * 26 + (ord(ch) - 64)
    return col - 1, int(m.group(2)) - 1


def _calc_value(v):
    """One cell value from getDataArray() -> a compact string."""
    if v is None:
        return ""
    if isinstance(v, (int, float)) and float(v).is_integer():
        return str(int(v))
    return str(v)


def _calc_sel_ranges(sel):
    """Selection object -> list of CellRangeAddress (single or multi range)."""
    out = []
    try:
        if sel.supportsService("com.sun.star.sheet.SheetCellRanges"):
            enum = sel.createEnumeration()
            while enum.hasMoreElements():
                out.append(enum.nextElement().getRangeAddress())
        else:
            out.append(sel.getRangeAddress())
    except Exception:
        pass
    return out


def _trim_empty(values):
    """Drop trailing empty rows/columns from a values grid."""
    while values and all(c == "" for c in values[-1]):
        values.pop()
    if values:
        width = len(values[0])
        while width > 0 and all(row[width - 1] == "" for row in values):
            width -= 1
        if width < len(values[0]):
            values = [row[:width] for row in values]
    return values


def _calc_range_data(sheet, a):
    """Capped values + formulas for one CellRangeAddress."""
    rows = a.EndRow - a.StartRow + 1
    cols = a.EndColumn - a.StartColumn + 1
    cap_rows = min(rows, CALC_MAX_ROWS)
    cap_cols = min(cols, CALC_MAX_COLS)
    block = sheet.getCellRangeByPosition(
        a.StartColumn, a.StartRow,
        a.StartColumn + cap_cols - 1, a.StartRow + cap_rows - 1)
    values = [[_calc_value(v) for v in row] for row in block.getDataArray()]
    truncated = rows > cap_rows or cols > cap_cols
    while values and sum(len(c) for row in values for c in row) > BODY_LIMIT:
        values.pop()
        truncated = True
    values = _trim_empty(values)
    formulas = None
    if values:
        block2 = sheet.getCellRangeByPosition(
            a.StartColumn, a.StartRow,
            a.StartColumn + len(values[0]) - 1, a.StartRow + len(values) - 1)
        frows = [[str(f) for f in row] for row in block2.getFormulaArray()]
        if any(f.startswith("=") for row in frows for f in row):
            formulas = frows
    return values, formulas, truncated


def _read_calc(doc):
    """Calc branch of /document: sheet inventory + selection data."""
    ctrl = doc.getCurrentController()
    sheets = []
    active_sheet = None
    try:
        active_sheet = ctrl.getActiveSheet()
    except Exception:
        pass
    active_name = active_sheet.getName() if active_sheet is not None else None
    container = doc.getSheets()
    for name in container.getElementNames():
        used = "A1:A1"
        try:
            cur = container.getByName(name).createCursor()
            cur.gotoEndOfUsedArea(False)
            cur.gotoStartOfUsedArea(True)
            used = _a1_range(cur.getRangeAddress())
        except Exception:
            pass
        sheets.append({"name": name, "usedRange": used,
                       "active": name == active_name})

    out = {"sheets": sheets, "selection": None, "data": None}
    ranges = _calc_sel_ranges(ctrl.getSelection())
    if not ranges:
        return out
    a = ranges[0]
    names = []
    for r in ranges:
        sheet_name = container.getByIndex(r.Sheet).getName()
        names.append(f"{sheet_name}!{_a1_range(r)}")

    sheet = container.getByIndex(a.Sheet)
    values, formulas, truncated = _calc_range_data(sheet, a)
    out["selection"] = {
        "sheet": sheet.getName(),
        "ranges": names,
        "anchor": f"{_col_letters(a.StartColumn)}{a.StartRow + 1}",
        "rows": len(values),
        "cols": len(values[0]) if values else 0,
        "values": values,
        "formulas": formulas,
        "truncated": truncated,
    }

    # Active sheet's used-range data: the agent's window beyond the
    # selection (capped + trimmed the same way).
    if active_sheet is not None:
        cur = active_sheet.createCursor()
        cur.gotoEndOfUsedArea(False)
        cur.gotoStartOfUsedArea(True)
        addr = cur.getRangeAddress()
        dvalues, dformulas, dtruncated = _calc_range_data(active_sheet, addr)
        out["data"] = {
            "sheet": active_name,
            "range": _a1_range(addr),
            "values": dvalues,
            "formulas": dformulas,
            "truncated": dtruncated,
        }
    return out


# --------------------------------------------------------- slides helpers

# Impress/Draw: read caps and the cloned default placeholder geometry
# (probe 12h H4 — matches what .uno:InsertPage creates).
IMPRESS_MAX_SLIDES = 200
IMPRESS_SHAPE_TEXT_LIMIT = 4_000
SEL_SHAPES_LIMIT = 50
SLIDE_TITLE_POS = (1400, 628)
SLIDE_TITLE_SIZE = (25199, 2629)
SLIDE_BODY_POS = (1400, 3685)
SLIDE_BODY_SIZE = (25199, 9134)

# Impress/Draw edits bypass the native undo stack entirely (rule 27:
# API text edits create no undo actions and insertNewByIndex pushes a
# broken one) — every edit runs inside um.lock()/unlock() and appends a
# journal entry; /undo pops it. Entries: {"texts": [[slide, shape,
# before], ...], "deletePage": int|None}.
_SLIDES_JOURNAL = {}


def _shape_kind(shape):
    """Classify a slide shape by its TYPE name (rule 23: supportsService
    lies for presentation shapes). 'other' shapes are counted, not read."""
    try:
        t = shape.getShapeType()
    except Exception:
        return "other"
    if t.endswith("presentation.TitleTextShape"):
        return "title"
    if t.endswith("presentation.OutlinerShape") or t.endswith("presentation.SubtitleShape"):
        return "body"
    if t.endswith("drawing.TextShape"):
        return "text"
    return "other"


def _shape_text(shape):
    try:
        return shape.getText().getString().replace("\r\n", "\n")
    except Exception:
        return None


def _current_page_index(doc):
    """Index of the active draw page via == comparison (rule 25)."""
    try:
        cur = doc.getCurrentController().getCurrentPage()
        pages = doc.getDrawPages()
        for i in range(pages.getCount()):
            if pages.getByIndex(i) == cur:
                return i
    except Exception:
        pass
    return None


def _slide_payload(doc, index):
    """One slide: {i, name, current, shapes: [{i, kind, text}]}."""
    page = doc.getDrawPages().getByIndex(index)
    budget = IMPRESS_SHAPE_TEXT_LIMIT
    shapes = []
    for j in range(page.getCount()):
        s = page.getByIndex(j)
        kind = _shape_kind(s)
        text = None
        if kind != "other":
            text = _shape_text(s) or ""
            if len(text) > budget:
                text = text[:max(budget, 0)] + "…"
            budget -= len(text)
        shapes.append({"i": j, "kind": kind, "text": text})
    return {"i": index, "name": page.getName(),
            "current": _current_page_index(doc) == index, "shapes": shapes}


def _impress_selection(doc):
    """Selected shapes -> [{slide, shape, kind, text}] (rule 26)."""
    try:
        sel = doc.getCurrentController().getSelection()
    except Exception:
        return None
    if sel is None:
        return None
    targets = []
    try:
        for k in range(min(sel.getCount(), SEL_SHAPES_LIMIT)):
            targets.append(sel.getByIndex(k))
    except Exception:
        if hasattr(sel, "getShapeType"):
            targets.append(sel)
        else:
            return None  # text-edit selection or unknown: treat as none
    pages = doc.getDrawPages()
    out = []
    for target in targets:
        found = None
        for i in range(pages.getCount()):
            p = pages.getByIndex(i)
            for j in range(p.getCount()):
                if p.getByIndex(j) == target:
                    found = (i, j)
                    break
            if found is not None:
                break
        if found is None:
            continue
        out.append({"slide": found[0], "shape": found[1],
                    "kind": _shape_kind(target),
                    "text": _shape_text(target) if _shape_kind(target) != "other" else None})
    return out or None


def _read_slides(doc):
    """Impress/Draw branch of /document: the deck outline + selection."""
    pages = doc.getDrawPages()
    count = pages.getCount()
    slides = [_slide_payload(doc, i) for i in range(min(count, IMPRESS_MAX_SLIDES))]
    return {
        "slides": slides,
        "selection": _impress_selection(doc),
        "truncated": count > IMPRESS_MAX_SLIDES,
    }


def _require_slides(desktop):
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) not in ("impress", "draw"):
        raise RuntimeError("no active Impress/Draw document")
    _ensure_listener(doc)
    return doc


def _get_slide(doc, index):
    """0-based slide accessor with user-facing errors."""
    pages = doc.getDrawPages()
    if not isinstance(index, int) or index < 0:
        raise RuntimeError("slide index must be a non-negative integer")
    if index >= pages.getCount():
        raise RuntimeError(
            f"slide [s{index + 1}] does not exist (deck has {pages.getCount()} slides)")
    return pages.getByIndex(index)


def _get_frame(doc, slide_index, shape_index):
    page = _get_slide(doc, slide_index)
    if not isinstance(shape_index, int) or shape_index < 0:
        raise RuntimeError("shape index must be a non-negative integer")
    if shape_index >= page.getCount():
        raise RuntimeError(
            f"shape [{shape_index}] does not exist on slide "
            f"[s{slide_index + 1}] (slide has {page.getCount()} shapes)")
    shape = page.getByIndex(shape_index)
    if _shape_kind(shape) == "other" or _shape_text(shape) is None:
        raise RuntimeError(
            f"the frame at slide [s{slide_index + 1}] shape {shape_index} "
            "holds no text")
    return shape


def _find_title_body(page, draw=False):
    """First title-ish and body-ish shapes of a slide (rule 23)."""
    title = body = None
    for j in range(page.getCount()):
        s = page.getByIndex(j)
        kind = _shape_kind(s)
        if kind == "other":
            continue
        if title is None and (kind == "title" or (draw and kind == "text")):
            title = s
        elif body is None and kind == "body" or (draw and kind == "text" and title is not None):
            body = s
    return title, body


def _shape_index_in_page(page, shape):
    for j in range(page.getCount()):
        if page.getByIndex(j) == shape:
            return j
    return None


def _add_frame(doc, page, service, pos, size, text):
    shape = doc.createInstance(service)
    page.add(shape)
    shape.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", pos[0], pos[1]))
    shape.setSize(uno.createUnoStruct("com.sun.star.awt.Size", size[0], size[1]))
    shape.getText().setString(text)
    return shape


def _fill_new_slide(doc, page, title, body_text):
    """Create the title + body frames on a freshly inserted page, with the
    cloned default geometry (rules 24, 29). Draw: one plain text frame."""
    if _module_of(doc) == "draw":
        text = title if not body_text else title + "\n" + body_text
        _add_frame(doc, page, "com.sun.star.drawing.TextShape",
                   SLIDE_TITLE_POS, SLIDE_TITLE_SIZE, text)
        return
    _add_frame(doc, page, "com.sun.star.presentation.TitleTextShape",
               SLIDE_TITLE_POS, SLIDE_TITLE_SIZE, title)
    _add_frame(doc, page, "com.sun.star.presentation.OutlinerShape",
               SLIDE_BODY_POS, SLIDE_BODY_SIZE, body_text)


def _journal_append(doc, entry):
    key = _doc_key(doc)
    _SLIDES_JOURNAL.setdefault(key, []).append(entry)
    # Keep the journal bounded; oldest entries are the least likely to be
    # reverted anyway.
    if len(_SLIDES_JOURNAL[key]) > 100:
        del _SLIDES_JOURNAL[key][:50]


def _dispatch_delete_page(doc):
    """Delete the CURRENT page via the UI route (rule 30: the only
    working page removal; steered with setCurrentPage by callers)."""
    ctx = _context()
    dispatcher = ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.frame.DispatchHelper", ctx)
    dispatcher.executeDispatch(
        doc.getCurrentController().getFrame(), ".uno:DeletePage", "", 0, ())


def _parse_slide_text_args(payload, need_body=False):
    """Common validation of the text arguments of the slide edit modes."""
    title = payload.get("title")
    if not isinstance(title, str):
        raise RuntimeError("title is required (a string, may be empty)")
    body = payload.get("body")
    if body is None:
        if need_body:
            raise RuntimeError("body is required (a list of paragraph strings)")
        body = []
    if (not isinstance(body, list) or not all(isinstance(b, str) for b in body)):
        raise RuntimeError("body must be a list of paragraph strings")
    return title, body


def _edit_slides(desktop, payload):
    mode = payload.get("mode")
    doc = _require_slides(desktop)
    draw = _module_of(doc) == "draw"

    # ---- rewrite-frame: one shape's text (slide + shape are 0-based
    # payload indices, mirroring /document)
    if mode == "rewrite-frame":
        paragraphs = payload.get("paragraphs")
        if (not isinstance(paragraphs, list) or not paragraphs
                or not all(isinstance(p, str) for p in paragraphs)):
            raise RuntimeError(
                "mode 'rewrite-frame' requires paragraphs (list of strings)")
        shape = _get_frame(doc, payload.get("slide"), payload.get("shape"))
        before = shape.getText().getString()
        um = doc.getUndoManager()
        um.lock()
        try:
            shape.getText().setString("\n".join(paragraphs))
        finally:
            um.unlock()
        _journal_append(doc, {"texts": [[payload["slide"], payload["shape"],
                                         before]], "deletePage": None})
        _record_event("document-edited")
        return {"applied": True, "title": doc.getTitle(), "mode": mode,
                "slide": payload["slide"], "shape": payload["shape"]}

    # ---- rewrite-slide: title (+ optionally body) of one slide
    if mode == "rewrite-slide":
        if draw:
            raise RuntimeError(
                "Draw has no title/body frames; select a frame and use rewrite")
        title, body = _parse_slide_text_args(payload)
        page = _get_slide(doc, payload.get("slide"))
        title_shape, body_shape = _find_title_body(page)
        if title_shape is None:
            raise RuntimeError(
                f"slide [s{payload['slide'] + 1}] has no title frame")
        if body and body_shape is None:
            raise RuntimeError(
                f"slide [s{payload['slide'] + 1}] has no body frame "
                "(cannot write body text)")
        snap = []
        ti = _shape_index_in_page(page, title_shape)
        snap.append([payload["slide"], ti, title_shape.getText().getString()])
        if body:
            bi = _shape_index_in_page(page, body_shape)
            snap.append([payload["slide"], bi, body_shape.getText().getString()])
        um = doc.getUndoManager()
        um.lock()
        try:
            title_shape.getText().setString(title)
            if body:
                body_shape.getText().setString("\n".join(body))
        finally:
            um.unlock()
        _journal_append(doc, {"texts": snap, "deletePage": None})
        _record_event("document-edited")
        return {"applied": True, "title": doc.getTitle(), "mode": mode,
                "slide": payload["slide"]}

    # ---- insert-slide-after: slide is the agent's anchor — 0 = insert at
    # the very start, N >= 1 = after 1-based slide N
    if mode == "insert-slide-after":
        title, body = _parse_slide_text_args(payload)
        body_text = "\n".join(body)
        anchor = payload.get("slide")
        if not isinstance(anchor, int) or anchor < 0:
            raise RuntimeError(
                "mode 'insert-slide-after' requires a slide anchor (0 = start)")
        pages = doc.getDrawPages()
        count = pages.getCount()
        if anchor == 0:
            # Rule 31: no page can be created at index 0 — swap slide 1's
            # content into a page inserted at index 1 instead.
            page1 = pages.getByIndex(0)
            title_shape, body_shape = _find_title_body(page1, draw=draw)
            if title_shape is None:
                raise RuntimeError(
                    "cannot insert at the start: slide [s1] has no title frame")
            if body and body_shape is None:
                raise RuntimeError(
                    "cannot insert at the start: slide [s1] has no body frame "
                    "(cannot move its content)")
            snap = [[0, _shape_index_in_page(page1, title_shape),
                     title_shape.getText().getString()]]
            if body_shape is not None:
                snap.append([0, _shape_index_in_page(page1, body_shape),
                             body_shape.getText().getString()])
            old_body = body_shape.getText().getString() if body_shape else ""
            um = doc.getUndoManager()
            um.lock()
            try:
                pages.insertNewByIndex(0)  # lands at index 1 (rule 29)
                new_page = pages.getByIndex(1)
                _fill_new_slide(doc, new_page,
                                title_shape.getText().getString(), old_body)
                title_shape.getText().setString(title)
                if body_shape is not None:
                    body_shape.getText().setString(body_text)
            finally:
                um.unlock()
            _journal_append(doc, {"texts": snap, "deletePage": 1})
        else:
            if anchor > count:
                raise RuntimeError(
                    f"slide [s{anchor}] does not exist (deck has {count} slides)")
            um = doc.getUndoManager()
            um.lock()
            try:
                pages.insertNewByIndex(anchor - 1)  # lands at index `anchor`
                new_page = pages.getByIndex(anchor)
                if new_page.getCount() != 0:
                    raise RuntimeError(
                        "internal error: the new slide landed at the wrong index")
                _fill_new_slide(doc, new_page, title, body_text)
            finally:
                um.unlock()
            _journal_append(doc, {"texts": [], "deletePage": anchor})
        _record_event("document-edited")
        return {"applied": True, "title": doc.getTitle(), "mode": mode,
                "slide": anchor}

    raise RuntimeError(f"unknown edit mode {mode!r}")


def _undo_slides(doc):
    """Impress/Draw undo: pop the bridge journal (rule 27)."""
    journal = _SLIDES_JOURNAL.get(_doc_key(doc)) or []
    if journal:
        entry = journal.pop()
        um = doc.getUndoManager()
        um.lock()
        try:
            dp = entry.get("deletePage")
            pages = doc.getDrawPages()
            if dp is not None and 0 <= dp < pages.getCount():
                ctrl = doc.getCurrentController()
                ctrl.setCurrentPage(pages.getByIndex(dp))
                _dispatch_delete_page(doc)
            for slide, shape, before in entry.get("texts") or []:
                try:
                    pages.getByIndex(slide).getByIndex(shape).getText().setString(before)
                except Exception:
                    pass  # shape gone (user edits): best-effort restore
        finally:
            um.unlock()
        _record_event("document-edited")
        return {"undone": True}
    um = doc.getUndoManager()
    if um.isUndoPossible():
        um.undo()
        _record_event("document-edited")
        return {"undone": True}
    return {"undone": False, "reason": "nothing to undo"}


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
        "recordChanges": _get_record_changes(doc),
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
    if base["module"] == "calc":
        base["calc"] = _read_calc(doc)
        return base
    if base["module"] in ("impress", "draw"):
        out = _read_slides(doc)
        base["slides"] = out["slides"]
        base["selection"] = out["selection"]
        base["truncated"] = out["truncated"]
        return base
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


def _read_slide_lazy(desktop, index):
    """Lazy fetch of one slide's full shape list (mirrors /document/p/:i)."""
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) not in ("impress", "draw"):
        raise RuntimeError("no active Impress/Draw document")
    return {"slide": _slide_payload(doc, index)}


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


def _get_record_changes(doc):
    """Read RecordChanges; None when the module doesn't expose it."""
    try:
        return bool(doc.getPropertyValue("RecordChanges"))
    except Exception:
        return None


def _set_record_changes(doc, value):
    try:
        doc.setPropertyValue("RecordChanges", value)
        return True
    except Exception:
        return False


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


def _require_calc(desktop):
    doc = _active_doc(desktop)
    if doc is None or _module_of(doc) != "calc":
        raise RuntimeError("no active Calc document")
    _ensure_listener(doc)
    return doc


def _set_cell(cell, value):
    """One TSV cell -> the sheet cell: '=' formulas, numbers, else text."""
    if value is None:
        cell.setString("")
        return
    s = str(value)
    if s.startswith("="):
        cell.setFormula(s)
        return
    try:
        cell.setValue(float(s))
        return
    except ValueError:
        pass
    cell.setString(s)


def _edit_calc(desktop, payload):
    mode = payload.get("mode")

    doc = _require_calc(desktop)
    ctrl = doc.getCurrentController()
    sheet = ctrl.getActiveSheet()
    sheet_name = sheet.getName()

    if mode == "write-cells":
        rows = payload.get("rows")
        if (not isinstance(rows, list) or not rows
                or not all(isinstance(r, list) for r in rows)):
            raise RuntimeError(
                "mode 'write-cells' requires rows ([[cell, ...], ...])")
        for row in rows:
            if len(row) > 1024:
                raise RuntimeError("write-cells row longer than 1024 cells")
        if len(rows) > 2000:
            raise RuntimeError("write-cells block larger than 2000 rows")
    elif mode in ("insert-rows", "insert-cols"):
        try:
            count = int(payload.get("count") or 1)
        except (TypeError, ValueError):
            raise RuntimeError("count must be an integer")
        if not 1 <= count <= 1000:
            raise RuntimeError("count must be between 1 and 1000")

    # Anchor: explicit A1 address, else the selection's top-left cell.
    anchor = payload.get("anchor")
    sel_ranges = _calc_sel_ranges(ctrl.getSelection())
    if anchor:
        col, row = _parse_a1(anchor)
    elif sel_ranges:
        a = sel_ranges[0]
        col, row = a.StartColumn, a.StartRow
    else:
        raise RuntimeError(
            f"mode {mode!r} needs an anchor (A1) or an active selection")
    anchor_name = f"{_col_letters(col)}{row + 1}"

    tracked = bool(payload.get("tracked", True))
    was_tracking = _get_record_changes(doc)
    if tracked and was_tracking is False:
        _set_record_changes(doc, True)

    um = doc.getUndoManager()
    um.enterUndoContext("ACP edit")
    try:
        if mode == "write-cells":
            for r, row_cells in enumerate(payload.get("rows")):
                for c, value in enumerate(row_cells):
                    _set_cell(sheet.getCellByPosition(col + c, row + r), value)
        elif mode == "insert-rows":
            count = int(payload.get("count") or 1)
            sheet.getRows().insertByIndex(row, count)
        elif mode == "insert-cols":
            count = int(payload.get("count") or 1)
            sheet.getColumns().insertByIndex(col, count)
    finally:
        um.leaveUndoContext()

    if tracked and was_tracking is False:
        _set_record_changes(doc, False)

    _record_event("document-edited")
    return {"applied": True, "title": doc.getTitle(), "mode": mode,
            "sheet": sheet_name, "anchor": anchor_name}


WRITER_MODES = ("insert", "insert-top", "insert-after",
                "rewrite", "rewrite-at", "delete-at")
CALC_MODES = ("write-cells", "insert-rows", "insert-cols")
IMPRESS_MODES = ("rewrite-frame", "rewrite-slide", "insert-slide-after")


def _edit(desktop, payload):
    mode = payload.get("mode")
    if mode in WRITER_MODES:
        return _edit_writer(desktop, payload)
    if mode in CALC_MODES:
        return _edit_calc(desktop, payload)
    if mode in IMPRESS_MODES:
        return _edit_slides(desktop, payload)
    raise RuntimeError(f"unknown edit mode {mode!r}")


def _edit_writer(desktop, payload):
    mode = payload.get("mode")

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
    if _module_of(doc) in ("impress", "draw"):
        return _undo_slides(doc)
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
        elif re.match(r"^/document/s/(\d+)$", self.path):
            index = int(re.match(r"^/document/s/(\d+)$", self.path).group(1))
            out = self._main(lambda: _read_slide_lazy(_desktop(), index))
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