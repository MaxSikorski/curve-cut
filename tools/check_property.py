#!/usr/bin/env python3
"""check_property.py — run the seeded DOM-free property lane in headless Chromium.

Runs in real time through tools/browser.py (Playwright): virtual time can
starve WASM and parser work on this page, leaving an interactive test at
RUNNING forever. Set PROPERTY_SEED to append #seed=<value> for exact replay.

Run: uv run --no-project python tools/check_property.py
"""

import os
import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 120
DEFAULT_SEED = 0xC0FFEE21


def print_failures(log: str) -> None:
    lines = log.splitlines()
    seed_lines = [line for line in lines if line.startswith("seed=")]
    failures = [
        line for line in lines
        if line.startswith("FAIL ") or line.startswith("EXCEPTION ")
    ]
    if seed_lines:
        print(seed_lines[0])
    if failures:
        print("property test per-check failures:")
        for failure in failures:
            print(f"  {failure}")
    summaries = [line for line in lines if line.startswith("SUMMARY ")]
    for summary in summaries:
        print(summary)


def main() -> int:
    ensure_playwright()
    seed = os.environ.get("PROPERTY_SEED", "").strip()
    result = run_page(page_url("tests/property-test.html"
                               + (f"#seed={seed}" if seed else "")),
                      REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    title, log = result.title, result.log

    if title == "PASS":
        summaries = [
            line for line in log.splitlines() if line.startswith("SUMMARY ")
        ]
        for summary in summaries:
            print(summary)
        print("property check ok — seeded engine invariants passed (real-time Playwright)")
        return 0

    print_failures(log)
    if not any(line.startswith("seed=") for line in log.splitlines()):
        print(f"seed={seed or DEFAULT_SEED}")
    result.print_errors()
    print(f"FAIL: property test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
