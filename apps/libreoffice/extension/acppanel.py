"""ACP Assist sidebar panel (spike) — status/launcher surface in LibreOffice.

A thin WantsAWT sidebar deck (AGENTS.md decision 1): connection status
(bridge / companion) plus buttons to open the companion, restart the
bridge, and refresh. The chat itself stays in the companion panel.

Wiring (verified against LO core source + live probes 12j):
- Factories.xcu registers this factory implementation
  ("org.libreofficeacp.PanelFactory") under
  org.openoffice.Office.UI.Factories/Registered/UIElementFactories
  (Type=toolpanel, Name=ACPPanelFactory).
- Sidebar.xcu registers the ACPDeck deck and the ACPStatusPanel panel
  with ImplementationURL
  private:resource/toolpanel/ACPPanelFactory/ACPStatusPanel and
  WantsAWT=true; the sidebar framework then calls our createUIElement
  with Frame/ParentWindow/Sidebar args (sfx2 Panel.cxx +
  framework uielementfactorymanager.cxx).
- The panel's real interface must provide XUIElement.getRealInterface,
  XToolPanel.getWindow/createAccessible and
  XSidebarPanel.getHeightForWidth/getMinimalWidth.

UI-thread rules: button clicks arrive on the main thread (VCL); the
status reads run HTTP with timeouts, so they happen on a worker thread
and the label updates marshal back via com.sun.star.awt.AsyncCallback
(same pattern as the bridge's MainThreadCall).
"""

import ctypes
import json
import os
import sys
import threading
import traceback
import urllib.error
import urllib.request

import uno
import unohelper

from com.sun.star.awt import Rectangle, WindowDescriptor
from com.sun.star.awt.WindowAttribute import SHOW
from com.sun.star.awt.WindowClass import SIMPLE
from com.sun.star.awt import XActionListener, XCallback
from com.sun.star.beans import PropertyValue
from com.sun.star.lang import XComponent
from com.sun.star.ui import LayoutSize
from com.sun.star.ui import XSidebarPanel, XToolPanel, XUIElement, XUIElementFactory

APP_NAME = "LibreOffice ACP Assist"
HTTP_TIMEOUT_S = 1.5


def _context():
    try:
        return XSCRIPTCONTEXT.getComponentContext()
    except NameError:
        return uno.getComponentContext()


