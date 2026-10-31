# tests/ — every test page

Each page loads the real app scripts, runs its checks, writes lines into `<pre id="log">`, and sets `document.title` to `PASS`, `FAIL: <reason>` or `SKIPPED: <reason>`. A runner in `tools/` opens it in Playwright's headless Chromium (`tools/browser.py`) and prints the verdict. Open any page by hand from disk to watch it run.

| Page | Runner | What it proves |
|---|---|---|
| `pen-test.html` | `check_pen.py` | Pen math: smooth handles, corners, point insertion, rigid moves, hit distances |
| `cut-test.html` | `check_cut_engine.py` | Cut engine: spline cuts give watertight pieces with conserved volume |
| `formats-test.html` | `check_formats.py` | OBJ import, 3MF export round trip, basic repair ladder |
| `repair-test.html` | `check_repair.py` | Boundary-loop repair of open meshes, plus old-vs-new weld/loop/repair equivalence |
| `hollow-test.html` | `check_hollow.py` | Hybrid hollowing: wall thickness, watertight shells, honest savings |
| `units-test.html` | `check_units.py` | Units and orientation math |
| `bigprint-test.html` | `check_bigprint.py` | Big Print grid math, the streaming cell cutter, solid blocks and label pads on hollow seams (plus the solid-output golden digest), manifest wording, and the exploded-view proxy target + note wording |
| `compute-test.html` | `check_compute.py` | The compute worker: fused repair, cache tokens, worker cuts match main-thread cuts, cancel, fallback |
| `memory-test.html` | `check_memory.py` | Worker memory stats and the deferred recycle |
| `property-test.html` | `check_property.py` | Random-seed invariants for cuts and hollows (volume, watertightness, kerf) |
| `benchy-test.html` | `check_benchy.py` | Acceptance: 3DBenchy wavy cut, recut, watertight parts (needs `test-assets/3DBenchy.stl`) |
| `bigprint-benchy-test.html` | `check_bigprint.py` | Acceptance: 6× Benchy through grid, kerf, connectors and engraved IDs (needs the Benchy) |

Harnesses inside the app itself (`js/*-hook.js`, run as `index.html#<hash>` from disk or localhost only): `#racetest` → `check_race.py`, `#perftest` → `check_perf.py`, `#perfmed` → `check_perf_medium.py`, `#perfreal` → `check_perf_real.py` (needs the private statue model).

Private models live in `test-assets/`, which is never committed (licences forbid it); checks that need them skip without them.
