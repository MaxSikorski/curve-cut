#!/usr/bin/env python3
"""check_benchy.py — the automated Benchy acceptance test (HANDOFF §4 decision 9).

Runs tests/benchy-test.html headlessly: real 3DBenchy.stl -> wavy cut ->
iterative cut -> 3 watertight pieces, volume conserved, export round-trips.

SKIPs (exit 0, loudly) if test-assets/3DBenchy.stl is missing (it's
gitignored — CC BY-ND) or no Chromium-family browser is installed.

Run:  uv run --no-project python tools/check_benchy.py
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCHY = ROOT / "test-assets" / "3DBenchy.stl"
TEST_URL = f"file://{ROOT}/tests/benchy-test.html"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def main() -> int:
    if not BENCHY.exists():
        print("SKIPPED: test-assets/3DBenchy.stl missing (gitignored; re-download to run).")
        return 0
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless testing.")
        return 0

    try:
        out = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--allow-file-access-from-files",  # lets the test fetch() the STL over file://
             "--virtual-time-budget=120000", "--timeout=240000", "--dump-dom", TEST_URL],
            capture_output=True, text=True, timeout=300,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the Benchy test")
        return 1

    title = re.search(r"<title>(.*?)</title>", out, re.S)
    title = title.group(1).strip() if title else "(no title)"
    body = re.search(r"<pre id=\"log\">(.*?)</pre>", out, re.S)
    if body:
        print(body.group(1).strip())

    if title == "PASS":
        print("benchy acceptance check ok")
        return 0
    print(f"FAIL: benchy test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
