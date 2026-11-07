#!/usr/bin/env python3
"""check_bigprint_panel.py — run tests/bigprint-panel-test.html headlessly.

Drives the real index.html in a frame on a 300 x 300 x 600 box: Size and
Scale agree after any entry (F3), nudge limits shown and enforced (F4), the
manifest lists each part's finished W x D x H in STL and 3MF (F6), the peg note
follows Connectors (F9), and the connector/ID plan shows before export (F10).

Run:  uv run --no-project python tools/check_bigprint_panel.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/bigprint-panel-test.html"), 900,
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title == "PASS" and not result.errors:
        print("big print panel check ok — all tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: big print panel test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
