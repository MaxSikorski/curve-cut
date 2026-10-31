#!/usr/bin/env python3
"""check_formats.py — run tests/formats-test.html headlessly and report PASS/FAIL.

Covers v1.6: OBJ import through the vendored OBJLoader, 3MF export round-trip
through the vendored 3MFLoader (volume + Z-up frame + size advantage), and the
basic repair ladder (hairline seams weld shut, real holes fail honestly).

Runs in real time through tools/browser.py (Playwright's headless Chromium).
If that browser is not installed, prints SKIPPED loudly and exits 0 (an absent
browser is an environment gap, not a product failure).

Run:  uv run --no-project python tools/check_formats.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 120


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/formats-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        print("formats check ok — OBJ import, 3MF round-trip, repair ladder all pass")
        return 0
    result.print_errors()
    print(f"FAIL: formats test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
