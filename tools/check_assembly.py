#!/usr/bin/env python3
"""check_assembly.py — the 3D assembly viewer (assembly.html in every Big Print zip).

Proves, in three steps:
  1. js/assembly-viewer-src.js is up to date (tools/embed_viewer.py --check).
  2. tests/assembly-test.html: neighbours, per-part triangle targets, mesh
     packing round trip, the collector, the file text, the 6 MB cap and its
     halve, the manifest note, and the viewer itself (select, explode, layout,
     dispose) mounted in a plain div.
  3. Benchy acceptance (skipped when test-assets/3DBenchy.stl is absent): a
     real Big Print export from index.html over file://, then the zip's
     assembly.html opened from disk. It must exist, stay under 6,000,000
     bytes, list the same parts as manifest.txt, select a part with a real
     mouse click, make no network requests, and log no errors. The viewer
     source must not be loaded until the export asks for it.

Run:  uv run --no-project python tools/check_assembly.py
Weight: medium; heavy with the Benchy (about a minute).
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path

from browser import (FILE_FETCH_SHIM, ROOT, ensure_playwright, page_url,
                     run_page, skip_or_fail)

CORE_TIME_LIMIT_S = 120
BENCHY = ROOT / "test-assets" / "3DBenchy.stl"
SIZE_LIMIT = 6_000_000


def check_viewer_source() -> bool:
    try:
        result = subprocess.run(
            ["uv", "run", "--no-project", "python", "tools/embed_viewer.py", "--check"],
            cwd=ROOT, capture_output=True, text=True)
    except OSError as error:
        print(f"FAIL: could not run viewer source drift check: {error}")
        return False
    if result.stdout.strip():
        print(result.stdout.rstrip())
    if result.stderr.strip():
        print(result.stderr.rstrip(), file=sys.stderr)
    if result.returncode:
        print("FAIL: generated viewer source is missing or stale; run "
              "uv run --no-project python tools/embed_viewer.py")
        return False
    return True


def check_test_page() -> int:
    """0 = pass, 1 = fail, 2 = skipped (no browser)."""
    result = run_page(page_url("tests/assembly-test.html"), CORE_TIME_LIMIT_S)
    if result.skipped:
        skip_or_fail(result.skipped)
        return 2
    if result.log:
        print(result.log)
    if result.title == "PASS" and not result.errors:
        print("assembly core and viewer checks ok")
        return 0
    result.print_errors()
    print(f"FAIL: assembly test result: {result.title}"
          + (" (timed out)" if result.timed_out else ""))
    return 1


def set_input_js(element_id: str, value) -> str:
    return (f"(() => {{ const el = document.getElementById('{element_id}');"
            f" el.value = {value!r}; el.dispatchEvent(new Event('input', {{bubbles: true}})); }})()")


def benchy_acceptance() -> bool:
    if not BENCHY.is_file():
        print("SKIPPED: Benchy acceptance (test-assets/3DBenchy.stl absent)")
        return True
    from playwright.sync_api import Error, sync_playwright

    fails = []

    def check(name, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    tmp = Path(tempfile.mkdtemp(prefix="assembly-benchy-"))
    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch(
                    headless=True, args=["--allow-file-access-from-files"])
            except Error as error:
                if "Executable doesn't exist" in str(error):
                    skip_or_fail("Playwright's Chromium is not installed")
                    return True
                raise
            try:
                context = browser.new_context(accept_downloads=True)
                context.add_init_script(FILE_FETCH_SHIM)
                # no native save dialog in headless: force the blob zip writer
                context.add_init_script("window.showSaveFilePicker = undefined")
                requests, problems = [], []
                context.on("request", lambda r: requests.append(r.url))
                page = context.new_page()
                page.on("pageerror", lambda e: problems.append(f"app pageerror: {e}"))
                page.on("console", lambda m: m.type == "error"
                        and problems.append(f"app console: {m.text}"))
                page.goto(page_url("index.html"), wait_until="load")
                page.wait_for_function("window.CurveCut && window.CurveCut.bigPrint", timeout=60_000)
                check("viewer source is lazy (not loaded at start)", page.evaluate(
                    "typeof window.CurveCutAssemblyViewerSource === 'undefined'"))

                # let the app finish warming its engine first, or the load repair can find compute busy
                page.wait_for_function("window.CurveCut.cutFlow.isEngineReady()", timeout=120_000)
                time.sleep(2)
                page.evaluate("""async () => {
                    const CC = window.CurveCut;
                    const buf = await (await fetch('test-assets/3DBenchy.stl')).arrayBuffer();
                    const geometry = new THREE.STLLoader().parse(buf);
                    CC.loadGeometry(geometry, '3DBenchy.stl', { upAxis: 'z' });
                    const t0 = performance.now();
                    while (CC.ops.busy() && performance.now() - t0 < 120000) {
                        await new Promise((r) => setTimeout(r, 200));
                    }
                }""")
                page.evaluate("window.CurveCut.bigPrint.enter()")
                for element_id, value in (("bp-scale", 4), ("bp-bed-w", 120),
                                          ("bp-bed-d", 120), ("bp-bed-h", 120),
                                          ("bp-margin", 5)):
                    page.evaluate(set_input_js(element_id, value))
                page.evaluate("document.getElementById('bp-format').value = 'stl'")
                page.wait_for_function("window.CurveCut.cutFlow.isEngineReady()", timeout=120_000)
                page.wait_for_function("!window.CurveCut.ops.busy()", timeout=120_000)  # the hollow teaser holds the lock briefly
                page.evaluate("window.CurveCut.bigPrint._lastExport = null")

                with page.expect_download(timeout=600_000) as download_info:
                    page.evaluate("document.getElementById('bp-export').click()")
                download = download_info.value
                zip_path = tmp / "benchy.zip"
                download.save_as(zip_path)
                page.wait_for_function("window.CurveCut.bigPrint._lastExport", timeout=600_000)
                export = page.evaluate("""() => {
                    const e = window.CurveCut.bigPrint._lastExport;
                    return { parts: e.parts, assembly: e.assembly || null,
                             source: typeof window.CurveCutAssemblyViewerSource };
                }""")

                names = []
                with zipfile.ZipFile(zip_path) as zf:
                    names = zf.namelist()
                    zf.extractall(tmp / "zip")
                out = tmp / "zip"
                check("A1 zip has assembly.html, manifest.txt, assembly-map.png",
                      all(n in names for n in ("assembly.html", "manifest.txt", "assembly-map.png")),
                      ", ".join(n for n in names if not n.startswith("Part_")))
                check("A2 export reports the assembly ok and the source is now loaded",
                      bool(export["assembly"] and export["assembly"].get("ok"))
                      and export["source"] == "object", str(export))
                manifest = (out / "manifest.txt").read_text(encoding="utf-8") \
                    if (out / "manifest.txt").is_file() else ""
                check("A3 manifest has the 3D assembly view block",
                      "3D assembly view:" in manifest and "assembly.html" in manifest)
                html_path = out / "assembly.html"
                size = html_path.stat().st_size if html_path.is_file() else 0
                a = export["assembly"] or {}
                print(f"     assembly.html: {size:,} bytes, {a.get('parts')} parts, "
                      f"{a.get('tris')} triangles, halved={a.get('halved')}")
                check("A4 assembly.html under 6,000,000 bytes", 0 < size < SIZE_LIMIT)

                if html_path.is_file() and os.environ.get("ASSEMBLY_KEEP_HTML"):
                    shutil.copyfile(html_path, os.environ["ASSEMBLY_KEEP_HTML"])  # for screenshots
                if html_path.is_file():
                    requests.clear()
                    view = context.new_page()
                    view.set_viewport_size({"width": 1000, "height": 700})
                    view.on("pageerror", lambda e: problems.append(f"viewer pageerror: {e}"))
                    view.on("console", lambda m: m.type == "error"
                            and problems.append(f"viewer console: {m.text}"))
                    file_url = html_path.resolve().as_uri()
                    view.goto(file_url, wait_until="load")
                    view.wait_for_function("window.assemblyViewer", timeout=60_000)
                    time.sleep(0.5)

                    want_count = int(re.search(r"Part count: (\d+)", manifest).group(1))
                    table_ids = re.findall(r"^([A-Z]+\d+(?:-L\d+)?) +Part_", manifest, re.M)
                    ids = view.evaluate("window.assemblyViewer.ids()")
                    check("A5 part count and IDs match manifest.txt",
                          view.evaluate("window.assemblyViewer.partCount()") == want_count
                          and len(ids) == len(table_ids) and set(ids) == set(table_ids),
                          f"{len(ids)} viewer, {len(table_ids)} manifest, count {want_count}")

                    picked = None
                    for part_id in ids:
                        pt = view.evaluate(
                            "(id) => window.assemblyViewer.screenPointOf(id)", part_id)
                        if pt:
                            picked = (part_id, pt)
                            break
                    if picked:
                        view.mouse.click(picked[1]["x"], picked[1]["y"])
                        time.sleep(0.3)
                        selected = view.evaluate("window.assemblyViewer.selected()")
                        card = view.evaluate(
                            "document.querySelector('.ccav-card')?.innerText || ''")
                        check("A6 a real click selects the part and shows its ID",
                              selected == picked[0] and picked[0] in card,
                              f"clicked {picked[0]}, selected {selected}")
                    else:
                        check("A6 a real click selects the part and shows its ID", False,
                              "no part had a screen point")

                    outside = [u for u in requests if u != file_url
                               and not u.startswith(("data:", "blob:"))]
                    check("A7 viewer makes no requests beyond its own file", not outside,
                          ", ".join(outside[:3]))
                    check("A9 viewer title names the model", "3DBenchy" in view.title(),
                          view.title())
                check("A8 no console or page errors on either page", not problems,
                      "; ".join(problems[:3]))
            finally:
                browser.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return not fails


def main() -> int:
    ensure_playwright()
    ok = check_viewer_source()
    if not ok:
        return 1
    core = check_test_page()
    if core == 1:
        return 1
    if core == 2:
        return 0
    if not benchy_acceptance():
        print("FAIL: Benchy acceptance failed (lines above)")
        return 1
    print("assembly check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
