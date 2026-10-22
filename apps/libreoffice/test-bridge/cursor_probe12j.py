"""Probe 12j: what does a LibreOffice sidebar deck/panel require?

1. Dump org.openoffice.Office.UI.Sidebar config (decks + panels + their
   registration properties).
2. Introspect com.sun.star.ui.XSidebarPanel / XUIElement / XToolPanel
   method signatures via CoreReflection (works offline).
3. Check whether pyuno can queryInterface a class registered with
   interface names in the services tuple (component pattern feasibility).
"""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager


def dump_node(node, indent=0):
    pad = "  " * indent
    name = node.getName() if hasattr(node, "getName") else "?"
    print(f"{pad}NODE {name}")
    try:
        for prop in node.getProperties():
            try:
                val = node.getPropertyValue(prop.Name)
            except Exception as e:
                val = f"<{e}>"
            print(f"{pad}  .{prop.Name} = {val!r}")
    except Exception:
        pass
    try:
        for child_name in node.getElementNames():
            child = node.getByName(child_name)
            print(f"{pad}  [{child_name}]")
            if child is not None:
                dump_node(child, indent + 2)
    except Exception:
        pass


print("=== Sidebar configuration ===")
provider = smgr.createInstanceWithContext(
    "com.sun.star.configuration.ConfigurationProvider", ctx)
from com.sun.star.beans import PropertyValue
for path in ("org.openoffice.Office.UI.Sidebar/Content/Decks",
             "org.openoffice.Office.UI.Sidebar/Content/Panels"):
    p = PropertyValue()
    p.Name = "nodepath"
    p.Value = path
    try:
        node = provider.createInstanceWithArguments(
            "com.sun.star.configuration.ConfigurationAccess", (p,))
        print(f"\n--- {path} ---")
        dump_node(node)
    except Exception as e:
        print(f"{path}: FAILED {e}")

print("\n=== Interface introspection (CoreReflection) ===")
core = smgr.createInstanceWithContext("com.sun.star.reflection.CoreReflection", ctx)
for type_name in ("com.sun.star.ui.XSidebarPanel",
                  "com.sun.star.ui.XUIElement",
                  "com.sun.star.ui.XToolPanel",
                  "com.sun.star.ui.XSidebar",
                  "com.sun.star.ui.XUpdateListener"):
    try:
        tdesc = core.forName(type_name)
        if tdesc is None:
            print(f"{type_name}: NOT FOUND")
            continue
        print(f"\n--- {type_name} ---")
        for method in tdesc.getMethods():
            params = ", ".join(p.Name for p in method.ParameterDescriptors) if hasattr(method, "ParameterDescriptors") else "?"
            print(f"  {method.Name}({params})")
    except Exception as e:
        print(f"{type_name}: FAILED {e}")