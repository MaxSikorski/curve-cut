#!/usr/bin/env python3
"""check_pen.py — run tests/pen-test.html headlessly (v1.1 pen-tool math).

Covers: Catmull-Rom auto-smooth handles (no kinks on plain clicks), corner and
custom flags, shape-preserving point insertion (de Casteljau), rigid spline
translation, and segment-distance hit math.

Run:  uv run --no-project python tools/check_pen.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/pen-test.html"), 30)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title == "PASS":
        print("pen math check ok — all headless tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: pen test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
