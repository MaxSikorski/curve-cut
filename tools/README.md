# tools/ — check scripts and generators

Run every script as `uv run --no-project python tools/<script>.py` (no Node, no venv). Exit 0 = pass; anything else fails and prints the specifics. Every `check_*.py` is part of the full suite (`for f in tools/check_*.py; do uv run --no-project python "$f"; done`).

Browser checks share `browser.py`: Playwright's headless Chromium, real time, a fresh browser per run, pinned to `playwright==1.62.*`. The scripts add Playwright themselves through uv. Install the browser once:

    uv run --no-project --with "playwright==1.62.*" python -m playwright install chromium

Without the browser a check prints SKIPPED with that command; with `CURVECUT_REQUIRE_BROWSER=1` (CI) it fails instead.

## Checks
| Script | What it proves | Weight |
|---|---|---|
| `check_js_syntax.py` | Every `js/*.js` parses | no browser |
| `check_offline.py` | The double-click rule: no external URLs or module scripts, every local reference exists | no browser |
| `check_smoke.py` | The app starts and loads a model with no page errors (`--root DIR` tests another tree, e.g. a release) | fast |
| `check_pen.py`, `check_units.py` | Pen math; units and orientation | fast |
| `check_api.py` | The page API step A1 (`CC.api` reading tools): tool list parses in Python, `tests/api-test.html`, and the real app answers `invoke` | medium |
| `check_hollow_panel.py` | The Hollow panel driven through the real app (preview, Confirm, undo, cancel, saved settings) and Big Print on a confirmed hollow (refusals, size lock, exported hollow parts, manifest, phone and tablet reach) | medium |
| `check_ux_polish.py` | Cut cancellation and recovery; About and tour timing, focus and button labels | medium |
| `check_small_tickets.py` | Pieces zip names, pen-mode camera keys, About version line | medium |
| `check_cut_engine.py`, `check_formats.py`, `check_repair.py`, `check_hollow.py` | Cut engine; OBJ/3MF; mesh repair; hollowing | fast to medium |
| `check_bigprint.py` | Big Print grid math and cell cutter (plus the 6× Benchy acceptance when `test-assets/` has the Benchy) | medium to heavy |
| `check_assembly.py` | The 3D assembly viewer (also runs `embed_viewer.py --check`), plus a real Benchy Big Print export and its `assembly.html` opened from disk when `test-assets/` has the Benchy | medium; heavy with the Benchy |
| `check_compute.py` | The compute worker (also runs `embed_worker.py --check`) | medium |
| `check_memory.py` | Worker memory stats and recycle | heavy |
| `check_property.py` | Random-seed invariants for cuts and hollows | heavy |
| `check_race.py` | Eight operation-coordinator race scenarios (`index.html#racetest`) | heavy |
| `check_perf.py`, `check_perf_medium.py`, `check_perf_real.py` | Speed and memory budgets; `check_perf_real` needs the private large test model, times the Hollow panel (preview, Confirm) on it, strict budgets with `CURVECUT_PERF_STRICT=1` | heavy |
| `check_benchy.py` | 3DBenchy wavy-cut acceptance (needs `test-assets/3DBenchy.stl`) | heavy |

Heavy checks use several CPU cores each: run them one at a time.

## Generators and measuring tools (not checks)
| Script | What it does |
|---|---|
| `embed_worker.py` | Builds `js/compute-worker-src.js` from the worker shell, Manifold and the core engines; `--check` fails if the file is stale |
| `embed_viewer.py` | Builds `js/assembly-viewer-src.js` (three.js, OrbitControls, fflate, the viewer and their licence texts as strings) for `assembly.html`; reads `vendor/`, never changes it; `--check` fails if the file is stale |
| `time_simplify.py` | Times the worker simplify-to-target op (`tests/simplify-timing.html`) and prints the table; not a check, so it stays out of the suite and CI |
| `embed_demo.py` | Embeds the demo model as `assets/demo/voron-cube.stl.b64.js` |
| `vendor_libs.py`, `vendor_manifold.py`, `vendor_hershey.py` | Reproducible vendoring of the libraries in `vendor/` |
