#!/usr/bin/env python3
"""check_perf_real.py — real-model performance acceptance instrument (v2.1p).

Opens index.html#perfreal (see js/perf-real-hook.js) over a real-time CDP
connection and drives test-assets/Jesus-modified-hollow.stl through the real
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
Chromium-family browser is a polite SKIP (0).

Run:  uv run --no-project python tools/check_perf_real.py
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
FIXTURE = ROOT / "test-assets" / "Jesus-modified-hollow.stl"
TEST_URL = f"file://{ROOT}/index.html#perfreal"
PORT = 9344
REAL_TIME_LIMIT_S = 600
HARNESS_FAILURE = "harness did not complete — this is a defect, not a budget breach"

REPAIR_BUDGET_MS = 10_000
HOLLOW_SAVINGS_BUDGET_MS = 2_000
HOLLOW_SETTLE_BUDGET_MS = 10_000
LONG_OUTSIDE_BUDGET_MS = 200
CUT_BUDGET_MS = 20_000
HEAP_BUDGET_MB = 250

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]

TITLE_RE = re.compile(
    r"PERFREAL load=(?P<load>-?\d+) repair=(?P<repair>-?\d+) "
    r"ltout=(?P<ltout>-?\d+) ltsan=(?P<ltsan>-?\d+) "
    r"hsave=(?P<hsave>-?\d+) hsettle=(?P<hsettle>-?\d+) "
    r"cut=(?P<cut>-?\d+) heap=(?P<heap>-?(?:\d+(?:\.\d+)?))"
)


def ensure_websockets() -> None:
    """Re-exec through uv with the websockets extra when it is missing."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        if os.environ.get("CHECK_PERFREAL_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_PERFREAL_REEXEC="1")
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
         "--allow-file-access-from-files", f"--remote-debugging-port={PORT}",
         f"--user-data-dir={profile}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(
                        f"http://127.0.0.1:{PORT}/json", timeout=2) as response:
                    tabs = json.load(response)
                page = next(tab for tab in tabs if tab["type"] == "page")
                ws_url = page["webSocketDebuggerUrl"]
                break
            except Exception:
                time.sleep(0.2)
        if not ws_url:
            return "(browser never exposed a debug target)"

        async with websockets.connect(ws_url, max_size=64 * 1024 * 1024) as ws:
            message_id = [0]

            async def cmd(method, **params):
                message_id[0] += 1
                current_id = message_id[0]
                await ws.send(json.dumps({
                    "id": current_id, "method": method, "params": params,
                }))
                while True:
                    message = json.loads(await ws.recv())
                    if message.get("id") != current_id:
                        continue
                    if "error" in message:
                        raise RuntimeError(message["error"])
                    return message.get("result", {})

            await cmd("Page.enable")
            await cmd("Page.navigate", url=TEST_URL)
            deadline = time.monotonic() + REAL_TIME_LIMIT_S
            title = "(no title)"
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                result = await cmd("Runtime.evaluate", expression="document.title")
                title = result.get("result", {}).get("value", "(no title)")
                if title.startswith("PERFREAL"):
                    break
            return title
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


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
    print("PERFREAL stage measurements (512k statue, real-time CDP)")
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

    browser = next((path for path in BROWSERS if Path(path).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless perf testing.")
        return 0

    ensure_websockets()
    import asyncio

    try:
        with tempfile.TemporaryDirectory(prefix="curvecut-perfreal-") as profile:
            title = asyncio.run(run_harness(browser, profile))
    except Exception as err:
        print(f"FAIL: {HARNESS_FAILURE} — {err}")
        return 1

    values = measurements(title)
    if values is None:
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
