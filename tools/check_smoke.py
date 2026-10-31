#!/usr/bin/env python3
"""check_smoke.py — does the app start and do one real cut job in a clean browser?

Opens index.html (from this repo, or from --root DIR, e.g. the exact release
tree `/ship` is about to publish), waits for window.CurveCut, loads a box,
waits for the load-time repair to finish, and checks there is one piece and no
page errors. Fast (seconds): this is the CI smoke test.

Run:  uv run --no-project python tools/check_smoke.py [--root DIR]
"""

import argparse
import sys
from pathlib import Path

from browser import ensure_playwright, skip_or_fail

TIMEOUT_S = 60
PROBE = """(async () => {
  const CC = window.CurveCut;
  if (!CC || !CC.ops || !CC.loadGeometry) { document.title = "FAIL: window.CurveCut missing"; return; }
  CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(), "smoke-cube.stl");
  await new Promise(r => setTimeout(r, 200));
  const t0 = performance.now();
  while (CC.ops.busy() && performance.now() - t0 < 45000) await new Promise(r => setTimeout(r, 50));
  if (CC.ops.busy()) { document.title = "FAIL: load operation never finished"; return; }
  document.title = CC.pieces.length === 1 ? "PASS" : `FAIL: ${CC.pieces.length} pieces after load`;
})()"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    root = parser.parse_args().root.resolve()
    ensure_playwright()

    from playwright.sync_api import Error, sync_playwright

    url = (root / "index.html").as_uri()
    errors = []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Error as e:
            if "Executable doesn't exist" in str(e):
                return skip_or_fail("Playwright's Chromium is not installed")
            raise
        try:
            page = browser.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(url)
            page.wait_for_function("window.CurveCut && window.THREE", timeout=TIMEOUT_S * 1000)
            page.evaluate(PROBE)
            page.wait_for_function("document.title === 'PASS' || document.title.startsWith('FAIL')",
                                   timeout=TIMEOUT_S * 1000)
            title = page.title()
        except Error as e:
            title = f"FAIL: {str(e).splitlines()[0]}"
        finally:
            browser.close()

    for line in errors[:10]:
        print(f"  page error: {line}")
    if title == "PASS" and not errors:
        print(f"smoke check ok — app starts and loads a model ({root.name})")
        return 0
    print(f"FAIL: smoke — {title}" + (f"; {len(errors)} page error(s)" if errors else ""))
    return 1


if __name__ == "__main__":
    sys.exit(main())
