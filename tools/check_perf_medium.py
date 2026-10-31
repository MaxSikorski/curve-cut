#!/usr/bin/env python3
"""check_perf_medium.py — medium-model perf numbers (v2.1a perf lane).

Opens index.html#perfmed (see js/perf-medium-hook.js): a ~380k-triangle model
(below the simplify threshold — the 10-100MB STL band Max works in), watertight
check, curve cut, then 240 frames of model rotation, reporting stage timings and
frame stats in document.title.

Like check_race.py this runs a REAL-TIME headless browser (tools/browser.py,
Playwright's Chromium) — virtual time starves rAF, which would make the
frame-time numbers meaningless.

Budgets (provisional, set 2026-08-06 from the published-tag A/B; tighten after
the perf lane closes):
  - load (weld + scene) <= 10 s          - cut <= 20 s
  - frame p95 <= 250 ms (headless, GPU via Metal; relative A/B is the real signal)
  - heap <= 250 MB

SKIPs loudly (exit 0) if that browser is not installed.

Run:  uv run --no-project python tools/check_perf_medium.py
"""

import re
import sys

from browser import GPU_ARGS, ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 180

LOAD_BUDGET_MS = 10_000
CUT_BUDGET_MS = 20_000
FP95_BUDGET_MS = 250
HEAP_BUDGET_MB = 250

def main() -> int:
    ensure_playwright()
    result = run_page(
        page_url("index.html#perfmed"), REAL_TIME_LIMIT_S,
        done=lambda title: title.startswith("PERFMED"), poll_s=3,
        args=(*GPU_ARGS, "--enable-precise-memory-info",
              "--js-flags=--expose-gc"))
    if result.skipped:
        return skip_or_fail(result.skipped)
    title = result.title

    m = re.fullmatch(
        r"PERFMED load=(\d+) wt=(\d+) cut=(\d+) "
        r"favg=([\d.]+) fp95=([\d.]+) heap=([\d.-]+)", title)
    if not m:
        result.print_errors()
        print(f"FAIL: medium perf harness did not finish — title was: {title}")
        return 1

    load, wt, cut = int(m.group(1)), int(m.group(2)), int(m.group(3))
    favg, fp95, heap = float(m.group(4)), float(m.group(5)), float(m.group(6))
    print(f"measured: load {load} ms · watertight {wt} ms · cut {cut} ms"
          f" · frame avg {favg:.1f} ms / p95 {fp95:.1f} ms · heap {heap:.1f} MB")

    ok = True
    if load > LOAD_BUDGET_MS:
        print(f"FAIL: load {load} ms exceeds the {LOAD_BUDGET_MS} ms budget")
        ok = False
    if cut > CUT_BUDGET_MS:
        print(f"FAIL: cut {cut} ms exceeds the {CUT_BUDGET_MS} ms budget")
        ok = False
    if fp95 > FP95_BUDGET_MS:
        print(f"FAIL: frame p95 {fp95:.1f} ms exceeds the {FP95_BUDGET_MS} ms budget")
        ok = False
    if heap >= 0 and heap > HEAP_BUDGET_MB:  # -1 = memory API unavailable
        print(f"FAIL: heap {heap:.1f} MB exceeds the {HEAP_BUDGET_MB} MB budget")
        ok = False

    if ok:
        print("medium perf check ok — within the provisional budgets")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
