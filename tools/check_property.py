#!/usr/bin/env python3
"""check_property.py — run the seeded DOM-free property lane over CDP.

This intentionally uses a real-time DevTools connection. Virtual time can
starve WASM and parser work on this page, leaving an interactive test at
RUNNING forever. Set PROPERTY_SEED to append #seed=<value> for exact replay.

Run: uv run --no-project python tools/check_property.py
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
TEST_URL = f"file://{ROOT}/tests/property-test.html"
PORT = 9346
REAL_TIME_LIMIT_S = 120
DEFAULT_SEED = 0xC0FFEE21

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def ensure_websockets() -> None:
    """Re-exec through uv when the optional CDP client is not installed."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        if os.environ.get("CHECK_PROPERTY_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_PROPERTY_REEXEC="1")
        os.execvpe(
            "uv",
            ["uv", "run", "--no-project", "--with", "websockets",
             "python", __file__],
            env,
        )


async def run_harness(browser: str, profile: str, url: str) -> tuple[str, str]:
    import websockets

    process = subprocess.Popen(
        [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
         "about:blank"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        websocket_url = None
        for _ in range(50):
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{PORT}/json"
                ) as response:
                    tabs = json.load(response)
                page = next(tab for tab in tabs if tab["type"] == "page")
                websocket_url = page["webSocketDebuggerUrl"]
                break
            except Exception:
                await asyncio.sleep(0.2)
        if not websocket_url:
            return "(browser never exposed a debug target)", ""

        async with websockets.connect(
            websocket_url, max_size=10 * 1024 * 1024
        ) as websocket:
            message_id = 0

            async def command(method, **params):
                nonlocal message_id
                message_id += 1
                current_id = message_id
                await websocket.send(json.dumps({
                    "id": current_id, "method": method, "params": params,
                }))
                while True:
                    message = json.loads(await asyncio.wait_for(
                        websocket.recv(), timeout=30))
                    if message.get("id") != current_id:
                        continue
                    if "error" in message:
                        raise RuntimeError(message["error"])
                    return message.get("result", {})

            async def evaluate(expression):
                result = await command(
                    "Runtime.evaluate", expression=expression,
                    returnByValue=True,
                )
                return result.get("result", {}).get("value")

            await command("Page.enable")
            await command("Runtime.enable")
            await command("Page.navigate", url=url)
            deadline = time.monotonic() + REAL_TIME_LIMIT_S
            title = "(no title)"
            while time.monotonic() < deadline:
                await asyncio.sleep(0.5)
                title = await evaluate("document.title") or "(no title)"
                if title == "PASS" or title.startswith("FAIL"):
                    log = await evaluate(
                        "document.getElementById('log').textContent"
                    ) or ""
                    return title, log
            return title, ""
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


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
    browser = next(
        (candidate for candidate in BROWSERS if Path(candidate).exists()),
        None,
    )
    if not browser:
        print("SKIPPED: no Chromium-family browser found for property tests.")
        return 0

    ensure_websockets()
    seed = os.environ.get("PROPERTY_SEED", "").strip()
    url = TEST_URL + (f"#seed={seed}" if seed else "")
    with tempfile.TemporaryDirectory(prefix="curvecut-property-") as profile:
        title, log = asyncio.run(run_harness(browser, profile, url))

    if title == "PASS":
        summaries = [
            line for line in log.splitlines() if line.startswith("SUMMARY ")
        ]
        for summary in summaries:
            print(summary)
        print("property check ok — seeded engine invariants passed (real-time CDP)")
        return 0

    print_failures(log)
    if not any(line.startswith("seed=") for line in log.splitlines()):
        print(f"seed={seed or DEFAULT_SEED}")
    print(f"FAIL: property test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
