#!/usr/bin/env python3
"""check_bigprint.py — run tests/bigprint-test.html headlessly and report PASS/FAIL.

Covers the Big Print (v2.0) core math: grid cut positions (balanced, nudged,
segment-legal), part-count estimates, B2-style part IDs, scale⇄size linking.
Grows with each Big Print build step (cut engine, connectors, engraving).

Runs in real time through tools/browser.py (Playwright's headless Chromium).
If that browser is not installed, prints SKIPPED loudly and exits 0 (an absent
browser is an environment gap, not a product failure).

Run:  uv run --no-project python tools/check_bigprint.py
"""

import sys

from browser import ROOT, ensure_playwright, page_url, run_page, skip_or_fail

BENCHY_STL = ROOT / "test-assets" / "3DBenchy.stl"
MATH_LIMIT_S = 150
BENCHY_LIMIT_S = 600


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/bigprint-test.html"), MATH_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title != "PASS":
        result.print_errors()
        print(f"FAIL: big print test result: {result.title}"
              + (" (timed out)" if result.timed_out else ""))
        return 1
    print("big print check ok — all headless grid-math tests passed")

    # Benchy acceptance: the whole engine at 6× on a tiny bed (100+ cells).
    if not BENCHY_STL.exists():
        print("SKIPPED: 3DBenchy.stl not in test-assets/ — Big Print acceptance not run.")
        return 0
    result = run_page(page_url("tests/bigprint-benchy-test.html"), BENCHY_LIMIT_S,
                      args=("--allow-file-access-from-files",))
    if result.log:
        print(result.log)
    if result.title == "SKIPPED":
        print("SKIPPED: acceptance page could not load the Benchy.")
        return 0
    if result.title != "PASS":
        result.print_errors()
        print(f"FAIL: big print Benchy acceptance: {result.title}"
              + (" (timed out)" if result.timed_out else ""))
        return 1
    print("big print acceptance ok — 6× Benchy grid-cut with connectors + IDs, all watertight")
    return 0


if __name__ == "__main__":
    sys.exit(main())
