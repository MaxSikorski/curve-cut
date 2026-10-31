#!/usr/bin/env python3
"""check_repair.py — run tests/repair-test.html headlessly.

Covers boundary-loop detection, convex and non-convex caps, cavity
preservation, weld-vs-cap precedence, old-vs-new weld/loop/repair equivalence,
and the optional Jesus hollow fixture.

Runs in real time through tools/browser.py (Playwright's headless Chromium).
SKIPS loudly (exit 0) if that browser is not installed. The local Jesus
fixture may also be skipped by the page without failing the suite.

Run: uv run --no-project python tools/check_repair.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 390


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/repair-test.html"), REAL_TIME_LIMIT_S,
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        suffix = "; private models skipped" if "SKIP:" in result.log else ""
        print(f"repair check ok — all headless repair tests passed{suffix}")
        return 0
    result.print_errors()
    print(f"FAIL: repair test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
