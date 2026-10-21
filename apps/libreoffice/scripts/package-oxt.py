#!/usr/bin/env python3
"""Package the bridge extension sources (extension/) into acp-bridge.oxt.

The .oxt is a plain zip with forward-slash entry names — LibreOffice's
unopkg rejects backslash entries. Output lands at the repo root as
acp-bridge.oxt (gitignored; rebuilt by CI and before packaging).

Usage: python scripts/package-oxt.py [--src extension] [--out acp-bridge.oxt]
"""

import argparse
import os
import sys
import zipfile

FILES = [
    "description.xml",
    "META-INF/manifest.xml",
    "Addons.xcu",
    "Sidebar.xcu",
    "Factories.xcu",
    "acpbridge.py",
    "acppanel.py",
    "icon.png",
]


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--src", default=os.path.join(repo, "extension"),
                    help="extension source directory (default: <repo>/extension)")
    ap.add_argument("--out", default=os.path.join(repo, "acp-bridge.oxt"),
                    help="output .oxt path (default: <repo>/acp-bridge.oxt)")
    args = ap.parse_args()

    missing = [f for f in FILES if not os.path.isfile(os.path.join(args.src, f))]
    if missing:
        print(f"error: missing files in {args.src}: {', '.join(missing)}",
              file=sys.stderr)
        return 1

    if os.path.exists(args.out):
        os.remove(args.out)
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in FILES:
            z.write(os.path.join(args.src, f), f)  # forward-slash entry name
    size = os.path.getsize(args.out)
    print(f"packaged {args.out} ({size} bytes, {len(FILES)} entries)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
