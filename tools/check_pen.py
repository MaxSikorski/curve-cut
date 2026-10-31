#!/usr/bin/env python3
"""check_pen.py — run tests/pen-test.html headlessly (v1.1 pen-tool math).

Covers: Catmull-Rom auto-smooth handles (no kinks on plain clicks), corner and
custom flags, shape-preserving point insertion (de Casteljau), rigid spline
translation, and segment-distance hit math.

SKIPs loudly (exit 0) if no Chromium-family browser is installed.

Run:  uv run --no-project python tools/check_pen.py
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/pen-test.html"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def main() -> int:
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless testing.")
        return 0

    try:
        out = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--virtual-time-budget=10000", "--timeout=30000", "--dump-dom", TEST_URL],
            capture_output=True, text=True, timeout=90,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the pen test")
        return 1

    title = re.search(r"<title>(.*?)</title>", out, re.S)
    title = title.group(1).strip() if title else "(no title)"
    body = re.search(r"<pre id=\"log\">(.*?)</pre>", out, re.S)
    if body:
        print(body.group(1).strip())

    if title == "PASS":
        print("pen math check ok — all headless tests passed")
        return 0
    print(f"FAIL: pen test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
