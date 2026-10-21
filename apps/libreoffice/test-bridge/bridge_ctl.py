"""Start or stop the spike bridge inside a socket-connected LibreOffice.

Usage:
  "C:\\Program Files\\LibreOffice\\program\\python.exe" bridge_ctl.py start|stop [host] [port]
"""

import sys

import uno


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("start", "stop"):
        raise SystemExit(__doc__)
    action = sys.argv[1]
    host = sys.argv[2] if len(sys.argv) > 2 else "localhost"
    port = sys.argv[3] if len(sys.argv) > 3 else "2002"

    local_ctx = uno.getComponentContext()
    resolver = local_ctx.ServiceManager.createInstanceWithContext(
        "com.sun.star.bridge.UnoUrlResolver", local_ctx)
    ctx = resolver.resolve(
        f"uno:socket,host={host},port={port};urp;StarOffice.ComponentContext")
    smgr = ctx.ServiceManager
    dispatcher = smgr.createInstanceWithContext(
        "com.sun.star.frame.DispatchHelper", ctx)
    desktop = smgr.createInstanceWithContext("com.sun.star.frame.Desktop", ctx)
    res = dispatcher.executeDispatch(
        desktop, f"service:org.libreofficeacp.bridge?{action}", "", 0, ())
    print(f"{action}: dispatch state = {res.State}")


main()