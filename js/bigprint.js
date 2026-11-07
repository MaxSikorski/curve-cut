/* Curve Cut — Big Print mode UI (v2.0)
   Scale panel (printer presets, margin, size ⇄ multiplier), live part
   estimate, translucent grid preview, and the streaming Cut & Export
   pipeline (per-cell cut → connectors → engraving → zip). */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const Core = window.BigPrintCore;

    const panel = document.getElementById("bigprint-panel");
    const panelCollapse = CC.makeCollapsible(panel); // pop-down chevron (feature #15)
    const actionDock = document.getElementById("action-dock");
    const viewDock = document.getElementById("view-dock");
    const piecesPanel = document.getElementById("pieces-panel");
    const printerSelect = document.getElementById("bp-printer");
    const bedW = document.getElementById("bp-bed-w");
    const bedD = document.getElementById("bp-bed-d");
    const bedH = document.getElementById("bp-bed-h");
    const marginInput = document.getElementById("bp-margin");
    const fullVolume = document.getElementById("bp-full-volume");
    const fullVolumeNote = document.getElementById("bp-full-volume-note");
    const nudgeRange = document.getElementById("bp-nudge-range");
    const scaleSlider = document.getElementById("bp-scale-slider");
    const scaleInput = document.getElementById("bp-scale");
    const sizeInput = document.getElementById("bp-size");
    const nudgeX = document.getElementById("bp-nudge-x");
    const nudgeY = document.getElementById("bp-nudge-y");
    const nudgeZ = document.getElementById("bp-nudge-z");
    const hollowNote = document.getElementById("bp-hollow-note");
    const hollowOpenBtn = document.getElementById("bp-hollow-open");
    const status = document.getElementById("bp-status");
    const exportBtn = document.getElementById("bp-export");
    const statsReset = document.getElementById("stats-reset");
    const WARN_CELL_COUNT = 512;
    const HARD_CELL_COUNT = 4096;
    const PRINT_MANIFOLD_IDLE_TIMEOUT = 1000;
    const CONFIRM_MS = 5000;

    let confirmCount = 0;
    let confirmUntil = 0;
    let confirmTimer = null;

    function resetExportConfirmation() {
        confirmCount = 0;
        confirmUntil = 0;
        clearTimeout(confirmTimer);
        confirmTimer = null;
        exportBtn.textContent = "Cut & Export";
    }

    function armExportConfirmation(count) {
        resetExportConfirmation();
        confirmCount = count;
        confirmUntil = Date.now() + CONFIRM_MS;
        exportBtn.textContent = `Really export ${count.toLocaleString()} parts?`;
        confirmTimer = setTimeout(resetExportConfirmation, CONFIRM_MS);
    }

    let active = false;
    let model = null;          // the single piece Big Print scales
    let baseSize = null;       // THREE.Vector3, unscaled model dimensions
    let scale = 1;
    let exportCompleted = false;
    let gridGroup = null;      // THREE.Group of preview planes
    let layout = null;         // last Core.resolveLayout result (wall lists + auto/hand modes)
    let grid = null;           // layout.grid
    let printManifoldCache = null; // panel owns it; invalidation retires borrowed entries
    let printManifoldWarm = null;
    let printManifoldWarmCancelSerial = 0;
    let hollowComputeCache = null;
    let hollowComputeJob = null;
    let hollowComputeReleasePromise = null;
    let hollowComputeBuildPromise = null;
    let repairPrimeTask = null;
    let hollowComputeSerial = 0;
    let hollowLocked = false;  // a hollow model's size is locked at 1x
    let piecesWasVisible = false;

    const OUT_OF_DATE = "This hollow changed after you confirmed it (for example simplified or repaired). "
        + "Undo (⌘Z) back to the confirmed hollow, or undo the hollow and hollow again.";
    const LOCK_TITLE = "Size is locked on a hollow model: undo the hollow (⌘Z) to change it.";
    const scaleTitles = new Map([scaleInput, scaleSlider, sizeInput].map((el) => [el, el.title]));

    // "none" | "confirmed" | "out-of-date" (the memory test loads this file without hollow.js)
    function hollowStatus(mesh) { return CC.hollow ? CC.hollow.status(mesh) : "none"; }
    const isHollow = (mesh) => !!(mesh && mesh.userData.hollow);
    const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

    /* A one-part export is only "sealed" when nothing was opened or drilled. */
    function sealedHollow(mesh) {
        if (hollowStatus(mesh) !== "confirmed") return false;
        const receipt = mesh.userData.hollow;
        const opened = (receipt.openFaces || []).some((face) => face.opened === true);
        return !opened && !((receipt.holes && receipt.holes.count) || 0);
    }

    // ------------------------------------------------------------ presets

    (function fillPresets() {
        const brands = new Map();
        Core.PRINTERS.forEach((p, i) => {
            if (!brands.has(p.brand)) {
                const og = document.createElement("optgroup");
                og.label = p.brand;
                printerSelect.appendChild(og);
                brands.set(p.brand, og);
            }
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = `${p.model} — ${p.w}×${p.d}×${p.h}`;
            brands.get(p.brand).appendChild(opt);
        });
        const custom = document.createElement("option");
        custom.value = "custom";
        custom.textContent = "Custom bed size…";
        printerSelect.appendChild(custom);
    })();

    function applyPreset() {
        const v = printerSelect.value;
        if (v !== "custom") {
            const p = Core.PRINTERS[parseInt(v, 10)];
            bedW.value = p.w; bedD.value = p.d; bedH.value = p.h;
        }
        refresh();
    }

    // Hand-editing the bed switches the dropdown to Custom.
    for (const el of [bedW, bedD, bedH]) {
        el.addEventListener("input", () => { printerSelect.value = "custom"; refresh(); });
    }
    printerSelect.addEventListener("change", applyPreset);

    // ------------------------------------------------------- scale linking

    const MIN_SCALE = 0.01, MAX_SCALE = 100;
    const fmtScale = (k) => String(+k.toFixed(4));
    const fmtMm = Core.fmtMm;
    let scaleClamp = null; // "min" / "max" when the last accepted entry hit a limit

    function setScale(k, from) {
        if (hollowLocked) { k = 1; from = undefined; } // rewrite all three boxes
        // 0, negative or half-typed values are ignored; the boxes are rewritten on commit
        if (!(k > 0) || !Number.isFinite(k)) return;
        scaleClamp = k < MIN_SCALE ? "min" : k > MAX_SCALE ? "max" : null;
        const nextScale = Math.min(Math.max(k, MIN_SCALE), MAX_SCALE);
        const scaleChanged = Math.abs(nextScale - scale) > 1e-9;
        if (scaleChanged) {
            cancelRepairPrimeTask();
            disposePrintManifoldCache();
        }
        scale = nextScale;
        if (from !== "scale") scaleInput.value = fmtScale(scale);
        if (from !== "slider") scaleSlider.value = Math.min(scale, parseFloat(scaleSlider.max));
        if (from !== "size") sizeInput.value = fmtMm(Core.targetForScale(longestSide(), scale));
        refitCamera();
        refresh();
        schedulePrintManifoldWarm();
    }

    /* The camera was framed for the 1× model — zoom out as the model grows
       so a 4× scale doesn't swallow the viewpoint. */
    function refitCamera() {
        const center = new THREE.Vector3(0, (baseSize.y * scale) / 2, 0);
        const radius = (baseSize.length() * scale) / 2;
        const dist = radius / Math.tan((CC.camera.fov * Math.PI / 180) / 2) * 1.35;
        CC.camera.far = Math.max(CC.camera.far, dist * 50);
        CC.camera.updateProjectionMatrix();
        const dir = CC.camera.position.clone().sub(CC.controls.target).normalize();
        const dest = center.clone().addScaledVector(dir, dist);
        gsap.to(CC.camera.position, { x: dest.x, y: dest.y, z: dest.z, duration: 0.5, ease: "power2.out" });
        gsap.to(CC.controls.target, { x: center.x, y: center.y, z: center.z, duration: 0.5, ease: "power2.out" });
    }

    const longestSide = () => Math.max(baseSize.x, baseSize.y, baseSize.z);

    scaleSlider.addEventListener("input", () => setScale(parseFloat(scaleSlider.value), "slider"));
    scaleInput.addEventListener("input", () => setScale(parseFloat(scaleInput.value), "scale"));
    sizeInput.addEventListener("input", () =>
        setScale(Core.scaleForTarget(longestSide(), parseFloat(sizeInput.value)), "size"));
    // Enter or leaving a box: both boxes show the scale that is really used, and a limit says so
    function commitScaleFields() {
        if (!active || !model) return;
        scaleInput.value = fmtScale(scale);
        sizeInput.value = fmtMm(Core.targetForScale(longestSide(), scale));
        if (scaleClamp) {
            const mm = fmtMm(longestSide() * (scaleClamp === "min" ? MIN_SCALE : MAX_SCALE));
            CC.toast(scaleClamp === "min"
                ? `Smallest scale is ${MIN_SCALE}× — ${mm} mm is the smallest size for this model.`
                : `Largest scale is ${MAX_SCALE}× — ${mm} mm is the largest size for this model.`);
            scaleClamp = null;
        }
    }
    for (const el of [scaleInput, sizeInput]) {
        el.addEventListener("change", commitScaleFields);
        el.addEventListener("blur", commitScaleFields);
    }

    for (const el of [marginInput, fullVolume, nudgeX, nudgeY, nudgeZ]) {
        el.addEventListener("input", refresh);
    }
    // A nudge past the "no extra parts" window is cut at the window edge, so show
    // that: on Enter or blur the box is rewritten to the nudge that is really used.
    // The window edges are rounded inward to 0.01 so the box never shows a value past the real limit.
    const formatNudge = (v) => String(+v.toFixed(2));
    // what the box shows for the nudge the grid uses: a window end is written as its inward edge
    const shownNudge = (axis) => {
        const v = layout.nudge[axis];
        if (Math.abs(v - layout.window[axis].hi) < 1e-9) return formatNudge(windowEdge(axis, "hi"));
        if (Math.abs(v - layout.window[axis].lo) < 1e-9) return formatNudge(windowEdge(axis, "lo"));
        return formatNudge(v);
    };
    const windowEdge = (axis, end) => end === "hi"
        ? Math.floor(layout.window[axis].hi * 100 + 1e-6) / 100
        : Math.ceil(layout.window[axis].lo * 100 - 1e-6) / 100;
    for (const [axis, el] of [["x", nudgeX], ["y", nudgeY], ["z", nudgeZ]]) {
        const snap = () => {
            if (!active || explodeGroup || !layout || layout.mode[axis] !== "auto") return;
            const typed = parseFloat(el.value) || 0;
            if (!Number.isFinite(parseFloat(el.value))) { // emptied: show the nudge that is used
                el.value = shownNudge(axis);
                refresh();
                return;
            }
            const edge = typed > windowEdge(axis, "hi") ? windowEdge(axis, "hi")
                : typed < windowEdge(axis, "lo") ? windowEdge(axis, "lo") : null;
            if (edge !== null) {
                el.value = formatNudge(edge);
                refresh();
            } else if (shownNudge(axis) !== formatNudge(typed)) {
                el.value = shownNudge(axis);
                refresh();
            }
        };
        el.addEventListener("change", snap);
        el.addEventListener("blur", snap);
    }

    function printManifoldTarget() {
        return {
            model,
            geometry: model.geometry,
            scale,
        };
    }

    function samePrintManifoldTarget(left, right) {
        return left && right && left.model === right.model
            && left.geometry === right.geometry
            && Math.abs(left.scale - right.scale) <= 1e-9;
    }

    function currentPrintManifoldTarget(target) {
        if (!active || model !== target.model || model.geometry !== target.geometry) return false;
        return Math.abs(scale - target.scale) <= 1e-9;
    }

    function cancelPrintManifoldWarmTask(warm) {
        if (warm.idleHandle !== null) {
            if (typeof window.cancelIdleCallback === "function") {
                window.cancelIdleCallback(warm.idleHandle);
            }
            warm.idleHandle = null;
        }
        clearTimeout(warm.timer);
        warm.timer = null;
        clearTimeout(warm.retryTimer);
        warm.retryTimer = null;
    }

    function cancelRepairPrimeTask() {
        const task = repairPrimeTask;
        if (!task) return;
        if (task.idleHandle !== null) {
            if (typeof window.cancelIdleCallback === "function") {
                window.cancelIdleCallback(task.idleHandle);
            }
            task.idleHandle = null;
        }
        clearTimeout(task.timer);
        clearTimeout(task.retryTimer);
        repairPrimeTask = null;
    }

    function settlePrintManifoldWarm(warm, result) {
        if (!warm.resolve) return;
        const resolve = warm.resolve;
        warm.resolve = null;
        resolve(result);
    }

    function cancelPrintManifoldWarmRecord(warm) {
        if (!warm) return;
        cancelPrintManifoldWarmTask(warm);
        if (location.hash === "#racetest" && warm.resolve) printManifoldWarmCancelSerial++;
        settlePrintManifoldWarm(warm, null);
        if (printManifoldWarm === warm) printManifoldWarm = null;
    }

    function cancelPrintManifoldWarm() {
        cancelPrintManifoldWarmRecord(printManifoldWarm);
    }

    function clearPrintManifoldCache() {
        const cache = printManifoldCache;
        if (!cache) return;
        printManifoldCache = null;
        cache.retired = true;
        if (!cache.borrowCount && !cache.deleted) {
            cache.manifold.delete();
            cache.deleted = true;
        }
    }

    function borrowPrintManifold(cache) {
        cache.borrowCount++;
        return cache;
    }

    function releasePrintManifold(cache) {
        cache.borrowCount--;
        if (cache.retired && cache.borrowCount === 0 && !cache.deleted) {
            cache.manifold.delete();
            cache.deleted = true;
        }
    }

    function computeWorkerPath() {
        return !!(CC.compute && !CC.compute.degraded);
    }

    function sameHollowComputeTarget(left, right) {
        return left && right && left.model === right.model
            && left.geometry === right.geometry
            && Math.abs(left.scale - right.scale) <= 1e-9;
    }

    function validHollowComputeCache(target) {
        return computeWorkerPath() && hollowComputeCache
            && sameHollowComputeTarget(hollowComputeCache, target)
            && hollowComputeCache.ready && !hollowComputeCache.retired
            && hollowComputeCache.worker === CC.compute._worker;
    }

    function releaseHollowComputeCache(cache) {
        if (!cache || !cache.retired || cache.borrowCount || !cache.ready
            || cache.releaseRequested) return;
        cache.releaseRequested = true;
        let promise;
        try {
            promise = CC.compute.run("release", { token: cache.token });
        } catch (_) {
            cache.releaseRequested = false;
            cache.releaseTimer = setTimeout(() => {
                cache.releaseTimer = null;
                releaseHollowComputeCache(cache);
            }, 100);
            return;
        }
        cache.releasePromise = promise.catch((error) => {
            if (CC.compute.degraded) return;
            console.warn("Hollow compute cache release failed:", error);
        });
        const releasePromise = cache.releasePromise;
        const combinedRelease = releasePromise.finally(() => {
            if (hollowComputeReleasePromise === combinedRelease) {
                hollowComputeReleasePromise = null;
            }
        });
        hollowComputeReleasePromise = combinedRelease;
    }

    function clearHollowComputeCache() {
        const cache = hollowComputeCache;
        if (!cache) return;
        hollowComputeCache = null;
        cache.retired = true;
        releaseHollowComputeCache(cache);
    }

    async function runHollowComputeJob(op, payload, options, kind) {
        const promise = CC.compute.run(op, payload, options || {});
        const job = { id: promise.id, kind };
        hollowComputeJob = job;
        try {
            return await promise;
        } finally {
            if (hollowComputeJob === job) hollowComputeJob = null;
        }
    }

    function cancelPrintManifoldWarmCompute() {
        const job = hollowComputeJob;
        if (!job || job.kind !== "bigprint-warm" || !computeWorkerPath()) return false;
        return CC.compute.cancel(job.id);
    }

    async function ensureHollowComputeCache(target, kind) {
        if (!computeWorkerPath()) return null;
        const ready = await CC.compute.ready();
        if (!ready || CC.compute.degraded) return null;
        const currentWorker = CC.compute._worker;
        if (hollowComputeReleasePromise) await hollowComputeReleasePromise;
        if (hollowComputeCache && sameHollowComputeTarget(hollowComputeCache, target)
            && !hollowComputeCache.retired
            && hollowComputeCache.worker === currentWorker) {
            if (hollowComputeCache.ready) return hollowComputeCache;
            if (hollowComputeCache.primePromise) return hollowComputeCache.primePromise;
        }
        if (hollowComputeBuildPromise) await hollowComputeBuildPromise;
        if (!computeWorkerPath()) return null;
        if (hollowComputeCache && sameHollowComputeTarget(hollowComputeCache, target)
            && hollowComputeCache.ready && !hollowComputeCache.retired
            && hollowComputeCache.worker === CC.compute._worker) {
            return hollowComputeCache;
        }
        clearHollowComputeCache();
        const cache = Object.assign({}, target, {
            token: target.token || `hollow-${++hollowComputeSerial}`,
            ready: false,
            retired: false,
            borrowCount: 0,
            releaseRequested: false,
            releasePromise: null,
            releaseTimer: null,
            worker: CC.compute._worker,
            primePromise: null,
        });
        hollowComputeCache = cache;
        const build = (async () => {
            try {
                const geometry = await CC.compute.geometryPayloadAsync(target.geometry);
                await runHollowComputeJob("prime", {
                    token: cache.token, geometry, scale: target.scale,
                }, {
                    transfer: [geometry.vertProperties.buffer, geometry.triVerts.buffer],
                }, kind);
                cache.ready = true;
                if (cache.retired || hollowComputeCache !== cache
                    || cache.worker !== CC.compute._worker) {
                    releaseHollowComputeCache(cache);
                    return null;
                }
                return cache;
            } catch (error) {
                cache.ready = true;
                cache.retired = true;
                if (hollowComputeCache === cache) hollowComputeCache = null;
                releaseHollowComputeCache(cache);
                throw error;
            }
        })();
        cache.primePromise = build;
        const gate = build.then(
            () => undefined,
            () => undefined);
        hollowComputeBuildPromise = gate;
        gate.then(() => {
            if (hollowComputeBuildPromise === gate) hollowComputeBuildPromise = null;
        });
        return build;
    }

    function releaseWorkerCacheToken(detail) {
        if (!detail || typeof detail.token !== "string" || !CC.compute
            || (detail.worker && detail.worker !== CC.compute._worker && !CC.compute.degraded)) return;
        try { CC.compute.run("release", { token: detail.token }); } catch (_) {}
    }

    function currentRepairPrimeTask(task) {
        return repairPrimeTask === task && CC.pieces[0] === task.model
            && task.model.geometry === task.geometry;
    }

    function adoptHollowComputeCache(detail) {
        if (!detail || typeof detail.token !== "string" || !detail.model
            || !detail.geometry || CC.pieces[0] !== detail.model) {
            releaseWorkerCacheToken(detail);
            return false;
        }
        if (!computeWorkerPath()
            || (detail.worker && detail.worker !== CC.compute._worker)) {
            releaseWorkerCacheToken(detail);
            return false;
        }
        cancelRepairPrimeTask();
        clearPrintManifoldCache();
        clearHollowComputeCache();
        const install = () => {
            if (CC.pieces[0] !== detail.model || detail.model.geometry !== detail.geometry) {
                releaseWorkerCacheToken(detail);
                return;
            }
            hollowComputeCache = Object.assign({}, detail, {
                ready: true,
                retired: false,
                borrowCount: 0,
                releaseRequested: false,
                releasePromise: null,
                releaseTimer: null,
                worker: CC.compute._worker,
                primePromise: null,
            });
        };
        if (hollowComputeReleasePromise) {
            hollowComputeReleasePromise.then(install, install);
        } else install();
        return true;
    }

    function scheduleRepairPrime(detail) {
        if (!detail || typeof detail.token !== "string" || !detail.model
            || !detail.geometry || !computeWorkerPath()) return;
        cancelRepairPrimeTask();
        const task = Object.assign({}, detail, {
            idleHandle: null, timer: null, retryTimer: null,
        });
        repairPrimeTask = task;
        const run = () => {
            task.idleHandle = null;
            task.timer = null;
            if (!currentRepairPrimeTask(task)) {
                if (repairPrimeTask === task) repairPrimeTask = null;
                return;
            }
            if (CC.ops.busy()) {
                task.retryTimer = setTimeout(() => {
                    task.retryTimer = null;
                    run();
                }, 100);
                return;
            }
            sanctionedHollowCache({
                model: task.model, geometry: task.geometry, scale: 1, token: task.token,
            }, "repair-prime", "Preparing hollow…").then((cache) => {
                if (!cache && currentRepairPrimeTask(task)) {
                    console.warn("Repair cache prime unavailable");
                }
                if (repairPrimeTask === task) repairPrimeTask = null;
            }, (error) => {
                if (currentRepairPrimeTask(task)) {
                    console.warn("Repair cache prime unavailable:", error);
                }
                if (repairPrimeTask === task) repairPrimeTask = null;
            });
        };
        if (typeof window.requestIdleCallback === "function") {
            task.idleHandle = window.requestIdleCallback(run, { timeout: 1000 });
        } else {
            task.timer = setTimeout(run, 50);
        }
    }

    async function sanctionedHollowCache(target, kind, label) {
        let op = null;
        if (!CC.ops.busy()) {
            op = CC.ops.begin(kind);
            if (!op) return null;
            CC.progress.show(label);
        }
        try {
            return await ensureHollowComputeCache(target, kind);
        } finally {
            if (op) {
                CC.progress.hide();
                CC.ops.end(op);
            }
        }
    }

    function disposePrintManifoldCache() {
        cancelPrintManifoldWarm();
        clearPrintManifoldCache();
        clearHollowComputeCache();
    }

    function createPrintManifoldWarm(target, worker = false) {
        const warm = Object.assign({}, target, {
            idleHandle: null,
            timer: null,
            retryTimer: null,
            started: false,
            worker,
            manifold: null,
            error: null,
            resolve: null,
        });
        warm.promise = new Promise((resolve) => { warm.resolve = resolve; });
        printManifoldWarm = warm;
        return warm;
    }

    function buildPrintManifold(warm) {
        const target = warm;
        if (warm.started) {
            if (warm.error) throw warm.error;
            return warm.manifold;
        }
        warm.started = true;

        let base = null;
        try {
            base = CutCore.toManifold(target.geometry);
            let source = base;
            if (Math.abs(target.scale - 1) > 1e-9) {
                source = base.transform(new THREE.Matrix4()
                    .makeScale(target.scale, target.scale, target.scale).elements);
                base.delete();
                base = null;
            }
            if (!currentPrintManifoldTarget(target)) {
                source.delete();
                cancelPrintManifoldWarmTask(warm);
                settlePrintManifoldWarm(warm, null);
                if (printManifoldWarm === warm) printManifoldWarm = null;
                return null;
            }
            printManifoldCache = {
                model: target.model, geometry: target.geometry, scale: target.scale,
                manifold: source,
                borrowCount: 0,
                retired: false,
                deleted: false,
            };
            warm.manifold = source;
            cancelPrintManifoldWarmTask(warm);
            settlePrintManifoldWarm(warm, source);
            if (printManifoldWarm === warm) printManifoldWarm = null;
            return source;
        } catch (error) {
            if (base) base.delete();
            warm.error = error;
            cancelPrintManifoldWarmTask(warm);
            settlePrintManifoldWarm(warm, null);
            if (printManifoldWarm === warm) printManifoldWarm = null;
            throw error;
        }
    }

    /* Hollow models: the solid outer shape the connector blocks and label pads
       are placed from (solidGeometry, recorded when the hollow was confirmed). It
       is built, cut into one thin slab per seam plane (one plane per tick, so the
       pill moves and Stop works), and dropped again. Only one copy of it is alive
       at a time. A hollow model is always at scale 1 here, so no scale transform.
       Returns null (and warns) when it can't be built, or when shouldStop() says
       so. */
    async function buildOuterContext(solidGeometry, g, min, conn, gap, shouldStop, what) {
        let outer = null;
        let ctx = null;
        try {
            outer = CutCore.toManifold(solidGeometry);
            ctx = CutCore.createOuterContext(outer, [], { conn, gap });
            const planes = Core.seamPlanes(g, min);
            for (const [k, plane] of planes.entries()) {
                CC.progress.update(`Preparing ${what}… (${k + 1} of ${planes.length})`, k / planes.length);
                await new Promise((r) => setTimeout(r));
                if (shouldStop()) throw new Error("stopped");
                CutCore.addOuterPlane(ctx, outer, plane);
            }
            const done = ctx;
            ctx = null;
            return done;
        } catch (err) {
            if (err.message !== "stopped") console.warn("connector blocks skipped:", err);
            return null;
        } finally {
            if (ctx) CutCore.disposeOuterContext(ctx);
            if (outer) outer.delete();
        }
    }

    function retryPrintManifoldWarm(warm) {
        if (warm.retryTimer !== null) return;
        warm.retryTimer = setTimeout(() => {
            warm.retryTimer = null;
            runPrintManifoldWarm(warm);
        }, 100);
    }

    function buildPrintManifoldInOp(warm) {
        const op = CC.ops.begin("bigprint-warm");
        if (!op) return false;
        CC.progress.show("Preparing Big Print…");
        try {
            buildPrintManifold(warm);
        } catch (error) {
            console.warn("Big Print manifold warm unavailable:", error);
        } finally {
            CC.progress.hide();
            CC.ops.end(op);
        }
        return true;
    }

    function currentPrintManifoldWarm(warm) {
        return printManifoldWarm === warm && !isHollow(warm.model)
            && currentPrintManifoldTarget(warm);
    }

    function runPrintManifoldWarm(warm) {
        if (!currentPrintManifoldWarm(warm)) {
            cancelPrintManifoldWarmRecord(warm);
            return;
        }
        if (warm.worker) {
            warm.started = true;
            sanctionedHollowCache(warm, "bigprint-warm", "Preparing Big Print…").then((cache) => {
                if (!cache || !currentPrintManifoldWarm(warm)) {
                    cancelPrintManifoldWarmRecord(warm);
                    return;
                }
                settlePrintManifoldWarm(warm, cache);
                if (printManifoldWarm === warm) {
                    printManifoldWarm = null;
                    const mainWarm = createPrintManifoldWarm(warm);
                    queuePrintManifoldWarm(mainWarm);
                }
            }, (error) => {
                cancelPrintManifoldWarmRecord(warm);
                console.warn("Big Print compute warm unavailable:", error);
                if (!computeWorkerPath()) schedulePrintManifoldWarm();
            });
            return;
        }
        if (!CutCore.isReady()) {
            retryPrintManifoldWarm(warm);
            return;
        }
        if (CC.ops.busy()) {
            retryPrintManifoldWarm(warm);
            return;
        }
        if (!buildPrintManifoldInOp(warm)) retryPrintManifoldWarm(warm);
    }

    function queuePrintManifoldWarm(warm) {
        if (!currentPrintManifoldWarm(warm)) {
            cancelPrintManifoldWarmRecord(warm);
            return;
        }
        if (warm.started) return;
        if (typeof window.requestIdleCallback === "function") {
            warm.idleHandle = window.requestIdleCallback(() => {
                warm.idleHandle = null;
                runPrintManifoldWarm(warm);
            }, { timeout: PRINT_MANIFOLD_IDLE_TIMEOUT });
        } else {
            warm.timer = setTimeout(() => {
                warm.timer = null;
                runPrintManifoldWarm(warm);
            }, 50);
        }
    }

    function schedulePrintManifoldWarm() {
        if (!active || !model || isHollow(model)) {
            cancelPrintManifoldWarm();
            return;
        }
        const target = printManifoldTarget();
        if (computeWorkerPath()) {
            if (printManifoldCache && !samePrintManifoldTarget(printManifoldCache, target)) {
                clearPrintManifoldCache();
            }
            if (printManifoldCache) return;
            if (printManifoldWarm && samePrintManifoldTarget(printManifoldWarm, target)) return;
            if (validHollowComputeCache(target)) {
                cancelPrintManifoldWarm();
                const warm = createPrintManifoldWarm(target);
                queuePrintManifoldWarm(warm);
                return;
            }
            cancelPrintManifoldWarm();
            clearHollowComputeCache();
            const warm = createPrintManifoldWarm(target, true);
            queuePrintManifoldWarm(warm);
            return;
        }
        clearHollowComputeCache();
        if (printManifoldCache && !samePrintManifoldTarget(printManifoldCache, target)) {
            clearPrintManifoldCache();
        }
        if (printManifoldCache || (printManifoldWarm
            && samePrintManifoldTarget(printManifoldWarm, target))) return;
        cancelPrintManifoldWarm();
        const warm = createPrintManifoldWarm(target);
        queuePrintManifoldWarm(warm);
    }

    async function manifoldForPrint() {
        const target = printManifoldTarget();
        if (printManifoldCache && !samePrintManifoldTarget(printManifoldCache, target)) {
            clearPrintManifoldCache();
        }
        if (printManifoldCache) return borrowPrintManifold(printManifoldCache);
        if (printManifoldWarm && !samePrintManifoldTarget(printManifoldWarm, target)) {
            cancelPrintManifoldWarm();
        }
        let warm = printManifoldWarm;
        if (!warm) {
            warm = createPrintManifoldWarm(target);
        }
        if (warm.worker && !validHollowComputeCache(target)) {
            cancelPrintManifoldWarmCompute();
            cancelPrintManifoldWarmRecord(warm);
            warm = createPrintManifoldWarm(target);
        }
        if (!warm.started) {
            cancelPrintManifoldWarmTask(warm);
            if (warm.worker) {
                runPrintManifoldWarm(warm);
            } else {
                if (!CutCore.isReady()) {
                    settlePrintManifoldWarm(warm, null);
                    if (printManifoldWarm === warm) printManifoldWarm = null;
                    throw new Error("Hollow engine is not ready");
                }
                if (CC.ops.busy()) buildPrintManifold(warm);
                else if (!buildPrintManifoldInOp(warm)) {
                    settlePrintManifoldWarm(warm, null);
                    if (printManifoldWarm === warm) printManifoldWarm = null;
                }
            }
        }
        const source = await warm.promise;
        if (!source && warm.error) throw warm.error;
        if (warm.worker) {
            if (!source) return null;
            return manifoldForPrint();
        }
        if (!source || !printManifoldCache || printManifoldCache.manifold !== source) return null;
        return borrowPrintManifold(printManifoldCache);
    }

    // ------------------------------------------------------- grid preview

    function removeGrid() {
        if (!gridGroup) return;
        CC.scene.remove(gridGroup);
        gridGroup.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        gridGroup = null;
    }

    function params() {
        return {
            size: { x: baseSize.x * scale, y: baseSize.y * scale, z: baseSize.z * scale },
            bed: {
                w: parseFloat(bedW.value) || 0,
                d: parseFloat(bedD.value) || 0,
                h: parseFloat(bedH.value) || 0,
            },
            margin: Math.max(parseFloat(marginInput.value) || 0, 0),
            reserve: fullVolume.checked ? 0 : pegReach(),
            nudge: {
                x: parseFloat(nudgeX.value) || 0,
                y: parseFloat(nudgeY.value) || 0,
                z: parseFloat(nudgeZ.value) || 0,
            },
        };
    }

    /* How far a connector peg stands past its part's face (0 with connectors
       off). Same formula as the export's conn.depth; computeGrid shrinks cut
       axes by it so a part plus its pegs stays inside bed minus margin. */
    /* The connector size and tolerance the export uses (size at least 2 mm, tolerance not below 0);
       the plan sentence reads the same numbers. */
    function connLimits() {
        return {
            size: Math.max(parseFloat(connSize.value) || 4, 2),
            tol: Math.max(parseFloat(connTol.value) || 0, 0),
        };
    }
    function connDepth(sizeValue) {
        return Math.max((parseFloat(sizeValue) || 4) * 0.8, 2);
    }
    function pegReach() {
        const box = document.getElementById("bp-connectors");
        const size = document.getElementById("bp-conn-size");
        return box && box.checked && size ? connDepth(size.value) : 0;
    }

    function updateConnNote() {
        const note = document.getElementById("bp-conn-note");
        if (!note) return;
        const wanted = active && model && (connBox.checked || engraveBox.checked);
        if (wanted && hollowStatus(model) === "confirmed") {
            note.textContent = "Hollow model: each connector and ID label gets a small solid block inside the shell "
                + "so it has plastic to grip (a little extra material). The finish message says "
                + "how many seams and parts got one.";
        } else if (active && model && grid) {
            // solid model: say what the export will do before it runs
            const shape = connShape.selectedOptions[0] ? connShape.selectedOptions[0].textContent.toLowerCase() : connShape.value;
            const pegs = Core.cellCount(grid) === 1 ? "One part: no seams, so no connectors."
                : connBox.checked
                    ? `Will add ${shape} pegs and sockets (${formatNudge(connLimits().size)} mm, `
                        + `tolerance ${formatNudge(connLimits().tol)} mm) on every seam with room; exact counts after export.`
                    : "No connectors: parts will need glue only.";
            note.textContent = pegs + " " + (engraveBox.checked
                ? "Part IDs will be engraved on each part where there is room." : "No part IDs engraved.");
        } else {
            note.textContent = "";
        }
        note.hidden = !note.textContent;
    }

    /* The note under Scale, the Hollow… button, and the size lock all follow
       the model's hollow status. */
    function syncHollowRow() {
        const state = hollowStatus(model);
        const receipt = model.userData.hollow;
        hollowLocked = state !== "none";
        hollowNote.textContent = state === "none"
            ? "Solid model. To hollow it: set the final size with Units on the main page, then Hollow…. "
                + "A hollow model's size is locked."
            : state === "confirmed"
                ? `${cap(CC.hollow.describe(receipt))} · saves ${receipt.savedPct.toFixed(1)}% · `
                    + "size locked: undo the hollow (⌘Z) to change it."
                : OUT_OF_DATE;
        hollowOpenBtn.hidden = state !== "none";
        for (const el of [scaleInput, scaleSlider, sizeInput]) {
            el.disabled = hollowLocked;
            el.title = hollowLocked ? LOCK_TITLE : scaleTitles.get(el);
        }
        if (hollowLocked && Math.abs(scale - 1) > 1e-9) setScale(1);
        updateConnNote();
    }

    function refresh() {
        if (!active || explodeGroup) return; // frozen while exploded
        resetExportConfirmation();
        fullVolumeNote.hidden = !(fullVolume.checked && connBox.checked);
        model.scale.setScalar(scale);
        const p = params();
        layout = Core.resolveLayout(layout, p);
        grid = layout ? layout.grid : null;
        updateConnNote();
        removeGrid();

        if (!grid) {
            status.classList.remove("warning");
            status.textContent = p.reserve > 0
                ? "The margin and connector pegs eat the whole bed — shrink the margin or the connector size."
                : "The margin eats the whole bed — shrink one of them.";
            exportBtn.disabled = true;
            return;
        }

        // Scaled model sits centered on X/Z, floor at Y=0 (loadGeometry seats it).
        const min = {
            x: -p.size.x / 2,
            y: 0,
            z: -p.size.z / 2,
        };
        gridGroup = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({
            color: CC.cutFlow.RIBBON_COLOR, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthWrite: false,
        });
        const over = 1.04; // slight overhang so planes read past the silhouette
        const addPlane = (w, h, place) => {
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * over, h * over), mat);
            place(mesh);
            gridGroup.add(mesh);
        };
        for (const t of grid.cuts.x) addPlane(p.size.z, p.size.y, (m) => {
            m.rotation.y = Math.PI / 2;
            m.position.set(min.x + t, p.size.y / 2, 0);
        });
        for (const t of grid.cuts.y) addPlane(p.size.x, p.size.z, (m) => {
            m.rotation.x = -Math.PI / 2;
            m.position.set(0, t, 0);
        });
        for (const t of grid.cuts.z) addPlane(p.size.x, p.size.y, (m) => {
            m.position.set(0, p.size.y / 2, min.z + t);
        });
        CC.scene.add(gridGroup);

        const c = grid.counts;
        const count = Core.cellCount(grid);
        const story = Core.partStory(count, sealedHollow(model));
        status.textContent =
            `Final ${fmtMm(p.size.x)} × ${fmtMm(p.size.z)} × ${fmtMm(p.size.y)} mm` +
            ` · grid ${c.x}×${c.z}×${c.y}` +
            ` · up to ${count.toLocaleString()} part${count === 1 ? "" : "s"}` +
            story.statusSuffix;
        status.classList.toggle("warning", count > WARN_CELL_COUNT);
        exportBtn.disabled = false;

        // Nudge range is the window where no extra part appears (whole mm for the spinner).
        const ranges = [];
        let rewrote = false;
        for (const [axis, label, el] of [["x", "W", nudgeX], ["z", "D", nudgeZ], ["y", "H", nudgeY]]) {
            const lo = windowEdge(axis, "lo") || 0, hi = windowEdge(axis, "hi") || 0;
            el.min = lo;
            el.max = hi;
            ranges.push(layout.mode[axis] === "auto" && hi - lo > 0
                ? `${label} −${formatNudge(-lo)}…+${formatNudge(hi)}` : `${label} fixed`);
            // a bed/printer/scale change can shrink the window under a typed value
            if (layout.mode[axis] === "auto" && document.activeElement !== el
                && shownNudge(axis) !== formatNudge(parseFloat(el.value) || 0)) {
                el.value = shownNudge(axis);
                rewrote = true;
            }
        }
        nudgeRange.textContent = `Range ${ranges.join(" · ")} mm`;
        if (rewrote) refresh(); // the grid uses exactly the value now shown
    }

    // ------------------------------------------------------------ mode flow

    function enter() {
        if (active) return;
        if (!CC.getModel()) return;
        if (CC.ops.busy()) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }
        if (CC.pieces.length !== 1) {
            CC.toast("Big Print slices the whole model — use it before other cuts.");
            return;
        }
        if (CC.hollow && CC.hollow.isOpen()) {
            CC.toast("Hollow isn't confirmed yet: Confirm it in the Hollow panel, or Cancel it to print the model solid.");
            return;
        }
        if (hollowStatus(CC.pieces[0]) === "out-of-date") {
            CC.toast(OUT_OF_DATE);
            return;
        }
        cancelPrintManifoldWarm();
        clearPrintManifoldCache();
        active = true;
        layout = null;
        CC.bigPrintActive = true;
        document.body.classList.add("bigprint-active");
        exportCompleted = false;
        model = CC.pieces[0];
        model.geometry.computeBoundingBox();
        baseSize = new THREE.Vector3();
        model.geometry.boundingBox.getSize(baseSize);
        scale = 1;

        printerSelect.value = "0";
        applyPreset();
        marginInput.value = 5;
        fullVolume.checked = false;
        nudgeX.value = 0; nudgeY.value = 0; nudgeZ.value = 0;
        syncHollowRow();
        setScale(scale);

        // the Pieces panel yields to this panel (it would cover the fields on a phone)
        piecesWasVisible = window.getComputedStyle(piecesPanel).visibility !== "hidden";
        gsap.killTweensOf([actionDock, piecesPanel]); // a load's still-running fade-in must not win
        gsap.to([actionDock, piecesPanel], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        panelCollapse.reset(); // Big Print re-entry always starts expanded
        gsap.fromTo(panel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out" });
        // dowel-ish connector default, proportional to the printable room
        // (bed minus margin, before pegs reserve their share), set before the
        // first refresh because the peg depth shrinks the grid cells
        const p0 = params();
        const room = Math.min(p0.bed.w, p0.bed.d, p0.bed.h) - 2 * p0.margin;
        const u = room > 0 ? room : 200;
        document.getElementById("bp-conn-size").value =
            Math.round(Math.min(Math.max(u * 0.05, 4), 12));
        refresh();
    }

    function recordBakedScale(piece, keptScale) {
        if (Math.abs(keptScale - 1) <= 1e-9) return;
        piece.userData.bakedScale = (piece.userData.bakedScale || 1) * keptScale;
    }

    function showModelStats(piece) {
        piece.geometry.computeBoundingBox();
        const size = new THREE.Vector3();
        piece.geometry.boundingBox.getSize(size);
        const index = piece.geometry.getIndex();
        const tris = (index ? index.count : piece.geometry.attributes.position.count) / 3;
        CC.showStats(piece.userData.sourceName || piece.name, tris, size);
    }

    function exit(modelLoaded = false) {
        if (!active) return;
        gsap.killTweensOf(panel);
        resetExportConfirmation();
        disposePrintManifoldCache();
        active = false;
        CC.bigPrintActive = false;
        document.body.classList.remove("bigprint-active");
        disposeProxies();
        removeGrid();
        layout = null;
        if (!modelLoaded && !exportCompleted) {
            // a confirmed hollow is the model's own state: leaving never touches it
            const restoredScale = Math.abs(scale - 1) > 1e-9;
            scale = 1;
            model.scale.setScalar(1);
            if (restoredScale) CC.toast("Big Print cancelled — model restored.");
            CC.flyHome();
            showModelStats(model);
        } else if (!modelLoaded && exportCompleted) {
            const keptScale = scale;
            if (Math.abs(keptScale - 1) > 1e-9) {
                // bake into a copy: the old geometry may be the solid shape a confirmed hollow recorded
                const baked = model.geometry.clone();
                baked.scale(keptScale, keptScale, keptScale);
                const previous = model.geometry;
                model.geometry = baked;
                previous.dispose(); // GPU copy only; the arrays stay readable
                model.geometry.computeBoundingBox();
                baseSize.multiplyScalar(keptScale);
                scale = 1;
                model.scale.setScalar(1);
            }
            recordBakedScale(model, keptScale);
            if (Math.abs(keptScale - 1) > 1e-9) {
                window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                    { detail: { source: "bigprint-export-scale" } }));
            }
            showModelStats(model);
        }
        model = null;
        gsap.to(panel, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        gsap.fromTo([viewDock, actionDock], { y: 10 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
        if (piecesWasVisible && CC.pieces.length) {
            gsap.to(piecesPanel, { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
        }
    }

    function resetImportScale() {
        if (CC.ops.busy()) {
            CC.toast("An operation is still running — reset the scale when it finishes.");
            return;
        }
        if (active) {
            CC.toast("Exit Big Print before resetting the scale.");
            return;
        }
        if (CC.pieces.length !== 1 || !CC.pieces[0].userData.bakedScale) return;
        if (CC.pieces[0].userData.hollow) {
            CC.toast("The size is locked on a hollow model: undo the hollow (⌘Z) first.");
            return;
        }

        const piece = CC.pieces[0];
        disposePrintManifoldCache();

        CC.history.capture();
        const geometry = piece.geometry.clone();
        const k = piece.userData.bakedScale;
        geometry.scale(1 / k, 1 / k, 1 / k);
        geometry.computeBoundingBox();

        const next = new THREE.Mesh(geometry, piece.material);
        next.name = piece.name;
        next.visible = piece.visible;
        next.userData = Object.assign({}, piece.userData);
        delete next.userData.bakedScale;

        CC.scene.remove(piece);
        CC.scene.add(next);
        CC.pieces[0] = next;
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
            { detail: { source: "scale-reset" } }));
        showModelStats(next);
        CC.toast("Restored to imported size — 1×.");
    }

    // ------------------------------------------------------- cut & export

    const gapInput = document.getElementById("bp-gap");
    const connBox = document.getElementById("bp-connectors");
    const connShape = document.getElementById("bp-conn-shape");
    const connSize = document.getElementById("bp-conn-size");
    const connTol = document.getElementById("bp-conn-tol");
    const engraveBox = document.getElementById("bp-engrave");
    const cancelBtn = document.getElementById("bp-cancel");
    // connectors change the cell size (pegs reserve room), so re-grid
    connBox.addEventListener("change", () => { refresh(); updateConnNote(); });
    connSize.addEventListener("input", refresh);
    connSize.addEventListener("change", updateConnNote);
    for (const el of [connShape, connTol]) {
        el.addEventListener("input", updateConnNote);
        el.addEventListener("change", updateConnNote);
    }
    engraveBox.addEventListener("change", updateConnNote);

    let running = false;
    let cancelled = false;

    // ------------------------------------------------------- exploded view
    // Real part geometry streams away during export, so the viewer keeps
    // stand-ins up to a hard 1.5M-triangle budget — the ≤250 MB heap rule
    // outranks completeness on 1,000-part jobs. Each part's target is what is
    // left of the budget split across the candidate cells still to come
    // (floor(left / cells), never under 3k tris), so empty cells and parts that
    // came in small hand their share to later ones: parts at or under the
    // target stay at full detail, bigger ones are simplified to it. Few big
    // parts look smooth; 1,000 parts stay at ~3k.

    const explodeBtn = document.getElementById("bp-explode");
    const explodeRow = document.getElementById("bp-explode-row");
    const explodeAmt = document.getElementById("bp-explode-amt");
    const explodeNote = document.getElementById("bp-explode-note");
    const PROXY_TRI_BUDGET = 1500000;
    const PROXY_TARGET = 3000;

    let proxies = [];         // { geometry, center, id, mesh? }
    let proxyTris = 0;
    let proxyTruncated = false;
    let proxySimplified = false; // true once any stand-in was decimated
    let proxyFirstTarget = PROXY_TARGET; // the first part's target, for tests
    let explodeGroup = null;

    function collectProxy(geo, id, target) {
        if (proxyTruncated) return;
        const tris = geo.getIndex().count / 3;
        let g;
        try {
            g = tris > target ? CutCore.simplifyToTarget(geo, target) : geo.clone();
        } catch (err) { return; } // display-only — never fail the export over it
        const kept = g.getIndex() ? g.getIndex().count / 3 : 0;
        if (proxyTris + kept > PROXY_TRI_BUDGET) {
            g.dispose();
            proxyTruncated = true;
            return;
        }
        proxyTris += kept;
        g.computeBoundingBox();
        const center = new THREE.Vector3();
        g.boundingBox.getCenter(center);
        if (tris > target) proxySimplified = true;
        proxies.push({ geometry: g, center, id });
    }

    function disposeProxies() {
        exitExplode();
        for (const p of proxies) p.geometry.dispose();
        proxies = [];
        proxyTris = 0;
        proxyTruncated = false;
        proxySimplified = false;
        proxyFirstTarget = PROXY_TARGET;
        explodeBtn.style.display = "none";
    }

    function updateExplode() {
        const k = parseFloat(explodeAmt.value) || 0;
        const origin = new THREE.Vector3(0, (baseSize.y * scale) / 2, 0);
        for (const p of proxies) {
            if (!p.mesh) continue;
            const o = Core.explodedPosition(p.center, origin, k);
            p.mesh.position.set(o.x, o.y, o.z);
        }
    }

    function enterExplode() {
        if (!proxies.length || explodeGroup) return;
        model.visible = false;
        removeGrid();
        explodeGroup = new THREE.Group();
        proxies.forEach((p, i) => {
            // piece-color exception (HANDOFF §4 #10): parts read at a glance
            const mat = CC.baseMaterial.clone();
            mat.color = new THREE.Color().setHSL((i * 0.137) % 1, 0.42, 0.62);
            p.mesh = new THREE.Mesh(p.geometry, mat);
            explodeGroup.add(p.mesh);
        });
        CC.scene.add(explodeGroup);
        updateExplode();
        explodeRow.style.display = "";
        explodeNote.textContent = Core.explodeNoteText(proxies.length, proxyTruncated, proxySimplified);
        explodeBtn.textContent = "Assembled view";
    }

    function exitExplode() {
        if (!explodeGroup) return;
        CC.scene.remove(explodeGroup);
        for (const p of proxies) {
            if (p.mesh) { p.mesh.material.dispose(); p.mesh = null; }
        }
        explodeGroup = null;
        if (model) model.visible = true;
        explodeRow.style.display = "none";
        explodeBtn.textContent = "Exploded view";
        refresh(); // grid preview comes back
    }

    explodeBtn.addEventListener("click", () => (explodeGroup ? exitExplode() : enterExplode()));
    explodeAmt.addEventListener("input", updateExplode);

    function download(blob, name) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
    }

    /* Zip sink #1 — universal: fflate chunks wrapped in Blobs immediately
       (Chromium pages big blobs to disk, so the JS heap stays flat). Over
       `cap` bytes the current zip downloads and a fresh one opens, so no
       single Blob outgrows what a tab can hand to a download. */
    function blobZipWriter(baseName, cap = 500 * 1024 * 1024) {
        let chunks = [], zip = null, size = 0, closed = 0;
        const names = [];
        const open = () => {
            chunks = []; size = 0;
            zip = new fflate.Zip((err, chunk) => {
                if (err) throw err;
                if (chunk && chunk.length) chunks.push(new Blob([chunk]));
            });
        };
        const flush = (multi) => {
            zip.end();
            const name = multi ? `${baseName}-part${closed + 1}.zip` : `${baseName}.zip`;
            download(new Blob(chunks, { type: "application/zip" }), name);
            names.push(name);
            closed++;
            chunks = [];
        };
        open();
        return {
            add(name, bytes) {
                const f = new fflate.ZipPassThrough(name);
                zip.add(f);
                f.push(bytes, true);
                size += bytes.length;
                if (size > cap) { flush(true); open(); }
            },
            async end() { flush(closed > 0); return names; },
            abort() { try { zip.end(); } catch (e) { /* already done */ } },
        };
    }

    /* Zip sink #2 — File System Access streaming (Chrome/Edge over https):
       one zip of any size written straight to the file Max picks. Absent on
       file:// and in Brave/Firefox/Safari (verified 2026-07-13), where the
       blob writer above takes over. */
    async function fsaZipWriter(baseName) {
        const handle = await window.showSaveFilePicker({
            suggestedName: `${baseName}.zip`,
            types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
        });
        const writable = await handle.createWritable();
        let chain = Promise.resolve();
        const zip = new fflate.Zip((err, chunk) => {
            if (err) throw err;
            if (chunk && chunk.length) {
                const copy = chunk.slice();
                chain = chain.then(() => writable.write(copy));
            }
        });
        return {
            add(name, bytes) {
                const f = new fflate.ZipPassThrough(name);
                zip.add(f);
                f.push(bytes, true);
            },
            async end() {
                zip.end();
                await chain;
                await writable.close();
                return [`${baseName}.zip (saved to disk)`];
            },
            abort() { try { zip.end(); } catch (e) { /* noop */ } chain.then(() => writable.abort()); },
        };
    }

    /* Front-silhouette painter for the assembly map: an offscreen orthographic
       render of the scaled model, clipped to one row's depth band, aimed from
       the front (+Z) and framing the model's full X width × Y height. Null when
       WebGL is unavailable — the map is then drawn without silhouettes. Call
       dispose() when done. */
    function createSilhouettePainter(mesh, size) {
        let renderer = null, material = null, wrapper = null;
        const dispose = () => {
            if (wrapper) wrapper.dispose();
            if (material) material.dispose();
            if (renderer) {
                renderer.dispose();
                renderer.forceContextLoss(); // dispose() alone leaves the GPU context alive
                renderer.domElement.width = renderer.domElement.height = 0;
            }
            wrapper = material = renderer = null;
        };
        try {
            renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
            renderer.setPixelRatio(1);
            renderer.setClearColor(0xffffff, 0);
            renderer.localClippingEnabled = true;
            const gl = renderer.getContext();
            const maxPx = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
                ...gl.getParameter(gl.MAX_VIEWPORT_DIMS));
            const planes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), new THREE.Plane(new THREE.Vector3(0, 0, -1), 0)];
            material = new THREE.MeshBasicMaterial({ color: 0xc8c8c8, side: THREE.DoubleSide, clippingPlanes: planes });
            // a throwaway wrapper, so the live model geometry never gets a dispose listener from this renderer
            const src = mesh.geometry;
            wrapper = new THREE.BufferGeometry();
            wrapper.setIndex(src.index);
            wrapper.setAttribute("position", src.attributes.position);
            // same frame as refresh(): centred on X/Z, floor at Y=0 (the export ignores rotation)
            const shape = new THREE.Mesh(wrapper, material);
            shape.scale.copy(mesh.scale);
            shape.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(shape);
            shape.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
            shape.updateMatrixWorld(true);
            const scene = new THREE.Scene();
            scene.add(shape);
            const camera = new THREE.OrthographicCamera(-size.x / 2, size.x / 2, size.y, 0, 0.1, size.z + 4);
            camera.position.set(0, 0, size.z / 2 + 2); // looks down −Z
            return {
                dispose,
                // draws the slice z0..z1 (mm) of the whole model into ctx at (dx, dy), w × h px
                paint(ctx, dx, dy, w, h, z0, z1) {
                    planes[0].constant = -z0; // keep z ≥ z0
                    planes[1].constant = z1;  // keep z ≤ z1
                    const k = Math.min(1, maxPx / Math.max(w, h)); // too big for the GPU: render smaller, draw scaled
                    renderer.setSize(Math.max(1, Math.floor(w * k)), Math.max(1, Math.floor(h * k)), false);
                    renderer.render(scene, camera);
                    ctx.drawImage(renderer.domElement, dx, dy, w, h);
                },
                _contextLost: () => !renderer || renderer.getContext().isContextLost(),
            };
        } catch (err) {
            console.warn("assembly map silhouettes skipped:", err);
            dispose();
            return null;
        }
    }

    /* Assembly map: the model seen from the front, drawn to scale, one panel
       per depth row (front row first), layers stacked bottom-up, spreadsheet-
       style IDs on the occupied cells, print-friendly. Returns PNG bytes. */
    async function renderAssemblyMap(g, occupied, s, mesh) {
        const cols = g.counts.x, layers = g.counts.y, rows = g.counts.z;
        const footerLines = [
            `${s.name} — ×${Core.fmtScale4(s.scale)}  ·  ${Core.fmtMm(s.size.x)} × ${Core.fmtMm(s.size.z)} × ${Core.fmtMm(s.size.y)} mm  ·  ${occupied.size} parts`,
            `Front view, to scale: columns = letters (left→right), layers bottom-up; one panel per row (front row first)`,
            `Printer ${s.printer}, margin ${s.margin} mm · gap ${s.gap} mm · connectors ${s.connectors}${s.fullVolume ? " · full build volume (pegs use the margin)" : ""}`,
        ];
        const edges = (axis, len) => [0, ...g.cuts[axis], len];
        const bx = edges("x", s.size.x), by = edges("y", s.size.y), bz = edges("z", s.size.z);
        const spans = (b) => b.slice(1).map((v, i) => v - b[i]);
        const colMm = spans(bx), layerMm = spans(by);
        const canvas = document.createElement("canvas");
        const mctx = canvas.getContext("2d"); // measuring only; resizing the canvas resets it
        const footerFont = "12px Inter, sans-serif";
        mctx.font = footerFont;
        const measure = (t) => mctx.measureText(t).width;
        const measureTitle = (t) => { // titles are drawn bold 15 px
            mctx.font = "bold 15px Inter, sans-serif";
            const w = mctx.measureText(t).width;
            mctx.font = footerFont;
            return w;
        };
        const pxPerMm = Core.assemblyScale(colMm, layerMm, rows, footerLines.length);
        const lay = Core.assemblyMapLayout({ colMm, layerMm, rows, pxPerMm, footerLines, measure, measureTitle });
        canvas.width = lay.width;
        canvas.height = lay.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(`assembly map canvas refused (${canvas.width}×${canvas.height} px — over the browser limit?)`);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textBaseline = "middle";

        let painter = createSilhouettePainter(mesh, s.size);
        try {
            for (const panel of lay.panels) {
                const ri = panel.row - 1;
                ctx.fillStyle = "#000";
                ctx.font = "bold 15px Inter, sans-serif";
                ctx.textAlign = "left";
                ctx.fillText(Core.assemblyPanelTitle(panel.row, rows), panel.x, panel.y - 13);
                if (painter) {
                    try {
                        painter.paint(ctx, panel.x, panel.y, panel.w, panel.h,
                            bz[ri] - s.size.z / 2, bz[ri + 1] - s.size.z / 2);
                    } catch (err) {
                        console.warn("assembly map silhouettes skipped:", err);
                        painter.dispose();
                        painter = null;
                    }
                }
                ctx.textAlign = "center";
                for (let li = 0; li < layers; li++) {
                    for (let ci = 0; ci < cols; ci++) {
                        const r = Core.assemblyCellRect(panel, ci, li);
                        ctx.strokeStyle = "#999";
                        ctx.lineWidth = 1;
                        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
                        const id = Core.partId(ci, ri, li, layers);
                        if (!occupied.has(id)) continue;
                        const fpx = Core.assemblyLabelPx(r.w, r.h, (px) => { ctx.font = `bold ${px}px Inter, sans-serif`; return ctx.measureText(id).width; });
                        ctx.font = `bold ${fpx}px Inter, sans-serif`;
                        ctx.lineJoin = "round";
                        ctx.lineWidth = 3;
                        ctx.strokeStyle = "#fff";
                        ctx.strokeText(id, r.x + r.w / 2, r.y + r.h / 2);
                        ctx.fillStyle = "#000";
                        ctx.fillText(id, r.x + r.w / 2, r.y + r.h / 2);
                    }
                }
            }
        } finally {
            if (painter) painter.dispose();
        }
        ctx.fillStyle = "#000";
        ctx.textAlign = "left";
        ctx.font = footerFont;
        footerLines.forEach((t, i) => ctx.fillText(t, lay.panels[0].x, lay.footerY + i * 18 + 9));

        const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!blob) throw new Error("assembly map PNG encode returned null");
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function cutAndExport() {
        if (running) return;
        const p = params();
        // recompute: refresh() is frozen in Exploded view, so the cached grid
        // can predate a bed/margin/nudge/connector edit made there
        layout = Core.resolveLayout(layout, p);
        const g = layout ? layout.grid : null;
        if (!g) return;
        const exportNudge = layout.nudge; // kept: layout may reset while the export runs
        const totalCells = Core.cellCount(g);
        if (totalCells > HARD_CELL_COUNT) {
            resetExportConfirmation();
            CC.toast(`${totalCells.toLocaleString()} candidate parts is too many — Big Print stops at ${HARD_CELL_COUNT.toLocaleString()}. Use a bigger bed or less scale.`);
            return;
        }
        if (totalCells > WARN_CELL_COUNT
                && (confirmCount !== totalCells || Date.now() >= confirmUntil)) {
            armExportConfirmation(totalCells);
            CC.toast(`${totalCells.toLocaleString()} candidate parts is a lot — click again within 5 seconds to export.`);
            return;
        }
        if (!CC.cutFlow.isEngineReady()) {
            CC.toast("The cutting engine is still warming up — one moment.");
            return;
        }
        resetExportConfirmation();
        if (hollowStatus(model) === "out-of-date") { // undo, redo or a repair swapped the model under an open panel
            CC.toast(OUT_OF_DATE);
            return;
        }

        const op = CC.ops.begin("bigprint");
        if (!op) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }
        const baseName = (model.name || "model").replace(/[^\w.-]+/g, "-") + "-bigprint";
        running = true;
        cancelled = false;
        exportBtn.disabled = true;
        cancelBtn.textContent = "Stop";

        // FSA when the browser offers it (https Chrome/Edge); blobs otherwise.
        let writer;
        try {
            writer = window.showSaveFilePicker
                ? await fsaZipWriter(baseName)
                : blobZipWriter(baseName);
        } catch (err) {
            if (err && err.name === "AbortError") { // user dismissed the save dialog
                CC.toast("Stopped — nothing more was exported.");
                CC.ops.end(op);
                running = false;
                exportBtn.disabled = false;
                cancelBtn.textContent = "Cancel";
                return;
            }
            // the picker API itself failed — blob zips still work everywhere
            console.warn("save picker failed, using blob zips:", err);
            writer = blobZipWriter(baseName);
        }

        let solid = null;
        let lease = null;
        let outerCtx = null;
        let blocksFailed = false;
        const rows = [];
        const occupied = new Set();
        let skippedEngravings = 0;
        let seams = 0, seamsWithPegs = 0, labelled = 0;
        try {
            disposeProxies(); // fresh proxy set per export
            let viewer = null; // the 3D assembly.html collector; null leaves the export as it was
            try {
                viewer = window.AssemblyCore ? AssemblyCore.createCollector({
                    candidates: totalCells, simplify: CutCore.simplifyToTarget }) : null;
            } catch (viewerErr) { viewer = null; }
            CC.progress.show("Preparing the model…");
            await new Promise((r) => setTimeout(r, 30)); // let the pill paint

            lease = await manifoldForPrint();
            solid = lease && lease.manifold;
            if (cancelled || !op.alive()) {
                cancelled = true;
                writer.abort();
                CC.toast("Stopped — nothing more was exported.");
                return;
            }
            if (!solid) {
                writer.abort();
                CC.toast("The export failed — the model could not be prepared.");
                return;
            }

            const min = { x: -p.size.x / 2, y: 0, z: -p.size.z / 2 };
            const fmt = document.getElementById("bp-format").value === "3mf" ? "3mf" : "stl";
            const gap = Math.min(Math.max(parseFloat(gapInput.value) || 0, 0), 0.5);
            const conn = connBox.checked ? {
                size: connLimits().size,
                depth: connDepth(connSize.value),
                shape: connShape.value,
                tolR: connLimits().tol,
                tolD: connLimits().tol,
            } : null;

            const receipt = hollowStatus(model) === "confirmed" ? model.userData.hollow : null;
            if (receipt && (conn || engraveBox.checked)) {
                const solidGeometry = CC.hollow.solidGeometry(model);
                if (solidGeometry) {
                    const what = conn && engraveBox.checked ? "connector blocks and label pads"
                        : conn ? "connector blocks" : "label pads";
                    CC.progress.show(`Preparing ${what}…`);
                    await new Promise((r) => setTimeout(r, 30)); // let the pill paint
                    const stop = () => cancelled || op.cancelled || !op.alive();
                    if (!stop()) outerCtx = await buildOuterContext(solidGeometry, g, min, conn, gap, stop, what);
                    if (!outerCtx && !stop()) blocksFailed = true;
                    if (stop()) {
                        cancelled = true;
                        writer.abort();
                        CC.toast("Stopped — nothing more was exported.");
                        return;
                    }
                } else {
                    blocksFailed = true; // no solid shape recorded
                }
            }

            let i = 0;
            for (const candidate of Core.gridCells(g, p.size, min)) {
                if (cancelled || op.cancelled) { cancelled = true; break; }
                const cell = engraveBox.checked
                    ? { ...candidate, engraveId: candidate.id } : candidate;
                CC.progress.update(
                    `Cutting part ${occupied.size + 1} (cell ${i + 1} of ${totalCells})…`,
                    i / totalCells);
                i++;
                await new Promise((r) => setTimeout(r)); // keep the UI alive
                const geo = CutCore.cutGridCell(solid, cell, gap, conn, outerCtx);
                if (!geo) { // the model never enters this cell
                    if (viewer) viewer.skip();
                    continue;
                }
                const bytes = fmt === "3mf" ? Core.serialize3MF(geo) : Core.serializeSTL(geo);
                const file = `Part_${cell.id}.${fmt}`;
                writer.add(file, bytes);
                const info = geo.userData || {};
                const report = info.connectors;
                geo.computeBoundingBox();
                const box = geo.boundingBox;
                rows.push({
                    id: cell.id, file,
                    size: { w: box.max.x - box.min.x, d: box.max.z - box.min.z, h: box.max.y - box.min.y },
                    tris: geo.getIndex().count / 3,
                    engraved: !!info.engraved,
                    onPad: !!info.onPad,
                    noPadRoom: !!info.noPadRoom,
                    pegs: report ? report.pegs.length : undefined,
                    sockets: report ? report.sockets.length : undefined,
                    thinSeams: report ? report.thinSeams : undefined,
                });
                if (report) {
                    seams += report.seams;
                    seamsWithPegs += report.seams - report.thinSeams;
                }
                if (info.engraved) labelled++;
                else if (engraveBox.checked) skippedEngravings++;
                occupied.add(cell.id);
                // budgeted stand-in; i was bumped before the cut, so this cell
                // and everything after it is totalCells - (i - 1)
                const proxyGoal = Core.proxyTargetFor(
                    totalCells - (i - 1), PROXY_TRI_BUDGET - proxyTris, PROXY_TARGET);
                if (!proxies.length) proxyFirstTarget = proxyGoal;
                const proxiesBefore = proxies.length;
                collectProxy(geo, cell.id, proxyGoal);
                if (viewer) { // display only — never fail the export over it
                    try {
                        const b = box, mid = new THREE.Vector3();
                        b.getCenter(mid);
                        viewer.add({
                            id: cell.id, cell: { ci: cell.ci, ri: cell.ri, li: cell.li }, file,
                            box: { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] },
                            center: [mid.x, mid.y, mid.z], engraved: !!info.engraved,
                            pegs: report ? report.pegs.length : null,
                            sockets: report ? report.sockets.length : null,
                        }, proxies.length > proxiesBefore ? proxies[proxies.length - 1].geometry : geo);
                    } catch (viewerErr) { console.warn("assembly part skipped:", viewerErr); }
                }
                geo.dispose(); // streaming: only rows + proxies accumulate
            }

            if (cancelled) {
                writer.abort();
                CC.progress.hide();
                CC.toast("Stopped — nothing more was exported.");
                return;
            }

            const opt = printerSelect.selectedOptions[0];
            const settings = {
                name: model.name || "model",
                version: CC.VERSION,
                exportDate: new Date().toISOString(),
                scale, // raw: the manifest rounds it (fmtScale4)
                size: p.size, bed: p.bed, margin: p.margin, nudge: exportNudge, gap,
                format: fmt.toUpperCase(),
                engraveIds: engraveBox.checked,
                candidateCount: totalCells,
                printer: printerSelect.value === "custom" ? "custom bed" : opt.textContent,
                connectors: conn
                    ? `${conn.shape} ${conn.size} mm, tolerance ${conn.tolR} mm`
                    : "off",
            };
            if (conn) {
                settings.seams = seams;
                settings.seamsWithPegs = seamsWithPegs;
            }
            if (fullVolume.checked) settings.fullVolume = true;
            settings.blocks = !!outerCtx;
            if (receipt) {
                const faces = receipt.openFaces || [];
                settings.hollow = {
                    wallMm: receipt.wallMm,
                    savedPct: receipt.savedPct,
                    engineUsed: receipt.engineUsed,
                    fellBack: receipt.fellBack,
                    openFaces: faces.filter((face) => face.opened === true).map((face) => face.label),
                    closedFaces: faces.filter((face) => face.opened !== true).map((face) => face.label),
                    holes: (receipt.holes && receipt.holes.count) || 0,
                };
            }
            let assembly = null;
            CC.progress.update("Building the 3D assembly view…", 1);
            if (viewer) {
                try {
                    const source = await AssemblyViewer.loadSource();
                    assembly = await viewer.build({
                        meta: { name: settings.name, exportDate: settings.exportDate,
                            appVersion: settings.version, scale: +Core.fmtScale4(settings.scale), size: p.size, gap,
                            connectors: settings.connectors, grid: g, min },
                        source,
                        onStage: (text) => CC.progress.update(text, 1),
                        shouldStop: () => cancelled || op.cancelled || !op.alive(),
                    });
                } catch (viewerErr) {
                    console.warn("assembly viewer skipped:", viewerErr);
                    assembly = { ok: false, reason: "error" };
                }
                viewer.dispose();
                if (assembly.reason === "stopped" || cancelled || op.cancelled || !op.alive()) {
                    cancelled = true;
                    writer.abort();
                    CC.progress.hide();
                    CC.toast("Stopped — nothing more was exported.");
                    return;
                }
                if (assembly.ok) writer.add("assembly.html", assembly.bytes);
            }
            CC.progress.update("Drawing the assembly map…", 1);
            try {
                writer.add("assembly-map.png", await renderAssemblyMap(g, occupied, settings, model));
            } catch (mapErr) { // the parts matter more than the map — ship without it
                console.warn("assembly map skipped:", mapErr);
                CC.toast("The assembly map couldn't be rendered — the zip ships without it.");
            }
            writer.add("manifest.txt",
                new TextEncoder().encode(Core.buildManifest(rows, settings)
                    + (assembly ? AssemblyCore.manifestNote(assembly) : "")));
            const files = await writer.end();

            CC.bigPrint._lastExport = { parts: rows.length, files, skippedEngravings, rows,
                seams, seamsWithPegs, labelled,
                proxies: proxies.length, proxyTruncated, proxySimplified, proxyFirstTarget,
                assembly: assembly ? { ok: assembly.ok, reason: assembly.reason,
                    sizeBytes: assembly.sizeBytes, parts: assembly.parts, tris: assembly.tris,
                    halved: assembly.halved } : null };
            exportCompleted = true;
            if (proxies.length) explodeBtn.style.display = "";
            const story = Core.partStory(rows.length, sealedHollow(model));
            const choice = receipt ? ` · hollow, ${+receipt.wallMm.toFixed(2)} mm wall` : " · solid parts";
            CC.toast(`Big Print done — ${story.exportLabel} in `
                + `${files.length} zip${files.length === 1 ? "" : "s"}${choice}.`
                + (conn && seams > 0 ? ` Connectors on ${seamsWithPegs} of ${seams} seam${seams === 1 ? "" : "s"}`
                    + (seams > seamsWithPegs
                        ? ` (${seams - seamsWithPegs} too thin — see manifest.txt)` : "") + "."
                    : "")
                + (engraveBox.checked ? ` IDs on ${labelled} of ${rows.length} part${rows.length === 1 ? "" : "s"}`
                    + (skippedEngravings
                        ? ` (${skippedEngravings} had no room — see manifest.txt)` : "") + "."
                    : "")
                + (assembly ? (assembly.ok ? " Open assembly.html in the zip to see the parts in 3D."
                    : assembly.reason === "too-big"
                        ? " The 3D assembly view was left out (too big) — see manifest.txt."
                        : " The 3D assembly view couldn't be made — see manifest.txt.") : "")
                + (blocksFailed
                    ? " Solid blocks for connectors and ID labels couldn't be made, so some hollow parts may be missing them."
                    : ""));
        } catch (err) {
            console.error("Big Print export failed:", err);
            CC.toast(err.message === "not-watertight"
                ? "That piece isn't watertight — repair the model first (the repair button in the stats chip), then reopen Big Print."
                : "The export failed — see the console for details.");
            writer.abort();
        } finally {
            if (outerCtx) CutCore.disposeOuterContext(outerCtx);
            if (lease) releasePrintManifold(lease);
            solid = null;
            CC.progress.hide();
            CC.ops.end(op);
            running = false;
            exportBtn.disabled = false;
            cancelBtn.textContent = "Cancel";
        }
    }

    document.getElementById("bigprint-btn").addEventListener("click", enter);
    statsReset.addEventListener("click", resetImportScale);
    hollowOpenBtn.addEventListener("click", () => {
        if (!CC.hollow) return;
        if (running || CC.ops.busy()) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }
        if (Math.abs(scale - 1) > 1e-9) {
            CC.toast("Big Print's scale can't carry into a hollow. Set Scale back to 1×, size the model with Units on the main page, then Hollow….");
            return;
        }
        exit();
        CC.hollow.open();
        if (CC.hollow.isOpen()) {
            // exit() fades the docks and the Pieces panel in after 0.1 s; without this they would
            // win over the panel's fade-out and show under the open Hollow panel.
            gsap.killTweensOf([viewDock, actionDock, piecesPanel]);
            gsap.set([viewDock, actionDock, piecesPanel], { autoAlpha: 0 });
        }
    });
    cancelBtn.addEventListener("click", () => {
        if (running) { cancelled = true; return; }
        exit();
    });
    exportBtn.addEventListener("click", cutAndExport);

    window.addEventListener("keydown", (e) => {
        if (!active || e.key !== "Escape") return;
        if (running) {
            // never tear down mid-export — ask the job to stop instead
            cancelled = true;
            CC.toast("Stopping — finishing the current part…");
            return;
        }
        exit();
    });
    window.addEventListener("curvecut:model-loaded", () => { if (active) exit(true); });
    window.addEventListener("curvecut:repair-cache", (event) => {
        const detail = event.detail;
        cancelRepairPrimeTask();
        cancelPrintManifoldWarm();
        clearPrintManifoldCache();
        clearHollowComputeCache();
        if (detail && detail.primeReady) adoptHollowComputeCache(detail);
        else scheduleRepairPrime(detail);
    });
    window.addEventListener("curvecut:pieces-changed", (event) => {
        const detail = event.detail || {};
        const computeCache = detail.computeCache;
        cancelRepairPrimeTask();
        cancelPrintManifoldWarm();
        clearPrintManifoldCache();
        clearHollowComputeCache();
        if (computeCache && computeCache.primeReady) adoptHollowComputeCache(computeCache);
        else if (computeCache) scheduleRepairPrime(computeCache);
        if (!active || CC.pieces.length !== 1) return;
        if (CC.pieces[0] === model) {
            schedulePrintManifoldWarm();
            return;
        }
        model = CC.pieces[0];
        model.geometry.computeBoundingBox();
        baseSize = new THREE.Vector3();
        model.geometry.boundingBox.getSize(baseSize);
        scale = model.scale.x || 1;
        syncHollowRow();
        scaleInput.value = fmtScale(scale);
        scaleSlider.value = Math.min(scale, parseFloat(scaleSlider.max));
        sizeInput.value = fmtMm(Core.targetForScale(longestSide(), scale));
        refitCamera();
        refresh();
        schedulePrintManifoldWarm();
    });

    const bigPrintApi = {
        enter, exit, resetImportScale, isActive: () => active, _createSilhouettePainter: createSilhouettePainter,
        _memoryReport: () => {
            const liveMainManifoldCacheCount = printManifoldCache
                && !printManifoldCache.deleted ? 1 : 0;
            return {
                liveManifoldCacheCount: liveMainManifoldCacheCount,
                liveMainManifoldCacheCount,
                liveHollowComputeCacheCount: computeWorkerPath() && hollowComputeCache
                    && !hollowComputeCache.retired
                    && hollowComputeCache.worker === CC.compute._worker ? 1 : 0,
            };
        },
    };
    if (location.hash === "#racetest") {
        // Read-only race seam: distinguishes synchronous warm cancellation from
        // the later null-cache continuation.
        bigPrintApi._testWarmPending = () => !!(printManifoldWarm && printManifoldWarm.resolve);
        bigPrintApi._testWarmCancelSerial = () => printManifoldWarmCancelSerial;
    }
    CC.bigPrint = bigPrintApi;
})();
