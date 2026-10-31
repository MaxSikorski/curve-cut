#!/usr/bin/env python3
"""check_units.py — run tests/units-test.html headlessly and report PASS/FAIL.

Runs in real time through tools/browser.py (Playwright's headless Chromium).

Run:  uv run --no-project python tools/check_units.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 60


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/units-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        print("units check ok — all headless tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: units test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
