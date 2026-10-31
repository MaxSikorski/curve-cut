#!/usr/bin/env python3
"""check_formats.py — run tests/formats-test.html headlessly and report PASS/FAIL.

Covers v1.6: OBJ import through the vendored OBJLoader, 3MF export round-trip
through the vendored 3MFLoader (volume + Z-up frame + size advantage), and the
basic repair ladder (hairline seams weld shut, real holes fail honestly).

Needs a Chromium-family browser. If none is installed, prints SKIPPED loudly
and exits 0 (an absent browser is an environment gap, not a product failure).

Run:  uv run --no-project python tools/check_formats.py
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/formats-test.html"

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
        print("         Install Brave/Chrome or verify manually in tests/formats-test.html.")
        return 0

    try:
        out = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--virtual-time-budget=30000", "--timeout=90000", "--dump-dom", TEST_URL],
            capture_output=True, text=True, timeout=150,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the formats test")
        return 1

    title = re.search(r"<title>(.*?)</title>", out, re.S)
    title = title.group(1).strip() if title else "(no title)"
    body = re.search(r"<pre id=\"log\">(.*?)</pre>", out, re.S)
    if body:
        print(body.group(1).strip())

    if title == "PASS":
        print("formats check ok — OBJ import, 3MF round-trip, repair ladder all pass")
        return 0
    print(f"FAIL: formats test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
