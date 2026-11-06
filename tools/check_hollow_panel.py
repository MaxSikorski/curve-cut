#!/usr/bin/env python3
"""check_hollow_panel.py — run tests/hollow-panel-test.html headlessly (lamp 1b).

Drives the real index.html in a frame: the Hollow button and panel, the Lamp
preset, the real worker preview, "Out of date", Confirm as one undo step, the
chip note, the units lock, the already-hollow and multi-piece gates, the
grid-too-large message, Escape cancelling a running hollow, and the saved
last settings (including bad or blocked storage).

Run:  uv run --no-project python tools/check_hollow_panel.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/hollow-panel-test.html"), 420,
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title == "PASS" and not result.errors:
        print("hollow panel check ok — all tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: hollow panel test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
