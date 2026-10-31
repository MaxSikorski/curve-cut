#!/usr/bin/env python3
"""check_memory.py — run the memory lifecycle test in real-time headless Chromium.

The page exercises automatic cache-aware recycling, directional worker
memoryStats, degraded prime disposal, and the history retained-triangle cap.
It runs in real time through tools/browser.py (Playwright) because virtual time
would starve worker messages and the timer-driven recycle handoff.

SKIPS politely (exit 0) if that browser is not installed.

Run: uv run --no-project python tools/check_memory.py
"""

import sys

from browser import ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 180
REQUIRED_CHECKS = (
    "memoryReport exposes the budget fields",
    "worker recycle threshold is finite",
    "memory test exposes the automatic recycle seam",
    "threshold recycle defers while cache token is live",
    "memoryStats grows after an allocating op",
    "memoryStats shrinks after recycle",
    "automatic threshold recycle fires with worker-wasm-threshold",
    "post-recycle prime and estimate preserve cache flow",
    "memoryReport reports the memoryStats snapshot",
    "degraded-after-prime release disposes the main-thread cache",
    "history stays under the retained triangle cap",
)


def print_failures(log: str) -> None:
    failures = [line for line in log.splitlines()
                if line.lstrip().startswith("FAIL")]
    if not failures:
        return
    print("memory test per-check failures:")
    for failure in failures:
        print(f"  {failure}")


def missing_checks(log: str) -> list[str]:
    return [name for name in REQUIRED_CHECKS
            if not any(name in line and line.lstrip().startswith("ok")
                       for line in log.splitlines())]


def main() -> int:
    ensure_playwright()
    result = run_page(page_url("tests/memory-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    title, log = result.title, result.log

    if title == "PASS":
        missing = missing_checks(log)
        if missing:
            print("FAIL: memory test omitted required checks:")
            for name in missing:
                print(f"  {name}")
            return 1
        print("memory check ok — automatic recycle/cache flow, directional memoryStats, "
              "degraded disposal, and history cap passed (real-time Playwright)")
        return 0

    print_failures(log)
    result.print_errors()
    print(f"FAIL: memory test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
