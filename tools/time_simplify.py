#!/usr/bin/env python3
"""time_simplify.py — time the worker simplifyToTarget op (a measuring tool, not a check).

Opens tests/simplify-timing.html in headless Chromium in real time, prints its
table (rounds, longest round, result size per target, the cancel probe, worker
memory) and exits 0 on DONE, 1 on FAIL. The private large test models are
timed only when present in test-assets/.

Run:  uv run --no-project python tools/time_simplify.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 600


def finished(title: str) -> bool:
    return title == "DONE" or title.startswith(("FAIL", "SKIPPED"))


def main() -> int:
    ensure_playwright()
    # The page fetches ../test-assets/*.stl over file://; that needs this flag.
    result = run_page(page_url("tests/simplify-timing.html"), REAL_TIME_LIMIT_S, done=finished,
                      args=("--allow-file-access-from-files",))
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title == "DONE":
        print("simplify timing done")
        return 0
    result.print_errors()
    print(f"FAIL: simplify timing result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
