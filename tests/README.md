# tests/ — every test page

Each page loads the real app scripts, runs its checks, writes lines into `<pre id="log">`, and sets `document.title` to `PASS`, `FAIL: <reason>` or `SKIPPED: <reason>`. A runner in `tools/` opens it in Playwright's headless Chromium (`tools/browser.py`) and prints the verdict. Open any page by hand from disk to watch it run.

| Page | Runner | What it proves |
|---|---|---|
| `pen-test.html` | `check_pen.py` | Pen math: smooth handles, corners, point insertion, rigid moves, hit distances |
| `cut-test.html` | `check_cut_engine.py` | Cut engine: spline cuts give watertight pieces with conserved volume |
| `formats-test.html` | `check_formats.py` | OBJ import, 3MF export round trip, basic repair ladder |
| `repair-test.html` | `check_repair.py` | Boundary-loop repair of open meshes, plus old-vs-new weld/loop/repair equivalence |
| `hollow-test.html` | `check_hollow.py` | Hybrid hollowing: wall thickness, watertight shells, honest savings, open faces and drilled holes (T1-T17, including the unchanged-output digest guard), and T18-T20: raw grid-audit goldens, the flat edge table against the old reference, the 2.2 M-triangle audit, and glow swatch geometry |
| `hollow-panel-test.html` | `check_hollow_panel.py` | The Hollow panel in the real app (P0-P14: Lamp preset, worker preview, Out of date, Confirm and undo, gates, grid-too-large message, Escape cancel, saved settings) + Big Print with a confirmed hollow (B0–B9, B3b): refusals, size lock, hollow parts and manifest, solid blocks, out-of-date, Hollow… opener, glow swatch, phone and tablet reach |
| `units-test.html` | `check_units.py` | Units and orientation math |
| `bigprint-test.html` | `check_bigprint.py` | Big Print grid math, wall lists (auto/hand, reset rules) and the nudge clamp, the streaming cell cutter, solid blocks and label pads on hollow seams (plus the solid-output golden digest), manifest wording incl. open faces, holes and part sizes, and the exploded-view proxy target + note wording |
| `bigprint-panel-test.html` | `check_bigprint_panel.py` | The Big Print panel in the real app (F3 Size and Scale agree, F4 nudge limits, F6 part sizes in the manifest, F9 peg note, F10 connector and ID plan) |
| `assembly-test.html` | `check_assembly.py` | 3D assembly viewer: neighbours, per-part triangle targets, mesh pack/unpack, collector, the file text, the 6 MB cap and its halve, manifest note, and the viewer mounted in a plain div (select, tap vs drag, explode, layout, dispose) |
| `compute-test.html` | `check_compute.py` | The compute worker: fused repair, cache tokens, worker cuts match main-thread cuts, cancel, fallback, and hollowApply carrying open faces and holes on worker and fallback (C1-C3) |
| `memory-test.html` | `check_memory.py` | Worker memory stats and the deferred recycle |
| `property-test.html` | `check_property.py` | Random-seed invariants for cuts and hollows (volume, watertightness, kerf) |
| `api-test.html` | `check_api.py` | Page API step A1 (`CC.api`): measure vs Manifold, section profile finds a dumbbell's neck, diagnosis, `look` PNG is the asked size and not blank with no WebGL leak; the check also parses `js/ai-tools.js` in Python and drives the real `index.html` |
| `benchy-test.html` | `check_benchy.py` | Acceptance: 3DBenchy wavy cut, recut, watertight parts (needs `test-assets/3DBenchy.stl`) |
| `bigprint-benchy-test.html` | `check_bigprint.py` | Acceptance: 6× Benchy through grid, kerf, connectors and engraved IDs (needs the Benchy) |

Harnesses inside the app itself (`js/*-hook.js`, run as `index.html#<hash>` from disk or localhost only): `#racetest` → `check_race.py`, `#perftest` → `check_perf.py`, `#perfmed` → `check_perf_medium.py`, `#perfreal` → `check_perf_real.py` (needs the private large test model).

Private models live in `test-assets/`, which is never committed (licences forbid it); checks that need them skip without them.
