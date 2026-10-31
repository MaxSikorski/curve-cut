#!/usr/bin/env python3
"""check_js_syntax.py — parse-check every js/*.js without executing it.

Uses `new Function(src)`, which parses but never runs the code: in macOS's
built-in JavaScriptCore (osascript -l JavaScript) when it exists, otherwise in
Playwright's headless Chromium (Linux CI). Catches the "edited a file, broke
the parse" class of error before the browser does.

Run:  uv run --no-project python tools/check_js_syntax.py
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    files = sorted((ROOT / "js").glob("*.js"))
    if not files:
        print("FAIL: no js/*.js files found")
        return 1

    parse = parse_with_osascript if shutil.which("osascript") else parse_with_chromium()
    if not callable(parse):
        return parse  # no parser available: skip_or_fail's exit code
    failures = 0
    for f in files:
        out = parse(f)
        if out == "ok":
            print(f"ok   {f.relative_to(ROOT)}")
        else:
            print(f"FAIL {f.relative_to(ROOT)} — {out}")
            failures += 1

    if failures:
        return 1
    print(f"js syntax check ok — {len(files)} files parse clean")
    return 0


def parse_with_osascript(f: Path) -> str:
    jxa = (
        f'const src = $.NSString.stringWithContentsOfFileEncodingError('
        f'"{f}", $.NSUTF8StringEncoding, null).js; '
        f'try {{ new Function(src); "ok" }} catch (e) {{ "ERR: " + e.message }}'
    )
    return subprocess.run(
        ["osascript", "-l", "JavaScript", "-e", jxa],
        capture_output=True, text=True, timeout=30,
    ).stdout.strip()


def parse_with_chromium():
    from browser import ensure_playwright, skip_or_fail
    ensure_playwright()
    from playwright.sync_api import Error, sync_playwright

    p = sync_playwright().start()
    try:
        page = p.chromium.launch(headless=True).new_page()
    except Error as e:
        if "Executable doesn't exist" in str(e):
            return skip_or_fail("no osascript and Playwright's Chromium is not installed")
        raise
    return lambda f: page.evaluate(
        "src => { try { new Function(src); return 'ok'; } catch (e) { return 'ERR: ' + e.message; } }",
        f.read_text(encoding="utf-8"))


if __name__ == "__main__":
    sys.exit(main())
