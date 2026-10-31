#!/usr/bin/env python3
"""check_bigprint.py — run tests/bigprint-test.html headlessly and report PASS/FAIL.

Covers the Big Print (v2.0) core math: grid cut positions (balanced, nudged,
segment-legal), part-count estimates, B2-style part IDs, scale⇄size linking.
Grows with each Big Print build step (cut engine, connectors, engraving).

Needs a Chromium-family browser. If none is installed, prints SKIPPED loudly
and exits 0 (an absent browser is an environment gap, not a product failure).

Run:  uv run --no-project python tools/check_bigprint.py
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/bigprint-test.html"
BENCHY_URL = f"file://{ROOT}/tests/bigprint-benchy-test.html"
BENCHY_STL = ROOT / "test-assets" / "3DBenchy.stl"

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def run_page(browser: str, url: str, budget_ms: int, timeout_s: int, extra_flags=()):
    try:
        out = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
             *extra_flags,
             f"--virtual-time-budget={budget_ms}", f"--timeout={budget_ms * 3}",
             "--dump-dom", url],
            capture_output=True, text=True, timeout=timeout_s,
        ).stdout
    except subprocess.TimeoutExpired:
        return "TIMEOUT", ""
    title = re.search(r"<title>(.*?)</title>", out, re.S)
    body = re.search(r"<pre id=\"log\">(.*?)</pre>", out, re.S)
    return (title.group(1).strip() if title else "(no title)",
            body.group(1).strip() if body else "")


def main() -> int:
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless testing.")
        print("         Install Brave/Chrome or verify manually in tests/bigprint-test.html.")
        return 0

    title, body = run_page(browser, TEST_URL, 30000, 150)
    if body:
        print(body)
    if title != "PASS":
        print(f"FAIL: big print test result: {title}")
        return 1
    print("big print check ok — all headless grid-math tests passed")

    # Benchy acceptance: the whole engine at 6× on a tiny bed (100+ cells).
    if not BENCHY_STL.exists():
        print("SKIPPED: 3DBenchy.stl not in test-assets/ — Big Print acceptance not run.")
        return 0
    title, body = run_page(browser, BENCHY_URL, 480000, 600,
                           extra_flags=("--allow-file-access-from-files",))
    if body:
        print(body)
    if title == "SKIPPED":
        print("SKIPPED: acceptance page could not load the Benchy.")
        return 0
    if title != "PASS":
        print(f"FAIL: big print Benchy acceptance: {title}")
        return 1
    print("big print acceptance ok — 6× Benchy grid-cut with connectors + IDs, all watertight")
    return 0


if __name__ == "__main__":
    sys.exit(main())
