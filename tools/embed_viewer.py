#!/usr/bin/env python3
"""Embed the 3D assembly viewer source (the text that goes into assembly.html).

Every Big Print zip carries one self-contained assembly.html. Its text needs
three.js, OrbitControls, fflate and the viewer's own two scripts as plain
strings. This generator reads those files (it never writes or changes any of
them, vendor/ included) and writes js/assembly-viewer-src.js, which defines
window.CurveCutAssemblyViewerSource = { three, orbit, fflate, core, viewer,
licences }. The app loads that file lazily, only when someone exports.

    uv run --no-project python tools/embed_viewer.py
    uv run --no-project python tools/embed_viewer.py --check

The default command rewrites the checked-in generated script. ``--check``
reports the generated path and exits 1 when it is stale.
"""

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "js" / "assembly-viewer-src.js"
SOURCES = (
    ("three", ROOT / "vendor" / "three" / "three.min.js"),
    ("orbit", ROOT / "vendor" / "three" / "OrbitControls.js"),
    ("fflate", ROOT / "vendor" / "fflate" / "fflate.min.js"),
    ("core", ROOT / "js" / "assembly-core.js"),
    ("viewer", ROOT / "js" / "assembly-viewer.js"),
)
LICENCES = (
    ("three.js r147 — MIT", ROOT / "vendor" / "three" / "LICENSE"),
    ("fflate 0.8.2 — MIT", ROOT / "vendor" / "fflate" / "LICENSE"),
)
CURVE_CUT_NOTICE = ("curve cut — Copyright Max Sikorski — AGPL-3.0-only — "
                    "source: github.com/MaxSikorski/curve-cut")
CHUNK_SIZE = 64000
BAD_TOKENS = ("</script", "<script", "<!--")

HEADER = """/* GENERATED FILE — do not edit.
   Source assembly: tools/embed_viewer.py
   Re-run after editing vendor/three/three.min.js, vendor/three/OrbitControls.js,
   vendor/fflate/fflate.min.js, js/assembly-core.js, js/assembly-viewer.js,
   vendor/three/LICENSE, or vendor/fflate/LICENSE.
   Loaded lazily by AssemblyViewer.loadSource() — only when someone exports. */
"""


def read_source(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(path)
    return path.read_bytes().decode("utf-8")


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def literal(text: str) -> str:
    chunks = [text[i:i + CHUNK_SIZE] for i in range(0, len(text), CHUNK_SIZE)] or [""]
    return " +\n".join("        " + json.dumps(c, ensure_ascii=True) for c in chunks)


def build() -> str:
    """Return the generated file text, or raise ValueError for an unsafe source."""
    values = {}
    for key, path in SOURCES:
        text = read_source(path)
        lowered = text.lower()
        for token in BAD_TOKENS:
            if token in lowered:
                raise ValueError(f"{relative(path)} contains {token}; it cannot be inlined")
        values[key] = text

    blocks = []
    for heading, path in LICENCES:
        text = read_source(path)
        lowered = text.lower()
        for token in BAD_TOKENS + ("-->",):
            if token in lowered:
                raise ValueError(f"{relative(path)} contains {token}; it cannot be inlined")
        blocks.append(f"{heading}\n\n{text.strip()}\n")
    blocks.append(CURVE_CUT_NOTICE + "\n")
    values["licences"] = "\n".join(blocks)

    keys = [key for key, _ in SOURCES] + ["licences"]
    body = ",\n".join(f"    {key}:\n{literal(values[key])}" for key in keys)
    return HEADER + "window.CurveCutAssemblyViewerSource = {\n" + body + ",\n};\n"


def main() -> int:
    args = sys.argv[1:]
    if args not in ([], ["--check"]):
        print("usage: uv run --no-project python tools/embed_viewer.py [--check]")
        return 2
    try:
        generated = build()
    except ValueError as error:
        print(f"FAIL: {error}")
        return 1
    except (FileNotFoundError, OSError) as error:
        print(f"FAIL: cannot assemble viewer source: {error}")
        return 1

    existing = DST.read_bytes().decode("utf-8") if DST.exists() else None
    if args == ["--check"]:
        if existing != generated:
            print(f"WARNING: generated viewer source mismatch: {relative(DST)}")
            return 1
        print(f"viewer source check ok: {relative(DST)}")
        return 0

    if existing is not None and existing != generated:
        print(f"WARNING: replacing stale generated viewer source: {relative(DST)}")
    DST.write_bytes(generated.encode("utf-8"))
    print(f"ok   {relative(DST)}: {len(generated):,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
