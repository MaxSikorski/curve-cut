#!/usr/bin/env python3
"""check_perf_medium.py — medium-model perf numbers (v2.1a perf lane).

Opens index.html#perfmed (see js/perf-medium-hook.js): a ~380k-triangle model
(below the simplify threshold — the 10-100MB STL band Max works in), watertight
check, curve cut, then 240 frames of model rotation, reporting stage timings and
frame stats in document.title.

Like check_race.py this runs a REAL-TIME headless browser over CDP — Chromium's
virtual time starves rAF, which would make the frame-time numbers meaningless.
Re-execs itself through `uv run --with websockets` so the /verify convention
(`uv run --no-project python tools/check_perf_medium.py`) works unchanged.

Budgets (provisional, set 2026-08-06 from the published-tag A/B; tighten after
the perf lane closes):
  - load (weld + scene) <= 10 s          - cut <= 20 s
  - frame p95 <= 250 ms (headless swiftshader; relative A/B is the real signal)
  - heap <= 250 MB

SKIPs loudly (exit 0) if no Chromium-family browser is installed.

Run:  uv run --no-project python tools/check_perf_medium.py
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/index.html#perfmed"
PORT = 9343
REAL_TIME_LIMIT_S = 180

LOAD_BUDGET_MS = 10_000
CUT_BUDGET_MS = 20_000
FP95_BUDGET_MS = 250
HEAP_BUDGET_MB = 250

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def ensure_websockets() -> None:
    """Re-exec through uv with the websockets extra when it's missing."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        if os.environ.get("CHECK_PERFMED_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_PERFMED_REEXEC="1")
        os.execvpe(
            "uv",
            ["uv", "run", "--no-project", "--with", "websockets",
             "python", __file__],
            env,
        )


async def run_harness(browser: str, profile: str) -> str:
    import asyncio
    import websockets

    proc = subprocess.Popen(
        [browser, "--headless=new", "--hide-scrollbars",
         "--enable-precise-memory-info", "--js-flags=--expose-gc",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as r:
                    tabs = json.load(r)
                page = next(t for t in tabs if t["type"] == "page")
                ws_url = page["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.2)
        if not ws_url:
            return "(browser never exposed a debug target)"

        async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
            mid = [0]

            async def cmd(method, **params):
                mid[0] += 1
                await ws.send(json.dumps(
                    {"id": mid[0], "method": method, "params": params}))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg.get("id") == mid[0]:
                        return msg.get("result", {})

            await cmd("Page.enable")
            await cmd("Page.navigate", url=TEST_URL)
            deadline = time.time() + REAL_TIME_LIMIT_S
            title = "(no title)"
            while time.time() < deadline:
                await asyncio.sleep(3)
                res = await cmd("Runtime.evaluate",
                                expression="document.title")
                title = res.get("result", {}).get("value", "(no title)")
                if title.startswith("PERFMED"):
                    break
            return title
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    browser = next((b for b in BROWSERS if Path(b).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless perf testing.")
        return 0

    ensure_websockets()
    import asyncio

    with tempfile.TemporaryDirectory(prefix="curvecut-perfmed-") as profile:
        title = asyncio.run(run_harness(browser, profile))

    m = re.fullmatch(
        r"PERFMED load=(\d+) wt=(\d+) cut=(\d+) "
        r"favg=([\d.]+) fp95=([\d.]+) heap=([\d.-]+)", title)
    if not m:
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
