#!/usr/bin/env python3
"""check_cut_engine.py — run tests/cut-test.html headlessly and report PASS/FAIL.

The test exercises the real production code path over file:// (vendored
Three.js + base64-embedded Manifold WASM + js/cut-core.js): welding, boolean
splits, volume conservation, iterative cuts, non-watertight rejection.

Needs a Chromium-family browser for headless WebAssembly. If none is
installed, prints SKIPPED loudly and exits 0 (an absent browser is an
environment gap, not a product failure — but never silently).

Run:  uv run --no-project python tools/check_cut_engine.py
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/cut-test.html"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def main() -> int:
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless WASM testing.")
        print("         Install Brave/Chrome or verify manually in tests/cut-test.html.")
        return 0

    try:
        out = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             "--virtual-time-budget=20000", "--timeout=60000", "--dump-dom", TEST_URL],
            capture_output=True, text=True, timeout=120,
        ).stdout
    except subprocess.TimeoutExpired:
        print("FAIL: headless browser timed out running the cut-engine test")
        return 1

    title = re.search(r"<title>(.*?)</title>", out, re.S)
    title = title.group(1).strip() if title else "(no title)"
    body = re.search(r"<pre id=\"log\">(.*?)</pre>", out, re.S)
    if body:
        print(body.group(1).strip())

    if title == "PASS":
        print("cut engine check ok — all headless geometry tests passed")
        return 0
    print(f"FAIL: cut engine test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
