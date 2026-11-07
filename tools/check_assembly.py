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

def in_app_route() -> bool:
    """Exercise the app route with a generated, non-private assembly fixture."""
    import base64
    import io
    from playwright.sync_api import Error, sync_playwright

    fails, problems, messages, requests = [], [], [], []

    def check(name, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" — {detail}" if detail else ""))
        if not ok:
            fails.append(name)

    def zipped(html, name="assembly.html", compression=zipfile.ZIP_STORED):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", compression=compression) as zf:
            zf.writestr("Part_A1.stl", b"dummy")
            if name:
                zf.writestr(name, html)
        return buf.getvalue()

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=["--allow-file-access-from-files"])
        except Error as error:
            if "Executable doesn't exist" in str(error):
                skip_or_fail("Playwright's Chromium is not installed")
                return True
            raise
        try:
            context = browser.new_context(accept_downloads=True, viewport={"width": 1280, "height": 800})
            context.add_init_script(FILE_FETCH_SHIM)
            context.add_init_script("try { localStorage.setItem('curvecut-tour', 'done'); } catch (_) {}")
            context.add_init_script("window.showSaveFilePicker = undefined")
            context.on("request", lambda r: requests.append(r.url))
            page = context.new_page()
            page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
            def on_console(m):
                if m.type in ("error", "warning"):
                    messages.append(m.text)
                if m.type == "error":
                    problems.append(f"console: {m.text}")
            page.on("console", on_console)
            page.goto(page_url("index.html"), wait_until="load")
            page.wait_for_function("window.CurveCut && window.CurveCut.bigPrint", timeout=60_000)
            page.wait_for_timeout(2800)  # the donate question opens 2.2 s after load and takes focus
            page.evaluate("() => { const m=document.getElementById('donate-modal'); if (m && getComputedStyle(m).visibility !== 'hidden') document.getElementById('donate-close').click(); }")
            page.wait_for_function("() => { const o=document.getElementById('donate-overlay'); return !o || getComputedStyle(o).visibility === 'hidden'; }", timeout=10_000)
            i0 = page.evaluate("""() => !!window.CurveCut.assembly &&
                document.querySelector('#assembly-open-btn')?.textContent.trim() === 'Open assembly file' &&
                getComputedStyle(document.querySelector('#assembly-open-btn')).visibility === 'visible' &&
                getComputedStyle(document.querySelector('#bp-view-assembly')).display === 'none' &&
                getComputedStyle(document.querySelector('#assembly-overlay')).visibility === 'hidden'""")
            i0 = i0 and page.is_visible('#assembly-open-btn')
            check("I0 start screen and assembly API", i0)
            if not i0:
                return False
            fixture = page.evaluate("""async () => {
                await CutCore.init();
                const min = {x:-150,y:0,z:-100}, size = {x:300,y:200,z:200};
                const grid = {counts:{x:3,y:2,z:2},cuts:{x:[100,200],y:[100],z:[100]}};
                const cells = Array.from(BigPrintCore.gridCells(grid,size,min));
                const col = AssemblyCore.createCollector({candidates:cells.length, simplify:CutCore.simplifyToTarget});
                for (const cell of cells) {
                    if ((cell.ci === 2 && cell.ri === 1 && cell.li === 0) ||
                        (cell.ci === 0 && cell.ri === 0 && cell.li === 1)) { col.skip(); continue; }
                    const geo = new THREE.SphereGeometry(40,64,48).toNonIndexed();
                    geo.translate((cell.x0+cell.x1)/2,(cell.y0+cell.y1)/2,(cell.z0+cell.z1)/2);
                    geo.computeBoundingBox(); const b=geo.boundingBox, c=new THREE.Vector3(); b.getCenter(c);
                    col.add({id:cell.id,cell:{ci:cell.ci,ri:cell.ri,li:cell.li},file:`Part_${cell.id}.stl`,
                        box:{min:b.min.toArray(),max:b.max.toArray()},center:c.toArray(),
                        engraved:false,pegs:null,sockets:null}, geo);
                }
                const result=await col.build({meta:{name:'fixture',exportDate:'2026-11-06T00:00:00.000Z',
                    appVersion:'2.1.0',scale:4,size,gap:0.2,connectors:'none',grid,min},
                    source:{three:'/*three*/',orbit:'/*orbit*/',fflate:'/*fflate*/',core:'/*core*/',
                        viewer:'window.__ccavCanary = true;',licences:'LICENCE TEXT'}});
                if (!result.ok) throw new Error('fixture build failed');
                const bytes=result.bytes; let binary='';
                for (let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
                return {base64:btoa(binary),ids:cells.filter(c => !((c.ci===2&&c.ri===1&&c.li===0)||
                    (c.ci===0&&c.ri===0&&c.li===1))).map(c=>c.id)};
            }""")
            html = base64.b64decode(fixture["base64"])
            ids = fixture["ids"]

            def choose(data=html, name="assembly.html", mime="text/html"):
                page.set_input_files("#assembly-file-input", {"name": name, "mimeType": mime, "buffer": data})

            def opened():
                page.wait_for_function("CurveCut.assembly.isOpen() && !gsap.isTweening(document.querySelector('#assembly-overlay'))", timeout=60_000)

            def closed():
                page.wait_for_function("!CurveCut.assembly.isOpen()", timeout=60_000)

            def escape():
                page.keyboard.press("Escape")
                closed()
                page.wait_for_function("!history.state || !history.state.curvecutAssembly", timeout=60_000)

            requests.clear()
            choose(); opened()
            i1 = page.evaluate("""ids => CurveCut.assembly._handle().partCount() === 10 &&
                JSON.stringify(CurveCut.assembly._handle().ids()) === JSON.stringify(ids) &&
                typeof window.__ccavCanary === 'undefined' && typeof window.CurveCutAssemblyViewerSource === 'undefined'""", ids)
            check("I1 HTML opens without scripts or requests", i1 and not [u for u in requests if not u.startswith(("data:", "blob:"))])
            picked = None
            for part_id in ids:
                point = page.evaluate("id => CurveCut.assembly._handle().screenPointOf(id)", part_id)
                if point:
                    picked = (part_id, point); break
            if picked:
                page.mouse.click(picked[1]["x"], picked[1]["y"])
            check("I2 pointer selects a part", bool(picked) and page.evaluate("id => CurveCut.assembly._handle().selected() === id && document.querySelector('#assembly-overlay .ccav-card').innerText.includes(id)", picked[0] if picked else ""))
            # Focus trap must receive Tab and Shift+Tab despite the window capture listener.
            page.evaluate("""() => { const o=document.querySelector('#assembly-overlay');
                const sel='a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
                window.__assemblyFocus=Array.from(o.querySelectorAll(sel)).filter(e=>e.offsetParent!==null && getComputedStyle(e).visibility!=='hidden');
                window.__assemblyFocus[0].focus(); }""")
            page.keyboard.press('Shift+Tab')
            shift_wrap = page.evaluate("document.activeElement === window.__assemblyFocus[window.__assemblyFocus.length-1]")
            page.keyboard.press('Tab')
            check("I2 Tab and Shift+Tab wrap within overlay", shift_wrap and page.evaluate("document.activeElement === window.__assemblyFocus[0]"))
            page.evaluate("delete window.__assemblyFocus")
            page.evaluate("""() => { const c=document.querySelector('#assembly-mount canvas');
                window.__assemblyContext=c.getContext('webgl2') || c.getContext('webgl'); }""")
            escape()
            page.wait_for_function("window.__assemblyContext.isContextLost()", timeout=60_000)
            check("I3 Escape disposes and restores focus", page.evaluate("""() => {
                const s=CurveCut.assembly._state(), c=document.querySelector('#viewport');
                const gl=c.getContext('webgl2') || c.getContext('webgl');
                return getComputedStyle(document.querySelector('#assembly-overlay')).visibility==='hidden' &&
                    !document.querySelector('#assembly-mount').children.length &&
                    JSON.stringify(s)===JSON.stringify({open:false,mounted:false,offered:false,loading:false}) &&
                    window.__assemblyContext.isContextLost() && gl && !gl.isContextLost() &&
                    document.activeElement===document.querySelector('#assembly-open-btn'); }"""))
            choose(); opened(); page.click('#assembly-close'); closed()
            page.wait_for_function("!history.state || !history.state.curvecutAssembly")
            choose(); opened(); page.evaluate("history.back()"); closed()
            choose(); opened(); escape()
            check("I4 close, Back and Escape", page.evaluate("!CurveCut.assembly.isOpen() && (!history.state || !history.state.curvecutAssembly)"))
            for _ in range(12):
                choose(); opened(); escape()
            check("I5 repeated opens release contexts", not any("Too many active WebGL contexts" in m for m in messages) and page.evaluate("""() => {
                const c=document.querySelector('#viewport'), gl=c.getContext('webgl2')||c.getContext('webgl');
                return gl && !gl.isContextLost() && !document.querySelector('#assembly-mount').children.length; }"""))
            zip_ok = True
            for data in (zipped(html), zipped(html, "MyModel/assembly.html", zipfile.ZIP_DEFLATED)):
                choose(data, "parts.zip", "application/zip"); opened()
                zip_ok = zip_ok and page.evaluate("CurveCut.assembly._handle().partCount() === 10")
                escape()
            check("I6 stored and deflated zips", zip_ok)
            refusal_ok = True
            for data, name, code in ((b'not an assembly', 'part.stl', 'not-assembly'),
                                      (zipped(html, None), 'parts.zip', 'zip-no-assembly'),
                                      (html[:len(html)*3//5], 'assembly.html', 'damaged')):
                page.evaluate("document.querySelector('#toast-live').textContent = ''")
                choose(data, name)
                page.wait_for_function("document.querySelector('#toast-live').textContent.length > 0")
                refusal_ok = refusal_ok and page.evaluate("code => !CurveCut.assembly.isOpen() && document.querySelector('#toast-live').textContent === AssemblyOpenCore.messageFor(code)", code)
            check("I7 refusals are toasts", refusal_ok and not problems)
            page.wait_for_function("CurveCut.cutFlow.isEngineReady() && !CurveCut.ops.busy()", timeout=120_000)
            page.evaluate("CurveCut.loadGeometry(new THREE.BoxGeometry(20,20,20), 'cube.stl')")
            page.wait_for_function("!CurveCut.ops.busy() && CurveCut.pieces.length > 0", timeout=120_000)
            page.wait_for_function("!gsap.isTweening(CurveCut.camera.position)", timeout=60_000)
            before = page.evaluate("""() => { CurveCut.history.capture(); CurveCut.pieces[0].scale.setScalar(2);
                return [CurveCut.pieces[0].scale.x, CurveCut.pieces.length, CurveCut.camera.position.toArray()]; }""")
            page.evaluate("""async b64 => { const bin=atob(b64), b=new Uint8Array(bin.length);
                for(let i=0;i<bin.length;i++) b[i]=bin.charCodeAt(i);
                return CurveCut.assembly.openFile(new File([b], 'assembly.html')); }""", fixture["base64"])
            opened()
            page.keyboard.press('Meta+z'); page.keyboard.press('1')
            drag_blocked = page.evaluate("""() => { const d=new DataTransfer(); d.items.add(new File(['stl'], 'part.stl'));
                const el=document.querySelector('#assembly-overlay'), veil=document.querySelector('#drop-veil');
                el.dispatchEvent(new DragEvent('dragenter',{bubbles:true,cancelable:true,dataTransfer:d}));
                const hiddenOnEnter=!veil.classList.contains('active');
                el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d}));
                return hiddenOnEnter && !veil.classList.contains('active'); }""")
            check("I9 drop is blocked", drag_blocked and page.evaluate("n => CurveCut.pieces.length === n", before[1]))
            escape()
            check("I8 app shortcuts stay blocked", page.evaluate("""before => JSON.stringify([CurveCut.pieces[0].scale.x,
                CurveCut.pieces.length,CurveCut.camera.position.toArray()]) === JSON.stringify(before)""", before))
            page.set_viewport_size({"width":375,"height":812})
            page.evaluate("""async b64 => { const bin=atob(b64), b=Uint8Array.from(bin,c=>c.charCodeAt(0));
                await CurveCut.assembly.openFile(new File([b], 'assembly.html')); }""", fixture["base64"]); opened()
            check("I10 phone layout", page.evaluate("""() => { const o=document.querySelector('#assembly-overlay').getBoundingClientRect(),
                c=document.querySelector('#assembly-close').getBoundingClientRect();
                return o.x===0 && o.y===0 && o.width===375 && o.height===812 &&
                    document.querySelector('#assembly-mount .ccav').classList.contains('ccav-narrow') &&
                    c.width>=44 && c.height>=44 && c.left>=0 && c.right<=375 && c.top>=0 && c.bottom<=812 &&
                    document.documentElement.scrollWidth<=375; }"""))
            escape(); page.set_viewport_size({"width":1280,"height":800})
            page.emulate_media(color_scheme="dark")
            page.wait_for_timeout(500)  # let the app's own colour-scheme listener finish before the test sets a theme
            page.evaluate("document.body.dataset.theme='light'")
            page.evaluate("""async b64 => { const bin=atob(b64), b=Uint8Array.from(bin,c=>c.charCodeAt(0));
                await CurveCut.assembly.openFile(new File([b], 'assembly.html')); }""", fixture["base64"]); opened()
            try: page.wait_for_function("getComputedStyle(document.querySelector('#assembly-mount .ccav')).backgroundColor === 'rgb(245, 245, 247)'", timeout=3000)
            except Error: pass  # a colour fade can lag a frame; the check below reports the value
            light = page.evaluate("getComputedStyle(document.querySelector('#assembly-mount .ccav')).backgroundColor")
            page.evaluate("document.body.dataset.theme='dark'")
            try: page.wait_for_function("getComputedStyle(document.querySelector('#assembly-mount .ccav')).backgroundColor === 'rgb(0, 0, 0)'", timeout=3000)
            except Error: pass
            dark = page.evaluate("getComputedStyle(document.querySelector('#assembly-mount .ccav')).backgroundColor")
            check("I11 app theme overrides OS", light == "rgb(245, 245, 247)" and dark == "rgb(0, 0, 0)")
            escape()
            page.click('#new-btn')
            page.wait_for_function("!CurveCut.ops.busy() && CurveCut.pieces.length === 0", timeout=120_000)
            page.evaluate("CurveCut.loadGeometry(new THREE.BoxGeometry(60,60,60), 'cube.stl')")
            page.wait_for_function("!CurveCut.ops.busy() && CurveCut.pieces.length > 0", timeout=120_000)
            for _ in range(40):  # a load's automatic repair holds the op lock and refuses an early enter
                page.wait_for_function("!CurveCut.ops.busy()", timeout=120_000)
                page.evaluate("CurveCut.bigPrint.enter()")
                if page.evaluate("!!CurveCut.bigPrintActive"): break
                page.wait_for_timeout(500)
            page.evaluate("""() => { const connectors=document.querySelector('#bp-connectors'); connectors.checked=false;
                connectors.dispatchEvent(new Event('change',{bubbles:true}));
                for(const [id,value] of [['bp-bed-w',40],['bp-bed-d',40],['bp-bed-h',40],['bp-margin',2]]) {
                    const el=document.getElementById(id); el.value=value; el.dispatchEvent(new Event('input',{bubbles:true})); }
                document.querySelector('#bp-engrave').checked=false; document.querySelector('#bp-format').value='stl';
                CurveCut.bigPrint._lastExport=null; }""")
            page.wait_for_function("CurveCut.cutFlow.isEngineReady() && !CurveCut.ops.busy()", timeout=120_000)
            with page.expect_download(timeout=600_000):
                page.click('#bp-export')
            page.wait_for_function("CurveCut.bigPrint._lastExport && !CurveCut.ops.busy()", timeout=600_000)
            offered = page.evaluate("CurveCut.bigPrint._lastExport.assembly?.ok && getComputedStyle(document.querySelector('#bp-view-assembly')).display !== 'none'")
            page.click('#bp-view-assembly'); opened()
            equal = page.evaluate("""() => { const e=CurveCut.bigPrint._lastExport, h=CurveCut.assembly._handle(),
                a=h.ids(), b=e.rows.map(r=>r.id); return h.partCount()===e.parts && a.length===b.length &&
                a.every(id=>b.includes(id)); }""")
            escape()
            remains = page.evaluate("CurveCut.bigPrintActive && CurveCut.assembly._state().offered && document.activeElement === document.querySelector('#bp-view-assembly')")
            page.click('#bp-view-assembly'); opened(); escape(); page.click('#bp-cancel')
            check("I12 real export offer and lifetime", offered and equal and remains and page.evaluate("!CurveCut.bigPrintActive && !CurveCut.assembly._state().offered && getComputedStyle(document.querySelector('#bp-view-assembly')).display === 'none'"))
            check("in-app route has no page or console errors", not problems, '; '.join(problems[:3]))
        finally:
            browser.close()
    return not fails


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
                context.add_init_script("try { localStorage.setItem('curvecut-tour', 'done'); } catch (_) {}")
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

                    # The app must mount the exported bytes, then release its WebGL context.
                    shown = page.is_visible('#bp-view-assembly')
                    if shown:
                        page.evaluate("() => { const m=document.getElementById('donate-modal'); if (m && getComputedStyle(m).visibility !== 'hidden') document.getElementById('donate-close').click(); }")
                        page.wait_for_function("() => getComputedStyle(document.getElementById('donate-overlay')).visibility === 'hidden' || !document.getElementById('donate-overlay').classList.contains('active')", timeout=10_000)
                        page.click('#bp-view-assembly')
                        page.wait_for_function("CurveCut.assembly.isOpen() && !gsap.isTweening(document.querySelector('#assembly-overlay'))", timeout=60_000)
                        app_ids = page.evaluate('CurveCut.assembly._handle().ids()')
                        check("A10 app export view matches manifest", page.evaluate('CurveCut.assembly._handle().partCount()') == want_count and len(app_ids) == len(table_ids) and set(app_ids) == set(table_ids))
                        page.evaluate("""() => {const c=document.querySelector('#assembly-mount canvas');
                            window.__assemblyContext=c.getContext('webgl2')||c.getContext('webgl');}""")
                        page.keyboard.press('Escape')
                        page.wait_for_function('!CurveCut.assembly.isOpen() && window.__assemblyContext.isContextLost()')
                        check("A11 Escape releases viewer but keeps Big Print", page.evaluate("""() => CurveCut.bigPrintActive &&
                            !document.querySelector('#assembly-mount').children.length && window.__assemblyContext.isContextLost() &&
                            document.activeElement===document.querySelector('#bp-view-assembly')"""))
                    else:
                        check("A10 app export view matches manifest", False, 'View assembly is not displayed')
                        check("A11 Escape releases viewer but keeps Big Print", False, 'view unavailable')

                    fresh = context.new_page()
                    fresh.on('pageerror', lambda e: problems.append(f'app open pageerror: {e}'))
                    fresh.on('console', lambda m: m.type == 'error' and problems.append(f'app open console: {m.text}'))
                    fresh.goto(page_url('index.html'), wait_until='load')
                    fresh.wait_for_function('window.CurveCut && CurveCut.assembly', timeout=60_000)
                    requests.clear()
                    reopened = True
                    for path in (html_path, zip_path):
                        fresh.set_input_files('#assembly-file-input', str(path))
                        fresh.wait_for_function("CurveCut.assembly.isOpen() && !gsap.isTweening(document.querySelector('#assembly-overlay'))", timeout=60_000)
                        got_ids = fresh.evaluate('CurveCut.assembly._handle().ids()')
                        reopened = reopened and fresh.evaluate('CurveCut.assembly._handle().partCount()') == want_count and len(got_ids) == len(table_ids) and set(got_ids) == set(table_ids)
                        picked_app = None
                        for part_id in got_ids:
                            pt = fresh.evaluate('id => CurveCut.assembly._handle().screenPointOf(id)', part_id)
                            if pt:
                                picked_app = (part_id, pt); break
                        if picked_app:
                            fresh.mouse.click(picked_app[1]['x'], picked_app[1]['y'])
                            reopened = reopened and fresh.evaluate('id => CurveCut.assembly._handle().selected() === id', picked_app[0])
                        else:
                            reopened = False
                        fresh.keyboard.press('Escape')
                        fresh.wait_for_function('!CurveCut.assembly.isOpen() && (!history.state || !history.state.curvecutAssembly)')
                    check('A12 open exported HTML and zip in the app', reopened)
                    outside_app = [u for u in requests if not u.startswith(('data:', 'blob:'))]
                    check('A13 app open route stays offline and source stays lazy', not outside_app and fresh.evaluate("typeof window.CurveCutAssemblyViewerSource === 'undefined'"), ', '.join(outside_app[:3]))
                    page.click('#bp-cancel')
                    check('A14 leaving Big Print clears the offered bytes', page.evaluate('!CurveCut.assembly._state().offered'))
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
    if core == 2:
        return 0
    route_ok = in_app_route()
    benchy_ok = benchy_acceptance()
    if core == 1 or not route_ok or not benchy_ok:
        print("FAIL: assembly check failed (lines above)")
        return 1
    print("assembly check ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
