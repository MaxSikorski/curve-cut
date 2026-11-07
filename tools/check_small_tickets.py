#!/usr/bin/env python3
"""Run the Pieces zip names, pen-mode camera keys and About version tests in the real app frame.

Run: uv run --no-project python tools/check_small_tickets.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/small-tickets-test.html"), 420,
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title == "PASS" and not result.errors:
        print("small tickets check ok — all tests passed")
        return 0
    result.print_errors()
    print(f"FAIL: small tickets test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
