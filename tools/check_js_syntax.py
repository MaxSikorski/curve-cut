#!/usr/bin/env python3
"""check_js_syntax.py — parse-check every js/*.js without executing it.

Uses macOS's built-in JavaScriptCore (osascript -l JavaScript) and
`new Function(src)`, which parses but never runs the code. Catches the
"edited a file, broke the parse" class of error before the browser does.

Run:  uv run --no-project python tools/check_js_syntax.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    files = sorted((ROOT / "js").glob("*.js"))
    if not files:
        print("FAIL: no js/*.js files found")
        return 1

    failures = 0
    for f in files:
        jxa = (
            f'const src = $.NSString.stringWithContentsOfFileEncodingError('
            f'"{f}", $.NSUTF8StringEncoding, null).js; '
            f'try {{ new Function(src); "ok" }} catch (e) {{ "ERR: " + e.message }}'
        )
        out = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", jxa],
            capture_output=True, text=True, timeout=30,
        ).stdout.strip()
        if out == "ok":
            print(f"ok   {f.relative_to(ROOT)}")
        else:
            print(f"FAIL {f.relative_to(ROOT)} — {out}")
            failures += 1

    if failures:
        return 1
    print(f"js syntax check ok — {len(files)} files parse clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
