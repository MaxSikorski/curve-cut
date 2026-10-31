#!/usr/bin/env python3
"""check_race.py — race/failure tests for the operation coordinator (v2.0.2 item 6).

Opens index.html#racetest (see js/race-hook.js): eight scenarios — model
replacement mid-cut, Start New during simplify, Escape during Big Print
export, Big Print cancel restore, save-picker blob fallback, and grid-cap
refusal, superseding a worker warm mid-flight, and warm/export abort seams —
driven through the REAL production code paths, reporting
"RACE ok=<n> fail=<m>" in document.title.

Unlike check_perf.py this does NOT use --virtual-time-budget: Chromium's
virtual time starves interactive rAF/event interleavings on this machine
(~1 frame per 600ms virtual — measured 2026-07-17; scenario (a) times out
under it while passing real-time). Instead we drive a real-time headless
browser over CDP and poll the title. Needs the `websockets` package; the
script re-execs itself through `uv run --with websockets` so the /verify
convention (`uv run --no-project python tools/check_race.py`) still works
unchanged.

SKIPs loudly (exit 0) if no Chromium-family browser is installed.

Run:  uv run --no-project python tools/check_race.py
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
TEST_URL = f"file://{ROOT}/index.html#racetest"
PORT = 9342
REAL_TIME_LIMIT_S = 180
EXPECTED_SCENARIOS = 8

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
        if os.environ.get("CHECK_RACE_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_RACE_REEXEC="1")
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
                if title.startswith("RACE"):
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
        print("SKIPPED: no Chromium-family browser found for headless race testing.")
        return 0

    ensure_websockets()
    import asyncio

    with tempfile.TemporaryDirectory(prefix="curvecut-race-") as profile:
        title = asyncio.run(run_harness(browser, profile))

    m = re.fullmatch(r"RACE ok=(\d+) fail=(\d+)(?: failures=(.*))?", title)
    if not m:
        print(f"FAIL: race harness did not finish — title was: {title}")
        return 1

    ok, fail = int(m.group(1)), int(m.group(2))
    detail = (m.group(3) or "").strip()
    print(f"measured: {ok} scenarios ok, {fail} failed"
          + (f" — {detail}" if detail else ""))
    if fail or ok < EXPECTED_SCENARIOS:
        print("FAIL: coordinator race scenarios failed (names above)")
        return 1
    print("race check ok — all 8 coordinator race scenarios pass (real-time CDP)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
