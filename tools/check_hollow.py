#!/usr/bin/env python3
"""check_hollow.py — run tests/hollow-test.html headlessly.

Covers the analytic cube, hybrid selector and D2 tripwire, sampled-wall
warnings, multi-cavity preservation, cancellation cleanup, and preview estimate.

Runs in real time through tools/browser.py (Playwright's headless Chromium).
SKIPs loudly (exit 0) if that browser is not installed.

Run: uv run --no-project python tools/check_hollow.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 360


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/hollow-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        print("hollow engine check ok — all headless tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: hollow test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
