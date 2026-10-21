"""Probe 12j (b): find the actual sidebar config node layout."""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
provider = smgr.createInstanceWithContext(
    "com.sun.star.configuration.ConfigurationProvider", ctx)
from com.sun.star.beans import PropertyValue


def open_node(path):
    p = PropertyValue()
    p.Name = "nodepath"
    p.Value = path
    return provider.createInstanceWithArguments(
        "com.sun.star.configuration.ConfigurationAccess", (p,))


root = open_node("org.openoffice.Office.UI.Sidebar")
print("children of Sidebar:", root.getElementNames())

content = root.getByName("Content")
for list_name, examples in (("DeckList", ("FindDeck", "ShapesDeck")),
                            ("PanelList", ("EmptyPanel", "GalleryPanel"))):
    lst = content.getByName(list_name)
    for ex in examples:
        node = lst.getByName(ex)
        props = {pr.Name: node.getPropertyValue(pr.Name) for pr in node.getProperties()}
        print(f"\n{list_name}/{ex}:")
        for k, v in props.items():
            print(f"  {k} = {v!r}")