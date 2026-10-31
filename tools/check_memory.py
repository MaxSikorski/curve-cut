#!/usr/bin/env python3
"""check_memory.py — run the memory lifecycle test over real-time CDP.

The page exercises automatic cache-aware recycling, directional worker
memoryStats, degraded prime disposal, and the history retained-triangle cap.
It uses real time because virtual time can starve worker messages and the
timer-driven recycle handoff.

SKIPS politely (exit 0) if no Chromium-family browser is installed.

Run: uv run --no-project python tools/check_memory.py
"""

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/memory-test.html"
PORT = 9348
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

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def ensure_websockets() -> None:
    """Re-exec through uv with the websockets extra when it is missing."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        if os.environ.get("CHECK_MEMORY_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_MEMORY_REEXEC="1")
        os.execvpe(
            "uv",
            ["uv", "run", "--no-project", "--with", "websockets",
             "python", __file__],
            env,
        )


async def run_harness(browser: str, profile: str) -> tuple[str, str]:
    import websockets

    proc = subprocess.Popen(
        [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
         "about:blank"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        ws_url = None
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json") as response:
                    tabs = json.load(response)
                page = next(tab for tab in tabs if tab["type"] == "page")
                ws_url = page["webSocketDebuggerUrl"]
                break
            except Exception:
                await asyncio.sleep(0.2)
        if not ws_url:
            return "(browser never exposed a debug target)", ""

        async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
            message_id = [0]

            async def command(method: str, **params):
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

            async def evaluate(expression: str):
                result = await command(
                    "Runtime.evaluate", expression=expression, returnByValue=True,
                )
                return result.get("result", {}).get("value")

            await command("Page.enable")
            await command("Page.navigate", url=TEST_URL)
            deadline = time.monotonic() + REAL_TIME_LIMIT_S
            title = "(no title)"
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                title = await evaluate("document.title") or "(no title)"
                if title == "PASS" or title.startswith("FAIL"):
                    log = await evaluate(
                        "document.getElementById('log').textContent"
                    ) or ""
                    return title, log
            return title, ""
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


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
    browser = next((candidate for candidate in BROWSERS if Path(candidate).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for memory lifecycle tests.")
        return 0

    ensure_websockets()
    with tempfile.TemporaryDirectory(prefix="curvecut-memory-") as profile:
        title, log = asyncio.run(run_harness(browser, profile))

    if title == "PASS":
        missing = missing_checks(log)
        if missing:
            print("FAIL: memory test omitted required checks:")
            for name in missing:
                print(f"  {name}")
            return 1
        print("memory check ok — automatic recycle/cache flow, directional memoryStats, "
              "degraded disposal, and history cap passed (real-time CDP)")
        return 0

    print_failures(log)
    print(f"FAIL: memory test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
