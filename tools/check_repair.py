#!/usr/bin/env python3
"""check_repair.py — run tests/repair-test.html headlessly.

Covers boundary-loop detection, convex and non-convex caps, cavity
preservation, weld-vs-cap precedence, and the optional Jesus hollow fixture.

SKIPS loudly (exit 0) if no Chromium-family browser is installed. The local
Jesus fixture may also be skipped by the page without failing the suite.

Run: uv run --no-project python tools/check_repair.py
"""

import html
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/repair-test.html"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def main() -> int:
    browser = next((candidate for candidate in BROWSERS if Path(candidate).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless repair tests.")
        return 0

    try:
        output = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--allow-file-access-from-files",
             "--virtual-time-budget=300000", "--timeout=360000", "--dump-dom", TEST_URL],
            capture_output=True,
            text=True,
            timeout=390,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the repair test")
        return 1

    title_match = re.search(r"<title>(.*?)</title>", output, re.S)
    title = html.unescape(title_match.group(1).strip()) if title_match else "(no title)"
    body_match = re.search(r'<pre id="log">(.*?)</pre>', output, re.S)
    body = html.unescape(body_match.group(1)).strip() if body_match else ""
    if body:
        print(body)

    if title == "PASS":
        skipped = "SKIP:" in body
        suffix = "; Jesus fixture skipped" if skipped else ""
        print(f"repair check ok — all headless repair tests passed{suffix}")
        return 0
    print(f"FAIL: repair test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
