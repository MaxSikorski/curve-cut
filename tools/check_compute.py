#!/usr/bin/env python3
"""check_compute.py — run the compute worker and fallback test headlessly.

The page is deliberately opened as file:// so the Blob URL worker path is
tested in the same offline mode as the product.

Unlike the older dump-dom check, this uses a real-time CDP connection.
Chromium's virtual time can starve worker messages, leaving the page at
RUNNING forever. The script re-execs itself through ``uv run --with
websockets`` so the normal ``uv run --no-project python tools/check_compute.py``
command works without a project environment.

SKIPS politely (exit 0) if no Chromium-family browser is installed.

Run: uv run --no-project python tools/check_compute.py
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
TEST_URL = f"file://{ROOT}/tests/compute-test.html"
PORT = 9345
REAL_TIME_LIMIT_S = 180
REQUIRED_COVERAGE_CHECKS = (
    "repairGeometry uses one fused worker round-trip",
    "repairGeometry primes cache from its transferred result",
    "cache consumers send token-only payloads",
    "cutWithCutter returns worker piece arrays",
    "cutWithCutter emits determinate per-part progress",
    "worker cut matches main signed piece parity",
    "cutWithCutter cancellation rejects cooperatively",
    "degraded cut fallback matches worker parity",
    "cut.js degraded apply matches main piece results",
    "cut.js degraded apply skips worker readiness, transfer, and cancel",
    "cut.js keeps a readiness-time demotion on the main path",
    "readiness-time demotion does not use worker transfer or cancel",
    "cutWithCutter detaches transferred geometry",
    "cutWithCutter builds connector solids worker-side",
)

BROWSERS = [
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
]


def check_worker_source() -> bool:
    """Reject a stale generated worker before starting the browser harness."""
    try:
        result = subprocess.run(
            ["uv", "run", "--no-project", "python", "tools/embed_worker.py", "--check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
    except OSError as error:
        print(f"FAIL: could not run compute worker source drift check: {error}")
        return False

    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode:
        print("FAIL: generated compute worker source is stale; run "
              "uv run --no-project python tools/embed_worker.py")
        return False
    return True


def check_embedded_syntax() -> bool:
    """Syntax-check the EMBEDDED worker source itself.

    check_js_syntax.py parses compute-worker-src.js as a file — a giant valid
    string literal — so a syntax error INSIDE the string sails through every
    file-level gate and only explodes at Worker boot (2026-08-08: a dropped
    paren in the shell shipped exactly that way; the degraded fallback then
    masked it for 10 of 20 checks). Extract the string, run jsc on it.
    """
    import json
    import re
    import shutil
    import tempfile

    jsc = shutil.which("jsc") or (
        "/System/Library/Frameworks/JavaScriptCore.framework/"
        "Versions/Current/Helpers/jsc")
    if not Path(jsc).exists():
        print("SKIPPED: no jsc for embedded-source syntax check")
        return True
    text = (ROOT / "js/compute-worker-src.js").read_text()
    start = text.index("CurveCutComputeWorkerSource =")
    literals = re.findall(r'^\s*(".*")\s*[+;]?\s*$', text[start:], re.M)
    if not literals:
        print("FAIL: could not extract the embedded worker source literal")
        return False
    worker_source = "".join(json.loads(part) for part in literals)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as handle:
        handle.write(worker_source)
        extracted = handle.name
    try:
        result = subprocess.run([jsc, extracted], capture_output=True,
                                text=True, timeout=60)
        blob = (result.stderr or "") + (result.stdout or "")
        if "SyntaxError" in blob:
            print(f"FAIL: embedded worker source has a syntax error:\n"
                  f"{blob.strip()[:300]}")
            return False
    finally:
        Path(extracted).unlink(missing_ok=True)
    print("embedded worker source parses clean "
          f"({len(worker_source):,} chars via jsc)")
    return True


def ensure_websockets() -> None:
    """Re-exec through uv with the websockets extra when it's missing."""
    try:
        import websockets  # noqa: F401
    except ImportError:
        if os.environ.get("CHECK_COMPUTE_REEXEC"):
            print("FAIL: websockets unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CHECK_COMPUTE_REEXEC="1")
        os.execvpe(
            "uv",
            ["uv", "run", "--no-project", "--with", "websockets",
             "python", __file__],
            env,
        )


async def run_harness(browser: str, profile: str) -> tuple[str, str]:
    import asyncio
    import websockets

    proc = subprocess.Popen(
        [browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         f"--remote-debugging-port={PORT}", f"--user-data-dir={profile}",
         "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
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
                time.sleep(0.2)
        if not ws_url:
            return "(browser never exposed a debug target)", ""

        async with websockets.connect(ws_url, max_size=10 * 1024 * 1024) as ws:
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

            async def evaluate(expression):
                result = await cmd("Runtime.evaluate", expression=expression,
                                   returnByValue=True)
                return result.get("result", {}).get("value")

            await cmd("Page.enable")
            await cmd("Page.navigate", url=TEST_URL)
            deadline = time.monotonic() + REAL_TIME_LIMIT_S
            title = "(no title)"
            while time.monotonic() < deadline:
                await asyncio.sleep(1)
                title = await evaluate("document.title") or "(no title)"
                if title == "PASS" or title.startswith("FAIL"):
                    log = await evaluate(
                        "document.getElementById('log').textContent") or ""
                    return title, log
            return title, ""
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def print_failures(log: str) -> None:
    failures = [line for line in log.splitlines() if line.lstrip().startswith("FAIL")]
    if not failures:
        return
    print("compute test per-check failures:")
    for failure in failures:
        print(f"  {failure}")


def missing_coverage(log: str) -> list[str]:
    return [name for name in REQUIRED_COVERAGE_CHECKS
            if not any(name in line and line.lstrip().startswith("ok")
                       for line in log.splitlines())]


def main() -> int:
    if not check_worker_source():
        return 1
    if not check_embedded_syntax():
        return 1

    browser = next((candidate for candidate in BROWSERS if Path(candidate).exists()), None)
    if not browser:
        print("SKIPPED: no Chromium-family browser found for headless compute tests.")
        return 0

    ensure_websockets()
    import asyncio

    with tempfile.TemporaryDirectory(prefix="curvecut-compute-") as profile:
        title, log = asyncio.run(run_harness(browser, profile))

    if title == "PASS":
        missing = missing_coverage(log)
        if missing:
            print("FAIL: compute test omitted required protocol coverage:")
            for name in missing:
                print(f"  {name}")
            return 1
        print("compute check ok — worker and fallback tests passed (real-time CDP)")
        return 0

    print_failures(log)
    print(f"FAIL: compute test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
