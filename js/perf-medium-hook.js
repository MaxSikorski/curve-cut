/* Curve Cut — medium-model performance harness (v2.1a perf lane)
   Runs ONLY when the page is opened as index.html#perfmed (real-time headless,
   via tools/check_perf_medium.py — NOT virtual time: frame timing needs real
   rAF cadence). Drives the production path at Max's felt scale: a ~380k-tri
   model (below the 500k simplify threshold, like a 10-100MB STL), watertight
   check, curve cut, then an orbiting-camera frame-time sample. Reports in
   document.title:
   "PERFMED load=<ms> wt=<ms> cut=<ms> favg=<ms> fp95=<ms> heap=<MB>"
   Inert for normal users. */

(() => {
    "use strict";

    // dev-only: never let the public site URL + #perfmed run a heavy benchmark
    const isDev = location.protocol === "file:" ||
        location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (window.location.hash !== "#perfmed" || !isDev) return;
    const CC = window.CurveCut;

    const once = (evt) => new Promise((resolve) =>
        window.addEventListener(evt, resolve, { once: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = (test, label, timeout = 60000) => new Promise((resolve, reject) => {
        const started = performance.now();
        const poll = () => {
            if (test()) { resolve(); return; }
            if (performance.now() - started >= timeout) {
                reject(new Error(`timed out waiting for ${label}`));
                return;
            }
            setTimeout(poll, 25);
        };
        poll();
    });

    let stage = "start";

    (async () => {
        try {
            stage = "wasm-init";
            await CutCore.init();

            // ~380k triangles, unindexed like a parsed STL — below the
            // simplify offer, the size band Max reports as sluggish
            stage = "load";
            const knot = new THREE.TorusKnotGeometry(60, 20, 950, 200).toNonIndexed();
            const t0 = performance.now();
            CC.loadGeometry(knot, "perf-medium.stl");
            const loadMs = performance.now() - t0;

            // the load path schedules an async watertight check on meshes this
            // size — time the same engine call directly so the cost is visible
            stage = "watertight";
            const t1 = performance.now();
            CutCore.isWatertight(CC.pieces[0].geometry);
            const wtMs = performance.now() - t1;
            await sleep(800); // let the scheduled on-load check settle too
            stage = "ops-idle";
            await waitFor(() => !CC.ops.busy(), "load operations to end");

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
            window.dispatchEvent(new CustomEvent("curvecut:spline-ready"));
            const t2 = performance.now();
            const cutDone = once("curvecut:pieces-changed");
            document.getElementById("cut-apply").click();
            await cutDone;
            const cutMs = performance.now() - t2;
            if (CC.pieces.length !== 2) throw new Error(`expected 2 pieces, got ${CC.pieces.length}`);

            // spin both pieces for 240 frames; the app's own tick() renders —
            // we just sample rAF deltas while the scene changes every frame
            // (OrbitControls damping owns the camera, so rotate the model)
            stage = "orbit";
            const deltas = [];
            await new Promise((resolve) => {
                let last = null, n = 0;
                const angle0 = performance.now();
                (function sample(ts) {
                    if (last !== null) deltas.push(ts - last);
                    last = ts;
                    const a = (ts - angle0) / 1000;
                    for (const p of CC.pieces) p.rotation.y = a;
                    if (++n < 240) requestAnimationFrame(sample);
                    else resolve();
                })(performance.now());
            });
            deltas.sort((a, b) => a - b);
            const favg = deltas.reduce((s, d) => s + d, 0) / deltas.length;
            const fp95 = deltas[Math.floor(deltas.length * 0.95)];

            stage = "measure";
            await sleep(300);
            if (window.gc) { window.gc(); await sleep(200); }
            const heapMB = performance.memory
                ? performance.memory.usedJSHeapSize / 1048576 : -1;
            document.title = `PERFMED load=${Math.round(loadMs)} wt=${Math.round(wtMs)}`
                + ` cut=${Math.round(cutMs)} favg=${favg.toFixed(1)} fp95=${fp95.toFixed(1)}`
                + ` heap=${heapMB.toFixed(1)}`;
        } catch (err) {
            document.title = `PERFMED FAIL at ${stage}: ${err.message}`;
        }
    })();
})();
