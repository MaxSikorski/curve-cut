#!/usr/bin/env python3
"""check_perf_real.py — real-model performance acceptance instrument (v2.1p).

Opens index.html#perfreal (see js/perf-real-hook.js) in real-time headless
Chromium (tools/browser.py, Playwright) and drives
test-assets/Jesus-modified-hollow.stl through the real
file input, simplify-decline, auto-repair, Big Print hollow-input, and curve
cut paths. The fixture is local-only and is never copied into this script.

The hook reports one strict title format:
  PERFREAL load=<ms> repair=<ms> ltout=<ms> ltsan=<ms> hsave=<ms>
           hsettle=<ms> cut=<ms> heap=<MB>

Ratified budgets (DESIGN-PERF.md): repair <= 10000 ms, hollow savings <= 2000
ms, hollow settled/warnings <= 10000 ms, worst unsanctioned long task <= 200
ms, curve cut <= 20000 ms, and post-GC JS heap <= 250 MB. `ltsan` is reported
for the sanctioned compute stages but has no pass/fail budget.

Default advisory mode returns 0 for budget breaches after a completed
measurement and prints the numbers plus a loud advisory. Harness
non-completion (crash, timeout, or unparseable title) always returns 1, even in
advisory mode: a broken measurement is a defect, not a budget breach. Set
CURVECUT_PERF_STRICT=1 to enforce the budgets. Missing fixture or
browser is a polite SKIP (0).

Run:  uv run --no-project python tools/check_perf_real.py
"""

import os
import re
import sys

from browser import GPU_ARGS, ROOT, ensure_playwright, page_url, run_page, skip_or_fail

FIXTURE = ROOT / "test-assets" / "Jesus-modified-hollow.stl"
REAL_TIME_LIMIT_S = 600
HARNESS_FAILURE = "harness did not complete — this is a defect, not a budget breach"

REPAIR_BUDGET_MS = 10_000
HOLLOW_SAVINGS_BUDGET_MS = 2_000
HOLLOW_SETTLE_BUDGET_MS = 10_000
LONG_OUTSIDE_BUDGET_MS = 200
CUT_BUDGET_MS = 20_000
HEAP_BUDGET_MB = 250

TITLE_RE = re.compile(
    r"PERFREAL load=(?P<load>-?\d+) repair=(?P<repair>-?\d+) "
    r"ltout=(?P<ltout>-?\d+) ltsan=(?P<ltsan>-?\d+) "
    r"hsave=(?P<hsave>-?\d+) hsettle=(?P<hsettle>-?\d+) "
    r"cut=(?P<cut>-?\d+) heap=(?P<heap>-?(?:\d+(?:\.\d+)?))"
)


def measurements(title: str):
    match = TITLE_RE.fullmatch(title)
    if not match:
        return None
    values = match.groupdict()
    return {name: (float(value) if name == "heap" else int(value))
            for name, value in values.items()}


def budget_breaches(values):
    checks = [
        ("auto-repair", values["repair"], REPAIR_BUDGET_MS, "ms"),
        ("hollow savings", values["hsave"], HOLLOW_SAVINGS_BUDGET_MS, "ms"),
        ("hollow settle/warnings", values["hsettle"], HOLLOW_SETTLE_BUDGET_MS, "ms"),
        ("worst outside-sanctioned long task", values["ltout"], LONG_OUTSIDE_BUDGET_MS, "ms"),
        ("curve cut", values["cut"], CUT_BUDGET_MS, "ms"),
        ("post-GC JS heap slice", values["heap"], HEAP_BUDGET_MB, "MB"),
    ]
    failures = []
    for label, value, budget, unit in checks:
        if value < 0:
            failures.append(
                f"{label}: measurement unavailable; cannot enforce <= {budget} {unit}")
        elif value > budget:
            failures.append(
                f"{label}: {value:.1f} {unit} exceeds the {budget} {unit} budget")
    return failures


def print_measurements(values):
    print("PERFREAL stage measurements (512k statue, real-time Playwright)")
    print(f"  load (parse + weld + scene)             {values['load']:>7} ms")
    print(f"  auto-repair (decline -> holes capped)    {values['repair']:>7} ms")
    print(f"  long task worst outside CC.ops           {values['ltout']:>7} ms")
    print(f"  long task worst inside CC.ops            {values['ltsan']:>7} ms")
    print(f"  hollow savings text                      {values['hsave']:>7} ms")
    print(f"  hollow warnings / settled status         {values['hsettle']:>7} ms")
    print(f"  curve cut                                {values['cut']:>7} ms")
    print(f"  JS heap post-GC (performance.memory JS slice)"
          f" {values['heap']:>7.1f} MB")


def main() -> int:
    if not FIXTURE.exists():
        print("SKIPPED: test-assets/Jesus-modified-hollow.stl missing (local-only fixture).")
        return 0

    ensure_playwright()
    try:
        result = run_page(
            page_url("index.html#perfreal"), REAL_TIME_LIMIT_S,
            done=lambda title: title.startswith("PERFREAL"), poll_s=1,
            args=(*GPU_ARGS, "--enable-precise-memory-info",
                  "--js-flags=--expose-gc", "--allow-file-access-from-files"))
    except Exception as err:
        print(f"FAIL: {HARNESS_FAILURE} — {err}")
        return 1
    if result.skipped:
        return skip_or_fail(result.skipped)
    title = result.title

    values = measurements(title)
    if values is None:
        result.print_errors()
        print(f"FAIL: {HARNESS_FAILURE}; title was: {title}")
        return 1

    print_measurements(values)
    failures = budget_breaches(values)
    strict = os.environ.get("CURVECUT_PERF_STRICT") == "1"
    if not strict:
        for failure in failures:
            print(f"ADVISORY BREACH: {failure}")
        print("ADVISORY — budgets not yet enforced (set CURVECUT_PERF_STRICT=1)")
        return 0

    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        return 1
    print("real perf check ok — all ratified budgets within limits")
    return 0


if __name__ == "__main__":
    sys.exit(main())
