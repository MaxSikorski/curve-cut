#!/usr/bin/env python3
"""check_perf.py — memory/perf budget for the real app (roadmap v1.2).

Opens index.html#perftest (see js/perf-hook.js): generates a
~600k-triangle model, accepts the simplify offer, applies a straight cut,
undoes and redoes, then reads the JS heap.

Real-time runner (tools/browser.py, Playwright's headless Chromium): the old
--virtual-time-budget form fast-forwarded the hook's ops-idle polling loop, so
60 s of virtual timeout elapsed before real worker ops finished (house lesson
#3, same class check_compute hit in W2).

Budgets (Max, 2026-07-13):
  - JS heap after the full heavy workflow: <= 250 MB
  - whole scripted workflow completes: <= 90 s headless

SKIPs loudly (exit 0) if that browser is not installed.

Run:  uv run --no-project python tools/check_perf.py
"""

import re
import sys

from browser import GPU_ARGS, ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 180

HEAP_BUDGET_MB = 250
TOTAL_BUDGET_MS = 90_000

def main() -> int:
    ensure_playwright()
    result = run_page(
        page_url("index.html#perftest"), REAL_TIME_LIMIT_S,
        done=lambda title: title.startswith("PERF "), poll_s=3,
        args=(*GPU_ARGS, "--enable-precise-memory-info",
              "--js-flags=--expose-gc"))
    if result.skipped:
        return skip_or_fail(result.skipped)
    title = result.title

    m = re.match(r"PERF heap=([\d.]+) total=(\d+) pieces=(\d+)", title)
    if not m:
        result.print_errors()
        print(f"FAIL: perf harness did not finish — title was: {title}")
        return 1

    heap, total, pieces = float(m.group(1)), int(m.group(2)), int(m.group(3))
    print(f"measured: heap {heap:.1f} MB · workflow {total / 1000:.1f} s · {pieces} pieces")

    ok = True
    if heap > HEAP_BUDGET_MB:
        print(f"FAIL: heap {heap:.1f} MB exceeds the {HEAP_BUDGET_MB} MB budget")
        ok = False
    if total > TOTAL_BUDGET_MS:
        print(f"FAIL: workflow took {total / 1000:.1f}s, budget is {TOTAL_BUDGET_MS / 1000:.0f}s")
        ok = False
    if pieces != 2:
        print(f"FAIL: expected 2 pieces after cut+redo, got {pieces}")
        ok = False

    if ok:
        print(f"perf check ok — within the {HEAP_BUDGET_MB} MB / {TOTAL_BUDGET_MS // 1000}s budgets")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
