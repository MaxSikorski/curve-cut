#!/usr/bin/env python3
"""check_hollow.py — run tests/hollow-test.html headlessly.

Covers the analytic cube, hybrid selector and D2 tripwire, sampled-wall
warnings, multi-cavity preservation, cancellation cleanup, and preview estimate.

SKIPs loudly (exit 0) if no Chromium-family browser is installed.

Run: uv run --no-project python tools/check_hollow.py
"""

import html
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/hollow-test.html"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def main() -> int:
    browser = next((candidate for candidate in BROWSERS if Path(candidate).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless hollow tests.")
        return 0

    try:
        output = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--virtual-time-budget=300000", "--timeout=330000", "--dump-dom", TEST_URL],
            capture_output=True,
            text=True,
            timeout=360,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the hollow test")
        return 1

    title_match = re.search(r"<title>(.*?)</title>", output, re.S)
    title = html.unescape(title_match.group(1).strip()) if title_match else "(no title)"
    body_match = re.search(r'<pre id="log">(.*?)</pre>', output, re.S)
    if body_match:
        print(html.unescape(body_match.group(1)).strip())

    if title == "PASS":
        print("hollow engine check ok — all headless tests passed")
        return 0
    print(f"FAIL: hollow test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
