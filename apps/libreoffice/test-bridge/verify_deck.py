"""Verify the live Impress deck after the agent run (and after undo)."""

import sys

import uno

local_ctx = uno.getComponentContext()
resolver = local_ctx.ServiceManager.createInstanceWithContext(
    "com.sun.star.bridge.UnoUrlResolver", local_ctx)
ctx = resolver.resolve("uno:socket,host=localhost,port=2002;urp;StarOffice.ComponentContext")
smgr = ctx.ServiceManager
desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)

doc = desktop.getCurrentComponent()
pages = doc.getDrawPages()
print(f"slide count: {pages.getCount()}")
for i in range(pages.getCount()):
    p = pages.getByIndex(i)
    shapes = []
    for j in range(p.getCount()):
        s = p.getByIndex(j)
        shapes.append(f"{s.getShapeType().rsplit('.', 1)[-1]}: {s.getText().getString()!r}")
    print(f"slide {i + 1}: {shapes}")

if len(sys.argv) > 1 and sys.argv[1] == "expect-after":
    ok = True
    deck = []
    for i in range(pages.getCount()):
        p = pages.getByIndex(i)
        deck.append([(p.getByIndex(j).getShapeType(), p.getByIndex(j).getText().getString())
                     for j in range(p.getCount())])
    checks = [
        ("4 slides", pages.getCount() == 4),
        ("s3 is the new Conclusions slide", "Conclusions" in [t for _, t in deck[2]]),
        ("s3 has an outliner with 2 paragraphs",
         any(t.endswith("OutlinerShape") and "\n" in v for t, v in deck[2])
         and sum(v.count("\n") for t, v in deck[2] if t.endswith("OutlinerShape")) == 1),
        ("s1 title reworded informally",
         "Quarterly" not in deck[0][0][1] and deck[0][0][1].strip() != ""),
        ("s1 body untouched", deck[0][1][1] ==
         "Revenue increased 12% year over year\nOperating costs remained flat"),
        ("s2 and s4 keep their content",
         "Agenda" in [t for _, t in deck[1]] and "Market Overview" in [t for _, t in deck[3]]),
    ]
    for name, passed in checks:
        print(f"  [{'PASS' if passed else 'FAIL'}] {name}")
        ok = ok and passed
    sys.exit(0 if ok else 1)
