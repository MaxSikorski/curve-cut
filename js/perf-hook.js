/* Curve Cut — performance harness (v1.2)
   Runs ONLY when the page is opened as index.html#perftest (headless, via
   tools/check_perf.py). Drives the real production path end to end:
   generate a ~600k-triangle model -> accept the simplify offer -> straight
   cut -> undo -> redo, then reports memory + timing in document.title:
   "PERF heap=<MB> total=<ms> pieces=<n>". Inert for normal users. */

(() => {
    "use strict";

    if (window.location.hash !== "#perftest") return;
    const CC = window.CurveCut;

    const once = (evt) => new Promise((resolve) =>
        window.addEventListener(evt, resolve, { once: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    let stage = "start";

    (async () => {
        const t0 = performance.now();
        try {
            stage = "wasm-init";
            await CutCore.init();

            // ~600k-triangle model, unindexed like a parsed STL
            stage = "load";
            const torus = new THREE.TorusKnotGeometry(60, 20, 1500, 200).toNonIndexed();
            CC.loadGeometry(torus, "perf-torus.stl"); // opens the simplify modal (>500k)

            stage = "simplify";
            const simplified = once("curvecut:pieces-changed");
            document.getElementById("simplify-go").click();
            await simplified;

            // straight cut through the middle, via the real preview + apply path
            stage = "cut";
            const c = CC.getModelCenter();
            const V = (x, y, z) => new THREE.Vector3(x, y, z);
            CC.spline = {
                points: [
                    { a: V(c.x, c.y + 500, c.z), hIn: null, hOut: null },
                    { a: V(c.x, c.y - 500, c.z), hIn: null, hOut: null },
                ],
                normal: V(0, 0, 1),
                planePoint: c,
            };
            window.dispatchEvent(new CustomEvent("curvecut:spline-ready")); // sync: preview + tint
            const cutDone = once("curvecut:pieces-changed");
            document.getElementById("cut-apply").click();
            await cutDone;
            if (CC.pieces.length !== 2) throw new Error(`expected 2 pieces, got ${CC.pieces.length}`);

            stage = "undo-redo";
            CC.history.undo();
            CC.history.redo();

            stage = "measure";
            await sleep(500);
            if (window.gc) { window.gc(); await sleep(200); }
            const heapMB = performance.memory
                ? performance.memory.usedJSHeapSize / 1048576 : -1;
            document.title =
                `PERF heap=${heapMB.toFixed(1)} total=${Math.round(performance.now() - t0)} pieces=${CC.pieces.length}`;
        } catch (err) {
            document.title = `PERF FAIL at ${stage}: ${err.message}`;
        }
    })();
})();
