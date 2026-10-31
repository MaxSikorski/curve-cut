#!/usr/bin/env python3
"""check_cut_engine.py — run tests/cut-test.html headlessly and report PASS/FAIL.

The test exercises the real production code path over file:// (vendored
Three.js + base64-embedded Manifold WASM + js/cut-core.js): welding, boolean
splits, volume conservation, iterative cuts, non-watertight rejection.

Runs in real time through tools/browser.py (Playwright's headless Chromium).
If that browser is not installed, prints SKIPPED loudly and exits 0 (an absent
browser is an environment gap, not a product failure — but never silently).

Run:  uv run --no-project python tools/check_cut_engine.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 90


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/cut-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        print("cut engine check ok — all headless geometry tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: cut engine test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
