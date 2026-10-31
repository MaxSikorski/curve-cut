#!/usr/bin/env python3
"""check_race.py — race/failure tests for the operation coordinator (v2.0.2 item 6).

Opens index.html#racetest (see js/race-hook.js): eight scenarios — model
replacement mid-cut, Start New during simplify, Escape during Big Print
export, Big Print cancel restore, save-picker blob fallback, and grid-cap
refusal, superseding a worker warm mid-flight, and warm/export abort seams —
driven through the REAL production code paths, reporting
"RACE ok=<n> fail=<m>" in document.title.

Runs in real time (tools/browser.py): virtual time starves the interactive
rAF/event interleavings these scenarios need.

Run:  uv run --no-project python tools/check_race.py
"""

import re
import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 180
EXPECTED_SCENARIOS = 10


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("index.html#racetest"), REAL_TIME_LIMIT_S,
                      done=lambda t: t.startswith("RACE"), poll_s=3)
    if result.skipped:
        return skip_or_fail(result.skipped)
    title = result.title

    m = re.fullmatch(r"RACE ok=(\d+) fail=(\d+)(?: failures=(.*))?", title)
    if not m:
        result.print_errors()
        print(f"FAIL: race harness did not finish — title was: {title}")
        return 1

    ok, fail = int(m.group(1)), int(m.group(2))
    detail = (m.group(3) or "").strip()
    print(f"measured: {ok} scenarios ok, {fail} failed"
          + (f" — {detail}" if detail else ""))
    if fail or ok < EXPECTED_SCENARIOS:
        print("FAIL: coordinator race scenarios failed (names above)")
        return 1
    print("race check ok — all 10 coordinator race scenarios pass (real-time Playwright)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
