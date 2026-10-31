#!/usr/bin/env python3
"""check_benchy.py — the automated Benchy acceptance test (HANDOFF §4 decision 9).

Runs tests/benchy-test.html headlessly: real 3DBenchy.stl -> wavy cut ->
iterative cut -> 3 watertight pieces, volume conserved, export round-trips.

Runs in real time through tools/browser.py (Playwright's headless Chromium).
SKIPs (exit 0, loudly) if test-assets/3DBenchy.stl is missing (it's
gitignored — CC BY-ND) or that browser is not installed.

Run:  uv run --no-project python tools/check_benchy.py
"""

import sys

from browser import ROOT, ensure_playwright, page_url, run_page, skip_or_fail

BENCHY = ROOT / "test-assets" / "3DBenchy.stl"
REAL_TIME_LIMIT_S = 300


def main() -> int:
    if not BENCHY.exists():
        print("SKIPPED: test-assets/3DBenchy.stl missing (gitignored; re-download to run).")
        return 0
    ensure_playwright()
    result = run_page(page_url("tests/benchy-test.html"), REAL_TIME_LIMIT_S,
                      # lets the test fetch() the STL over file://
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)

    if result.title == "PASS":
        print("benchy acceptance check ok")
        return 0
    result.print_errors()
    print(f"FAIL: benchy test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
