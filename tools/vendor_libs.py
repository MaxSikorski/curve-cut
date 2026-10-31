#!/usr/bin/env python3
"""Vendor all third-party libraries into vendor/ so the site works fully offline.

Run:  uv run --no-project python tools/vendor_libs.py

Downloads pinned versions (reproducible) of:
  - Three.js r147 classic build + OrbitControls / STLLoader / STLExporter
    (r147 is the LAST Three.js release with non-module `examples/js` builds,
     which is what lets index.html work by double-click on file://)
  - GSAP 3.12.5 (UMD)
  - Inter font, latin subset, weights 300-700 (fontsource woff2)
  - fflate 0.8.2 (UMD) — incremental zip for Big Print batch export

Exit 0 on success, 1 on any failure. Safe to re-run (overwrites).
"""

import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor"

THREE = "0.147.0"
FILES = {
    f"https://unpkg.com/three@{THREE}/build/three.min.js": "three/three.min.js",
    f"https://unpkg.com/three@{THREE}/examples/js/controls/OrbitControls.js": "three/OrbitControls.js",
    f"https://unpkg.com/three@{THREE}/examples/js/loaders/STLLoader.js": "three/STLLoader.js",
    f"https://unpkg.com/three@{THREE}/examples/js/loaders/OBJLoader.js": "three/OBJLoader.js",
    f"https://unpkg.com/three@{THREE}/examples/js/loaders/3MFLoader.js": "three/3MFLoader.js",
    f"https://unpkg.com/three@{THREE}/examples/js/exporters/STLExporter.js": "three/STLExporter.js",
    "https://unpkg.com/gsap@3.12.5/dist/gsap.min.js": "gsap/gsap.min.js",
    "https://unpkg.com/fflate@0.8.2/umd/index.js": "fflate/fflate.min.js",
}
for weight in (300, 400, 500, 600, 700):
    FILES[
        f"https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.18/files/inter-latin-{weight}-normal.woff2"
    ] = f"fonts/inter-latin-{weight}-normal.woff2"


def fetch(url: str, dest: Path) -> bool:
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "curve-cut-vendor"})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        if len(data) < 1000:
            print(f"FAIL {url} -> suspiciously small ({len(data)} bytes)")
            return False
        dest.write_bytes(data)
        print(f"ok   {dest.relative_to(ROOT)}  ({len(data):,} bytes)")
        return True
    except Exception as e:  # noqa: BLE001
        print(f"FAIL {url}: {e}")
        return False


def main() -> int:
    failures = sum(not fetch(url, VENDOR / rel) for url, rel in FILES.items())
    if failures:
        print(f"\n{failures} download(s) failed.")
        return 1
    print(f"\nAll {len(FILES)} files vendored into {VENDOR.relative_to(ROOT)}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
