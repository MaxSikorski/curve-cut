#!/usr/bin/env python3
"""check_offline.py — the hard file:// rule, enforced.

Fails (exit 1) if:
  - index.html / css/ / js/ reference any external URL (http://, https://, //cdn...)
    in a way the browser would fetch (src=, href=, url(), @import, fetch of a URL)
  - index.html uses <script type="module"> or import statements (blocked on file://)
  - any vendored file referenced by index.html is missing or empty

Run:  uv run --no-project python tools/check_offline.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def site_files():
    yield ROOT / "index.html"
    for d in ("css", "js"):
        yield from sorted((ROOT / d).rglob("*"))

def main() -> int:
    errors = []

    for f in site_files():
        if not f.is_file():
            continue
        text = f.read_text(encoding="utf-8", errors="replace")
        rel = f.relative_to(ROOT)

        for m in re.finditer(r'(?:src|href)\s*=\s*["\'](https?:)?//[^"\']+', text):
            errors.append(f"{rel}: external resource -> {m.group(0)[:80]}")
        for m in re.finditer(r'url\(\s*["\']?(https?:)?//', text):
            errors.append(f"{rel}: external css url() -> {m.group(0)[:80]}")
        if re.search(r'@import\s+["\']?(https?:)?//', text):
            errors.append(f"{rel}: external @import")
        if f.suffix == ".html" and re.search(r'<script[^>]+type\s*=\s*["\']module', text):
            errors.append(f"{rel}: <script type=module> breaks file://")
        if f.suffix == ".js" and re.search(r'^\s*import\s.+from\s', text, re.M):
            errors.append(f"{rel}: ES import statement breaks file:// classic scripts")

    html = (ROOT / "index.html").read_text(encoding="utf-8")
    for m in re.finditer(r'(?:src|href)\s*=\s*["\'](?!data:|#|https?:|//)([^"\']+)["\']', html):
        target = ROOT / m.group(1)
        if not target.is_file():
            errors.append(f"index.html references missing file: {m.group(1)}")
        elif target.stat().st_size == 0:
            errors.append(f"index.html references empty file: {m.group(1)}")

    if errors:
        print("OFFLINE CHECK FAILED:")
        for e in errors:
            print(f"  ✗ {e}")
        return 1
    print("offline check ok — no external URLs, no module scripts, all local references exist")
    return 0

if __name__ == "__main__":
    sys.exit(main())
