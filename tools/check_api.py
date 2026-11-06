#!/usr/bin/env python3
"""check_api.py — the page API (CC.api), step A1: reading and seeing.

Three parts:
  1. js/ai-tools.js parses in Python (first line stripped, rest is JSON) and
     has the expected eight tools.
  2. tests/api-test.html runs the real analysis-core.js / api.js headlessly
     (demo cube vs Manifold, dumbbell neck, look PNG, bad arguments).
  3. The real index.html answers CC.api.invoke (status, list_pieces, measure,
     look, set_view) with the app's own renderer and camera.

Run:  uv run --no-project python tools/check_api.py
"""

import json
import sys

from browser import ROOT, ensure_playwright, page_url, run_page, skip_or_fail

REAL_TIME_LIMIT_S = 90
FIRST_LINE = "window.CurveCutTools ="
EXPECTED = ["status", "list_pieces", "measure", "section_profile",
            "diagnose_mesh", "look", "set_view", "list_printers"]

APP_PROBE = """(async () => {
  const CC = window.CurveCut, out = {};
  let contexts = 0;
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...r) { if (/webgl/.test(t)) contexts++; return real.call(this, t, ...r); };
  out.hasApi = !!(CC && CC.api);
  CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(), "probe-cube.stl");
  await new Promise(r => setTimeout(r, 200));
  const t0 = performance.now();
  while (CC.ops.busy() && performance.now() - t0 < 45000) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 1500)); // let the load-time camera flight land
  out.status = await CC.api.invoke("status");
  out.pieces = await CC.api.invoke("list_pieces");
  out.measure = await CC.api.invoke("measure", {printer: "ender 3"});
  const camBefore = CC.camera.position.clone();
  const seen = await CC.api.invoke("look", {size: 256});
  out.look = {width: seen.width, height: seen.height, bytes: seen.png.$bytes.length};
  out.cameraMovedByLook = CC.camera.position.distanceTo(camBefore) > 1e-9;
  out.contextsByLook = contexts;
  out.sv = await CC.api.invoke("set_view", {view: "top"});
  await new Promise(r => setTimeout(r, 1500));
  const p = CC.camera.position, c = CC.controls.target;
  out.topDown = (p.y - c.y) > 5 * Math.hypot(p.x - c.x, p.z - c.z);
  out.badView = await CC.api.invoke("set_view", {view: "sideways"}).then(() => "accepted", e => e.message);
  return out;
})()"""


def check_tool_list() -> list[str]:
    fails = []
    text = (ROOT / "js" / "ai-tools.js").read_text()
    first, _, rest = text.partition("\n")
    if first.strip() != FIRST_LINE:
        return [f"ai-tools.js first line is {first!r}, expected {FIRST_LINE!r}"]
    try:
        data = json.loads(rest.strip().rstrip(";"))
    except json.JSONDecodeError as e:
        return [f"ai-tools.js is not JSON after the first line: {e}"]
    names = [t.get("name") for t in data.get("tools", [])]
    if names != EXPECTED:
        fails.append(f"tool names {names} != {EXPECTED}")
    for t in data.get("tools", []):
        if not t.get("description") or t.get("parameters", {}).get("type") != "object":
            fails.append(f"{t.get('name')}: needs a description and an object schema")
    print(f"tool list parses in Python: {len(names)} tools" if not fails else "tool list FAILED")
    return fails


def check_real_app() -> list[str]:
    ensure_playwright()
    from playwright.sync_api import Error, sync_playwright

    errors, fails = [], []
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except Error as e:
            if "Executable doesn't exist" in str(e):
                skip_or_fail("Playwright's Chromium is not installed")
                return []
            raise
        try:
            page = browser.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(page_url("index.html"))
            page.wait_for_function("window.CurveCut && window.CurveCut.api", timeout=60000)
            out = page.evaluate(APP_PROBE)
        finally:
            browser.close()

    def need(name, ok, detail=""):
        print(f"{'ok  ' if ok else 'FAIL'} app: {name}{' — ' + detail if detail and not ok else ''}")
        if not ok:
            fails.append(name)

    need("CC.api is loaded by index.html", out["hasApi"])
    need("status sees the loaded cube", out["status"]["pieces"] == 1 and out["status"]["busy"] is None,
         json.dumps(out["status"]))
    need("list_pieces gives p1 of 20 mm", out["pieces"][0]["id"] == "p1" and out["pieces"][0]["size_mm"] == [20, 20, 20])
    need("measure: cube fits an Ender 3", out["measure"]["pieces"][0]["fits_bed"] is True
         and out["measure"]["pieces"][0]["watertight"] is True)
    need("look at 256 px", out["look"]["width"] == 256 and out["look"]["height"] == 256 and out["look"]["bytes"] > 1000)
    need("look leaves the person's camera alone", out["cameraMovedByLook"] is False)
    need("look makes no WebGL context", out["contextsByLook"] == 0, str(out["contextsByLook"]))
    need("set_view top flies the camera overhead", out["sv"]["ok"] is True and out["topDown"] is True)
    need("set_view refuses an unknown view", "one of" in out["badView"], out["badView"])
    need("no page errors", not errors, "; ".join(errors[:3]))
    return fails


def main() -> int:
    fails = check_tool_list()

    result = run_page(page_url("tests/api-test.html"), REAL_TIME_LIMIT_S)
    if result.skipped:
        return skip_or_fail(result.skipped)
    if result.log:
        print(result.log)
    if result.title != "PASS":
        result.print_errors()
        fails.append(f"api test page: {result.title}" + (" (timed out)" if result.timed_out else ""))

    fails += check_real_app()
    if fails:
        print("FAIL: " + "; ".join(fails))
        return 1
    print("api check ok — A1 reading tools pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
