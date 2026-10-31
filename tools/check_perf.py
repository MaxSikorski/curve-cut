#!/usr/bin/env python3
"""check_perf.py — memory/perf budget for the real app (roadmap v1.2).

Opens index.html#perftest (see js/perf-hook.js): generates a
~600k-triangle model, accepts the simplify offer, applies a straight cut,
undoes and redoes, then reads the JS heap.

Real-time CDP runner (rewritten 2026-08-09, foreman takeover after W3R-fix2):
the old --virtual-time-budget + --dump-dom form fast-forwarded the hook's new
ops-idle polling loop — 60 s of virtual timeout elapsed before real worker ops
finished (house lesson #3, same class check_compute hit in W2). Pattern follows
tools/check_perf_medium.py. Re-execs through `uv run --with websockets` so the
/verify convention (`uv run --no-project python tools/check_perf.py`) works
unchanged.

Budgets (Max, 2026-07-13):
  - JS heap after the full heavy workflow: <= 250 MB
  - whole scripted workflow completes: <= 90 s headless

SKIPs loudly (exit 0) if no Chromium-family browser is installed.

Run:  uv run --no-project python tools/check_perf.py
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
TEST_URL = f"file://{ROOT}/index.html#perftest"
PORT = 9349
REAL_TIME_LIMIT_S = 180

HEAP_BUDGET_MB = 250
TOTAL_BUDGET_MS = 90_000

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
        if os.environ.get("CHECK_PERF_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_PERF_REEXEC="1")
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
                if title.startswith("PERF "):
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
        print("SKIPPED: no Chromium-family browser found for headless testing.")
        return 0

    ensure_websockets()
    import asyncio

    with tempfile.TemporaryDirectory(prefix="curvecut-perf-") as profile:
        title = asyncio.run(run_harness(browser, profile))

    m = re.match(r"PERF heap=([\d.]+) total=(\d+) pieces=(\d+)", title)
    if not m:
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
