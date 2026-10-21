"""Probe 12k(b): queryInterface on a socket-returned pyuno proxy, and
does our panel respond to XToolPanel/XSidebarPanel queries?"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
from com.sun.star.beans import PropertyValue
from com.sun.star.awt import WindowDescriptor, Rectangle
from com.sun.star.awt.WindowClass import TOP
from com.sun.star.ui import XToolPanel, XSidebarPanel, XUIElement

tk = smgr.createInstanceWithContext("com.sun.star.awt.Toolkit", ctx)
wd = WindowDescriptor()
wd.Type = TOP
wd.WindowServiceName = "window"
wd.Bounds = Rectangle(0, 0, 260, 140)
wd.WindowAttributes = 0
parent = tk.createWindow(wd)

pv = PropertyValue(); pv.Name = "ParentWindow"; pv.Value = parent
factory_obj = smgr.createInstanceWithContext("org.libreofficeacp.PanelFactory", ctx)
element = factory_obj.createUIElement(
    "private:resource/toolpanel/ACPPanelFactory/ACPStatusPanel", (pv,))
print("element:", element is not None)

real = element.getRealInterface()
print("real:", real is not None)

# Pattern 1: queryInterface with an explicit uno.Type via getTypeByName
# (the imported interface class is NOT a UNO type — probe 12kb).
import uno as _uno
XTP_TYPE = _uno.getTypeByName("com.sun.star.ui.XToolPanel")
XSP_TYPE = _uno.getTypeByName("com.sun.star.ui.XSidebarPanel")
tp = real.queryInterface(XTP_TYPE)
print("queryInterface(XToolPanel) ->", tp is not None)
if tp is not None:
    print("  Window == parent:", tp.Window == parent)
sp = real.queryInterface(XSP_TYPE)
print("queryInterface(XSidebarPanel) ->", sp is not None)
if sp is not None:
    print("  getMinimalWidth:", sp.getMinimalWidth(), "getHeightForWidth(260):", sp.getHeightForWidth(260))

real.dispose()
parent.dispose()
print("done")