def _assist_dir():
    """The per-user app directory that also contains bridges/."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library",
                            "Application Support")
    else:
        base = os.environ.get("XDG_CONFIG_HOME", os.path.expanduser("~/.config"))
    return os.path.join(base, APP_NAME)


def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if handle:
                kernel32.CloseHandle(handle)
                return True
            return False
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _get_json(url, token, timeout=HTTP_TIMEOUT_S):
    req = urllib.request.Request(url)
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _collect_status():
    """Worker-thread status snapshot: bridge + companion."""
    out = {"bridge": "Bridge: stopped", "companion": "Companion: not detected"}
    # Bridge: newest live discovery record.
    bridges_dir = os.path.join(_assist_dir(), "bridges")
    newest = None
    for name in os.listdir(bridges_dir) if os.path.isdir(bridges_dir) else []:
        rec = _read_json(os.path.join(bridges_dir, name))
        if (rec and isinstance(rec.get("port"), int)
                and _pid_alive(rec.get("pid"))):
            if newest is None or str(rec.get("startedAt", "")) > str(newest.get("startedAt", "")):
                newest = rec
    if newest is not None:
        try:
            st = _get_json(f"http://127.0.0.1:{newest['port']}/status",
                           newest.get("token"))
            if st.get("active"):
                out["bridge"] = (f"Bridge: running on port {newest['port']} "
                                 f"({st.get('module', '?')} document)")
            else:
                out["bridge"] = f"Bridge: running on port {newest['port']}"
        except Exception:
            out["bridge"] = f"Bridge: record on port {newest['port']}, not responding"
    # Companion: its discovery record (written by the companion app).
    comp = _read_json(os.path.join(_assist_dir(), "companion.json"))
    if comp and _pid_alive(comp.get("pid")) and comp.get("port"):
        try:
            _get_json(f"http://127.0.0.1:{comp['port']}/api/status", None)
            out["companion"] = f"Companion: connected ({comp.get('url', '?')})"
        except Exception:
            out["companion"] = "Companion: running, not responding"
    return out


class _UiUpdate(unohelper.Base, XCallback):
    """Marshal a UI update onto the main thread (AsyncCallback)."""

    def __init__(self, fn):
        self.fn = fn

    def notify(self, data):
        try:
            self.fn()
        except Exception:
            traceback.print_exc()


class PanelAction(unohelper.Base, XActionListener):
    def __init__(self, panel, name):
        self.panel = panel
        self.name = name

    def actionPerformed(self, event):
        try:
            self.panel.on_action(self.name)
        except Exception:
            traceback.print_exc()

    def disposing(self, source):
        pass


class AcpPanel(unohelper.Base, XUIElement, XToolPanel, XSidebarPanel, XComponent):
    """The status panel itself: the framework-owned parent window
    populated with fixed-text status lines and three buttons."""

    def __init__(self, ctx, frame, parent, sidebar):
        self.ctx = ctx
        self.frame = frame
        self.parent = parent
        self.sidebar = sidebar
        self._disposed = False
        self._children = []
        smgr = ctx.ServiceManager
        self._tk = smgr.createInstanceWithContext("com.sun.star.awt.Toolkit", ctx)
        self._dispatcher = smgr.createInstanceWithContext(
            "com.sun.star.frame.DispatchHelper", ctx)

        def make(service, x, y, w, h):
            desc = WindowDescriptor()
            desc.Type = SIMPLE
            desc.Parent = parent
            desc.WindowServiceName = service
            desc.Bounds = Rectangle(x, y, w, h)
            desc.WindowAttributes = SHOW
            win = self._tk.createWindow(desc)
            self._children.append(win)
            return win

        self.lbl_bridge = make("fixedtext", 8, 8, 244, 18)
        self.lbl_bridge.setText("Bridge: checking…")
        self.lbl_companion = make("fixedtext", 8, 30, 244, 18)
        self.lbl_companion.setText("Companion: checking…")

        # 30px-tall buttons: 24px clips the label with the default UI
        # font (live UI feedback 2026-10-21).
        buttons = (
            ("Refresh status", 56, "refresh"),
            ("Restart bridge", 90, "restart"),
            ("Open companion", 124, "open"),
        )
        for label, y, name in buttons:
            # WindowServiceName "pushbutton", NOT "button": the raw VCL
            # toolkit returns None for "button" in LO 26.8 (probe 12k).
            b = make("pushbutton", 8, y, 244, 30)
            b.setLabel(label)
            b.addActionListener(PanelAction(self, name))

        self.refresh_async()

    # ---- XUIElement
    def getRealInterface(self):
        return self

    # ---- XToolPanel
    def getWindow(self):
        return self.parent

    # pyuno::Adapter dispatches interface ATTRIBUTE access (tp.Window from
    # python) via getattr on the python object, NOT via the getter method;
    # expose the readonly attribute as a python property so both paths work
    # (probe 12kb).
    @property
    def Window(self):
        return self.parent

    def createAccessible(self, parent_accessible):
        return parent_accessible

    # ---- XSidebarPanel
    def getHeightForWidth(self, width):
        # LayoutSize struct, NOT a bare long (probe 12kb): preferred
        # height matches the widget layout (buttons end at y=154).
        return LayoutSize(162, 162, 162)

    def getMinimalWidth(self):
        return 260

    # ---- XComponent
    def dispose(self):
        if self._disposed:
            return
        self._disposed = True
        for win in self._children:
            try:
                win.dispose()
            except Exception:
                pass
        self._children = []

    def addEventListener(self, listener):
        pass

    def removeEventListener(self, listener):
        pass

    # ---- actions (main thread)
    def on_action(self, name):
        if self._disposed:
            return
        if name == "refresh":
            self.refresh_async()
        elif name == "restart":
            frame = self.frame
            if frame is not None:
                self._dispatcher.executeDispatch(
                    frame, "service:org.libreofficeacp.bridge?stop", "", 0, ())
                self._dispatcher.executeDispatch(
                    frame, "service:org.libreofficeacp.bridge?start", "", 0, ())
            self.lbl_bridge.setText("Bridge: restarted —")
            self.refresh_async()
        elif name == "open":
            self._open_companion()

    def _open_companion(self):
        comp = _read_json(os.path.join(_assist_dir(), "companion.json"))
        target = None
        if comp and _pid_alive(comp.get("pid")):
            if comp.get("exe") and os.path.exists(comp["exe"]):
                target = comp["exe"]
            elif comp.get("url"):
                target = comp["url"]  # dev mode: open the panel in a browser
        if target is None:
            self.lbl_companion.setText("Companion: not detected")
            return
        try:
            executor = self.ctx.ServiceManager.createInstanceWithContext(
                "com.sun.star.system.SystemShellExecute", self.ctx)
            executor.execute(target, "", 0)
            self.lbl_companion.setText("Companion: launch requested")
        except Exception:
            self.lbl_companion.setText("Companion: launch failed")

    # ---- status refresh (worker thread; UI update via AsyncCallback)
    def refresh_async(self):
        def work():
            try:
                status = _collect_status()
            except Exception:
                status = {"bridge": "Bridge: ? (status read failed)",
                           "companion": "Companion: ?"}
            def apply():
                if self._disposed:
                    return
                self.lbl_bridge.setText(status["bridge"])
                self.lbl_companion.setText(status["companion"])
            try:
                cb = self.ctx.ServiceManager.createInstanceWithContext(
                    "com.sun.star.awt.AsyncCallback", self.ctx)
                cb.addCallback(_UiUpdate(apply), None)
            except Exception:
                traceback.print_exc()

        threading.Thread(target=work, daemon=True,
                         name="acp-panel-status").start()


class AcpPanelFactory(unohelper.Base, XUIElementFactory):
    """Created by the UIElementFactoryManager when the ACP deck opens
    (implementation name org.libreofficeacp.PanelFactory)."""

    def __init__(self, ctx):
        self.ctx = ctx

    def createUIElement(self, resource_url, args):
        frame = None
        parent = None
        sidebar = None
        for a in args:
            if a.Name == "Frame":
                frame = a.Value
            elif a.Name == "ParentWindow":
                parent = a.Value
            elif a.Name == "Sidebar":
                sidebar = a.Value
        if parent is None:
            raise RuntimeError(
                "ACP panel factory: no ParentWindow in createUIElement args")
        return AcpPanel(self.ctx, frame, parent, sidebar)


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(
    AcpPanelFactory,
    "org.libreofficeacp.PanelFactory",
    ("com.sun.star.ui.ToolPanelFactory",),
)