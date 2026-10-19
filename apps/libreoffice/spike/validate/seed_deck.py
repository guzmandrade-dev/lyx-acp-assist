"""Seed a 3-slide Impress deck for the Phase 3 live agent regression."""

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

doc = desktop.loadComponentFromURL("private:factory/simpress", "_blank", 0, ())
doc.getCurrentController().getFrame().activate()
pages = doc.getDrawPages()
pages.getByIndex(0).getByIndex(0).getText().setString("Quarterly Financial Performance Review")
pages.getByIndex(0).getByIndex(1).getText().setString(
    "Revenue increased 12% year over year\nOperating costs remained flat")

for idx, (title, body) in enumerate([
    ("Agenda", "Market overview\nFinancial results\nOutlook"),
    ("Market Overview", "TAM grew to $4.2B\nTwo new competitors entered Q3"),
], start=1):
    pages.insertNewByIndex(idx - 1)  # lands at index idx (rule 29)
    page = pages.getByIndex(idx)
    t = doc.createInstance("com.sun.star.presentation.TitleTextShape")
    page.add(t)
    t.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 25199, 2629))
    t.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1400, 628))
    t.getText().setString(title)
    b = doc.createInstance("com.sun.star.presentation.OutlinerShape")
    page.add(b)
    b.setSize(uno.createUnoStruct("com.sun.star.awt.Size", 25199, 9134))
    b.setPosition(uno.createUnoStruct("com.sun.star.awt.Point", 1400, 3685))
    b.getText().setString(body)

print("deck seeded:")
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    texts = [p.getByIndex(j).getText().getString() for j in range(p.getCount())]
    print(f"  slide {i + 1}: {texts}")
