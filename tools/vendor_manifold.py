#!/usr/bin/env python3
"""Vendor the Manifold CSG engine (WASM) for classic-script file:// use.

Run:  uv run --no-project python tools/vendor_manifold.py

manifold-3d ships as an ES module + a .wasm file fetched at runtime — both
break the double-click file:// rule. This script:
  1. downloads manifold.js + manifold.wasm (pinned 3.5.1)
  2. converts the glue to a classic script:
       - `export default Module;`  ->  `window.ManifoldModule = Module;`
       - `import.meta.url` (Node-only branch) -> inert string literal
  3. embeds the wasm binary as base64 in vendor/manifold/manifold.wasm.b64.js
     (`window.MANIFOLD_WASM_B64`), so no fetch() is ever needed.

Exit 0 on success, 1 on failure. Safe to re-run.
"""

import base64
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "vendor" / "manifold"
VERSION = "3.5.1"
BASE = f"https://unpkg.com/manifold-3d@{VERSION}"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "curve-cut-vendor"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    glue = get(f"{BASE}/manifold.js").decode("utf-8")
    if "export default Module;" not in glue:
        print("FAIL: glue layout changed — expected `export default Module;`")
        return 1
    glue = glue.replace("import.meta.url", '"file:///manifold"')
    glue = glue.replace("export default Module;", "window.ManifoldModule = Module;")
    if "import.meta" in glue or "export " in glue.split("window.ManifoldModule")[1]:
        print("FAIL: ES module syntax survived the transform")
        return 1
    header = f"/* manifold-3d {VERSION} — Apache-2.0 — converted to classic script by tools/vendor_manifold.py */\n"
    (OUT / "manifold.js").write_text(header + glue, encoding="utf-8")
    print(f"ok   vendor/manifold/manifold.js  ({len(glue):,} bytes)")

    wasm = get(f"{BASE}/manifold.wasm")
    if len(wasm) < 100_000 or wasm[:4] != b"\x00asm":
        print(f"FAIL: manifold.wasm looks wrong ({len(wasm)} bytes)")
        return 1
    b64 = base64.b64encode(wasm).decode("ascii")
    js = (
        f"/* manifold-3d {VERSION} manifold.wasm, base64-embedded for file:// use. */\n"
        f'window.MANIFOLD_WASM_B64 = "{b64}";\n'
    )
    (OUT / "manifold.wasm.b64.js").write_text(js, encoding="utf-8")
    print(f"ok   vendor/manifold/manifold.wasm.b64.js  (wasm {len(wasm):,} B -> b64 {len(b64):,} B)")

    lic = get(f"{BASE}/LICENSE")
    (OUT / "LICENSE").write_bytes(lic)
    print("ok   vendor/manifold/LICENSE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
