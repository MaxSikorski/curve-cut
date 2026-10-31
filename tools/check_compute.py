"""check_compute.py — run the compute worker and fallback test headlessly.

The page is deliberately opened as file:// so the Blob URL worker path is
tested in the same offline mode as the product.

Runs in real time through tools/browser.py (Playwright's headless Chromium):
virtual time would starve worker messages and leave the page at RUNNING
forever.

SKIPS politely (exit 0) if that browser is not installed.

Run: uv run --no-project python tools/check_compute.py
"""

import json
import subprocess
import sys
from pathlib import Path

from browser import ROOT, ensure_playwright, page_url, run_page, skip_or_fail

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

    ensure_playwright()
    result = run_page(page_url("tests/compute-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    title, log = result.title, result.log

    if title == "PASS":
        missing = missing_coverage(log)
        if missing:
            print("FAIL: compute test omitted required protocol coverage:")
            for name in missing:
                print(f"  {name}")
            return 1
        print("compute check ok — worker and fallback tests passed (real-time Playwright)")
        return 0

    print_failures(log)
    result.print_errors()
    print(f"FAIL: compute test result: {title}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
