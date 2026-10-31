#!/usr/bin/env python3
"""check_units.py — run tests/units-test.html headlessly and report PASS/FAIL.

Run:  uv run --no-project python tools/check_units.py
"""

import html
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/units-test.html"

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
        result = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--virtual-time-budget=10000", "--timeout=30000", "--dump-dom", TEST_URL],
            capture_output=True, text=True, timeout=90,
        )
        out = result.stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the units test")
        return 1

    if result.returncode and not out:
        print(f"FAIL: headless browser exited with code {result.returncode} before producing DOM")
        return 1

    title = re.search(r"<title>(.*?)</title>", out, re.S)
    title = html.unescape(title.group(1).strip()) if title else "(no title)"
    body = re.search(r'<pre id="log">(.*?)</pre>', out, re.S)
    if body:
        print(html.unescape(body.group(1).strip()))

    if title == "PASS":
        print("units check ok — all headless tests passed")
        return 0
    print(f"FAIL: units test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
