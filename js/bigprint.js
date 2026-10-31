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
    const printerSelect = document.getElementById("bp-printer");
    const bedW = document.getElementById("bp-bed-w");
    const bedD = document.getElementById("bp-bed-d");
    const bedH = document.getElementById("bp-bed-h");
    const marginInput = document.getElementById("bp-margin");
    const scaleSlider = document.getElementById("bp-scale-slider");
    const scaleInput = document.getElementById("bp-scale");
    const sizeInput = document.getElementById("bp-size");
    const nudgeX = document.getElementById("bp-nudge-x");
    const nudgeY = document.getElementById("bp-nudge-y");
    const nudgeZ = document.getElementById("bp-nudge-z");
    const hollowOn = document.getElementById("bp-hollow-on");
    const hollowFields = document.getElementById("bp-hollow-fields");
    const hollowWall = document.getElementById("bp-hollow-wall");
    const hollowHint = document.getElementById("bp-hollow-hint");
    const hollowApply = document.getElementById("bp-hollow-apply");
    const hollowTeaser = document.getElementById("bp-hollow-teaser");
    const hollowStatus = document.getElementById("bp-hollow-status");
    const status = document.getElementById("bp-status");
    const exportBtn = document.getElementById("bp-export");
    const statsReset = document.getElementById("stats-reset");
    const WARN_CELL_COUNT = 512;
    const HARD_CELL_COUNT = 4096;
    const HOLLOW_WARNING_MAX_SAMPLES = 4096;
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
    let grid = null;           // last computeGrid result
    let printManifoldCache = null; // panel owns it; invalidation retires borrowed entries
    let printManifoldWarm = null;
    let printManifoldWarmCancelSerial = 0;
    let hollowComputeCache = null;
    let hollowComputeJob = null;
    let hollowComputeReleasePromise = null;
    let hollowComputeBuildPromise = null;
    let repairPrimeTask = null;
    let hollowComputeSerial = 0;
    const hollowStates = new WeakMap();

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

    function setScale(k, from) {
        const nextScale = Math.min(Math.max(k || 1, 0.1), 100);
        const scaleChanged = Math.abs(nextScale - scale) > 1e-9;
        if (scaleChanged) {
            cancelRepairPrimeTask();
            disposePrintManifoldCache();
        }
        const removedHollow = active && model && hollowStates.has(model)
            && scaleChanged && restorePreHollow();
        scale = nextScale;
        if (from !== "scale") scaleInput.value = scale.toFixed(2).replace(/\.?0+$/, "");
        if (from !== "slider") scaleSlider.value = Math.min(scale, parseFloat(scaleSlider.max));
        if (from !== "size") {
            sizeInput.value = Core.targetForScale(longestSide(), scale).toFixed(0);
        }
        refitCamera();
        refresh();
        if (removedHollow) {
            window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                { detail: { source: "hollow-revert" } }));
            CC.toast("Scale changed — hollow removed, re-apply");
        }
        scheduleHollowUpdate();
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
        setScale(Core.scaleForTarget(longestSide(), parseFloat(sizeInput.value) || 0), "size"));

    for (const el of [marginInput, nudgeX, nudgeY, nudgeZ]) {
        el.addEventListener("input", refresh);
    }

    // ------------------------------------------------------ hollow controls

    let hollowTimer = null;
    let hollowWarningTimer = null;
    let hollowWarningFrame = null;
    let hollowRevision = 0;
    let hollowStatusSettled = true;
    let lastSavingsStory = null;

    function wallMm() {
        return parseFloat(hollowWall.value);
    }

    function updateWallHint() {
        const wall = wallMm();
        const count = Number.isFinite(wall) ? Math.round(wall / 0.4) : 0;
        hollowHint.textContent = `≈ ${count} wall${count === 1 ? "" : "s"} @ 0.4 mm`;
    }

    function printManifoldTarget() {
        return {
            model,
            geometry: model.geometry,
            scale: hollowStates.has(model) ? 1 : scale,
        };
    }

    function samePrintManifoldTarget(left, right) {
        return left && right && left.model === right.model
            && left.geometry === right.geometry
            && Math.abs(left.scale - right.scale) <= 1e-9;
    }

    function currentPrintManifoldTarget(target) {
        if (!active || model !== target.model || model.geometry !== target.geometry) return false;
        const effectiveScale = hollowStates.has(model) ? 1 : scale;
        return Math.abs(effectiveScale - target.scale) <= 1e-9;
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

    function cancelHollowComputeJob(includeApply) {
        const job = hollowComputeJob;
        if (!job || (!includeApply && job.kind !== "beat") || !computeWorkerPath()) return false;
        return CC.compute.cancel(job.id);
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

    async function runWorkerHollow(target, op, payload, options, kind = "beat") {
        const cacheKind = kind === "apply" ? kind : "hollow-prep";
        const cache = await sanctionedHollowCache(target, cacheKind, "Preparing hollow…");
        if (!cache) return null;
        cache.borrowCount++;
        try {
            const value = await runHollowComputeJob(op,
                Object.assign({}, payload, { token: cache.token }), options, kind);
            return { value };
        } finally {
            cache.borrowCount--;
            releaseHollowComputeCache(cache);
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
        return printManifoldWarm === warm && !hollowStates.has(warm.model)
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
        if (!hollowStatusSettled || CC.ops.busy()) {
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
        if (!active || !model || hollowStates.has(model)) {
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

    function warningText(warnings) {
        return warnings.map((warning) => warning.detail).join(" · ");
    }

    function previewWallStats(displacementsMm) {
        const values = Array.from(displacementsMm).sort((a, b) => a - b);
        const pick = (fraction) => values[Math.floor(fraction * (values.length - 1))];
        return {
            minMm: values[0],
            p05Mm: pick(0.05),
            medianMm: pick(0.5),
        };
    }

    function appendPreviewWarnings(warnings) {
        if (!warnings.length) return;
        hollowStatus.append(document.createTextNode(" · warnings: "));
        warnings.forEach((warning, index) => {
            if (index) hollowStatus.append(document.createTextNode(", "));
            const code = document.createElement("span");
            code.textContent = warning.code;
            code.title = warning.detail;
            if (warning.code === "thin-wall-hard") code.className = "bp-hollow-warning-hard";
            hollowStatus.append(code);
        });
    }

    function cancelHollowWarningBeat() {
        clearTimeout(hollowWarningTimer);
        hollowWarningTimer = null;
        if (hollowWarningFrame !== null) {
            cancelAnimationFrame(hollowWarningFrame);
            hollowWarningFrame = null;
        }
    }

    function cancelHollowUpdate() {
        cancelHollowComputeJob(false);
        clearTimeout(hollowTimer);
        hollowTimer = null;
        cancelHollowWarningBeat();
        hollowRevision++;
        hollowStatusSettled = true;
    }

    function currentHollowBeat(revision, targetModel, targetGeometry, targetScale) {
        return active && hollowOn.checked && !hollowStates.has(targetModel)
            && revision === hollowRevision && model === targetModel
            && model.geometry === targetGeometry && Math.abs(scale - targetScale) <= 1e-9;
    }

    function settleHollowBeat(revision) {
        if (revision === hollowRevision) hollowStatusSettled = true;
    }

    function queueHollowWarnings(revision, targetModel, targetGeometry, targetScale, wall, story) {
        const run = () => {
            hollowWarningTimer = setTimeout(() => {
                hollowWarningTimer = null;
                updateHollowWarnings(revision, targetModel, targetGeometry,
                    targetScale, wall, story);
            }, 0);
        };
        if (typeof window.requestAnimationFrame === "function") {
            hollowWarningFrame = window.requestAnimationFrame(() => {
                hollowWarningFrame = null;
                if (currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) run();
                else settleHollowBeat(revision);
            });
        } else {
            run();
        }
    }

    async function updateHollowWarnings(revision, targetModel, targetGeometry, targetScale, wall, story) {
        if (!currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) {
            settleHollowBeat(revision);
            return;
        }
        let preview = null;
        let lease = null;
        try {
            const target = { model: targetModel, geometry: targetGeometry, scale: targetScale };
            const workerResult = computeWorkerPath()
                ? await runWorkerHollow(target, "previewShell", { wallMm: wall,
                    opts: { maxSamples: HOLLOW_WARNING_MAX_SAMPLES } }, {}, "beat")
                : null;
            if (workerResult) preview = workerResult.value;
            else {
                lease = await manifoldForPrint();
                if (!lease || !currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;
                preview = CC.hollowCore.previewShell(lease.manifold, wall, {
                    maxSamples: HOLLOW_WARNING_MAX_SAMPLES,
                });
            }
            const wallStats = previewWallStats(preview.displacementsMm);
            const warnings = CC.hollowCore.wallWarnings(wallStats, wall);
            if (!currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;

            hollowStatus.textContent = story.status;
            appendPreviewWarnings(warnings);
            hollowStatus.append(document.createTextNode(
                " · coarse preview — exact result on Apply."));
            hollowStatus.classList.toggle("warning", warnings.length > 0);
            hollowStatusSettled = true;
        } catch (error) {
            if (!currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;
            console.warn("Hollow wall warnings unavailable:", error);
            hollowStatus.textContent = story.status
                + " Wall warnings unavailable — exact result on Apply.";
            hollowStatus.classList.add("warning");
            hollowStatusSettled = true;
        } finally {
            settleHollowBeat(revision);
            preview = null;
            if (lease) releasePrintManifold(lease);
        }
    }

    async function updateHollowEstimate(revision) {
        if (!active || !model || !hollowOn.checked || hollowStates.has(model)
            || revision !== hollowRevision) {
            settleHollowBeat(revision);
            return;
        }
        const wall = wallMm();
        if (!Number.isFinite(wall) || wall < 0.8) {
            hollowStatus.textContent = "Wall thickness must be at least 0.8 mm.";
            hollowStatus.classList.add("warning");
            hollowStatusSettled = true;
            return;
        }
        if (!computeWorkerPath() && !CutCore.isReady()) {
            hollowStatus.textContent = "Hollow engine is warming up…";
            hollowStatusSettled = true;
            return;
        }

        let story = null;
        let lease = null;
        let warningsQueued = false;
        try {
            const targetModel = model;
            const targetGeometry = model.geometry;
            const targetScale = scale;
            const target = { model: targetModel, geometry: targetGeometry, scale: targetScale };
            const workerResult = computeWorkerPath()
                ? await runWorkerHollow(target, "hollowEstimate", { wallMm: wall }, {}, "beat")
                : null;
            let estimate;
            if (workerResult) estimate = workerResult.value;
            else {
                lease = await manifoldForPrint();
                if (!lease || !currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;
                estimate = CC.hollowCore.estimate(lease.manifold, wall);
            }
            if (!currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;
            if (estimate === null) {
                hollowStatusSettled = true;
                return;
            }
            const savedPct = typeof estimate === "number" ? estimate : estimate.savedPct;
            story = Core.hollowSavingsStory(savedPct, wall);
            lastSavingsStory = story;
            if (!currentHollowBeat(revision, targetModel, targetGeometry, targetScale)) return;
            hollowStatus.textContent = story.status + " Checking walls…";
            hollowStatus.classList.remove("warning");
            warningsQueued = true;
            queueHollowWarnings(revision, targetModel, targetGeometry, targetScale, wall, story);
        } catch (error) {
            if (revision !== hollowRevision) return;
            console.warn("Hollow estimate unavailable:", error);
            hollowStatus.textContent = story
                ? story.status + " Wall warnings unavailable — exact result on Apply."
                : "Hollow estimate unavailable at this wall thickness — exact result on Apply.";
            hollowStatus.classList.add("warning");
            hollowStatusSettled = true;
        } finally {
            if (!warningsQueued) settleHollowBeat(revision);
            if (lease) releasePrintManifold(lease);
        }
    }

    async function updateHollowTeaser(revision) {
        if (!active || !model || hollowOn.checked || hollowStates.has(model)
            || revision !== hollowRevision) {
            settleHollowBeat(revision);
            return;
        }
        hollowTeaser.textContent = "";
        let lease = null;
        try {
            const targetModel = model;
            const targetGeometry = model.geometry;
            const targetScale = scale;
            const target = { model: targetModel, geometry: targetGeometry, scale: targetScale };
            const workerResult = computeWorkerPath()
                ? await runWorkerHollow(target, "hollowEstimate", { wallMm: wallMm() }, {}, "beat")
                : null;
            let estimate;
            if (workerResult) estimate = workerResult.value;
            else {
                lease = await manifoldForPrint();
                if (!lease || !active || model !== targetModel || model.geometry !== targetGeometry
                    || Math.abs(scale - targetScale) > 1e-9 || revision !== hollowRevision) return;
                estimate = CC.hollowCore.estimate(lease.manifold, wallMm());
            }
            if (!active || hollowOn.checked || hollowStates.has(model)
                || revision !== hollowRevision || model !== targetModel
                || model.geometry !== targetGeometry || Math.abs(scale - targetScale) > 1e-9) return;
            const savedPct = typeof estimate === "number" ? estimate : estimate.savedPct;
            lastSavingsStory = Core.hollowSavingsStory(savedPct, wallMm());
            hollowTeaser.textContent = lastSavingsStory.teaser || "";
            hollowStatusSettled = true;
        } catch (error) {
            console.warn("Hollow teaser unavailable:", error);
            if (revision === hollowRevision) hollowStatusSettled = true;
        } finally {
            settleHollowBeat(revision);
            if (lease) releasePrintManifold(lease);
        }
    }

    function scheduleHollowUpdate() {
        cancelHollowUpdate();
        if (!active || !model || hollowStates.has(model)) return;
        hollowStatusSettled = false;
        lastSavingsStory = null;
        if (!hollowOn.checked) hollowTeaser.textContent = "";
        const revision = hollowRevision;
        hollowTimer = setTimeout(() => {
            hollowTimer = null;
            if (hollowOn.checked) updateHollowEstimate(revision);
            else updateHollowTeaser(revision);
        }, 180);
    }

    function restorePreHollow() {
        const state = hollowStates.get(model);
        if (!state) return false;
        disposePrintManifoldCache();
        model.geometry.dispose();
        model.geometry = state.preHollowGeometry;
        model.scale.setScalar(1);
        delete model.userData.bigPrintHollow;
        if (state.bakedScaleRecorded) {
            const prior = model.userData.bakedScale / state.scale;
            if (Math.abs(prior - 1) <= 1e-9) delete model.userData.bakedScale;
            else model.userData.bakedScale = prior;
        }
        hollowStates.delete(model);
        baseSize.copy(state.baseSize);
        hollowOn.checked = true;
        hollowOn.disabled = false;
        hollowFields.style.display = "";
        hollowTeaser.textContent = "";
        hollowWall.disabled = false;
        hollowApply.disabled = false;
        hollowStatus.textContent = "";
        hollowStatus.classList.remove("warning");
        hollowStatusSettled = true;
        return true;
    }

    hollowWall.addEventListener("input", () => {
        if (!hollowOn.checked) return;
        updateWallHint();
        scheduleHollowUpdate();
    });

    hollowOn.addEventListener("change", () => {
        hollowFields.style.display = hollowOn.checked ? "" : "none";
        cancelHollowUpdate();
        hollowStatusSettled = !hollowOn.checked;
        hollowStatus.textContent = "";
        hollowStatus.classList.remove("warning");
        if (hollowOn.checked) {
            hollowTeaser.textContent = "";
            updateWallHint();
            scheduleHollowUpdate();
        } else {
            hollowTeaser.textContent = lastSavingsStory && lastSavingsStory.teaser || "";
        }
    });

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
            nudge: {
                x: parseFloat(nudgeX.value) || 0,
                y: parseFloat(nudgeY.value) || 0,
                z: parseFloat(nudgeZ.value) || 0,
            },
        };
    }

    function refresh() {
        if (!active || explodeGroup) return; // frozen while exploded
        resetExportConfirmation();
        model.scale.setScalar(hollowStates.has(model) ? 1 : scale);
        const p = params();
        grid = Core.computeGrid(p);
        removeGrid();

        if (!grid) {
            status.classList.remove("warning");
            status.textContent = "The margin eats the whole bed — shrink one of them.";
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
        const story = Core.partStory(count, hollowStates.has(model));
        status.textContent =
            `Final ${p.size.x.toFixed(0)} × ${p.size.z.toFixed(0)} × ${p.size.y.toFixed(0)} mm` +
            ` · grid ${c.x}×${c.z}×${c.y}` +
            ` · up to ${count.toLocaleString()} part${count === 1 ? "" : "s"}` +
            story.statusSuffix;
        status.classList.toggle("warning", count > WARN_CELL_COUNT);
        exportBtn.disabled = false;

        // Nudge range follows the usable cell size.
        nudgeX.max = grid.usable.x; nudgeX.min = -grid.usable.x;
        nudgeY.max = grid.usable.y; nudgeY.min = -grid.usable.y;
        nudgeZ.max = grid.usable.z; nudgeZ.min = -grid.usable.z;
    }

    // ------------------------------------------------------------ mode flow

    function appliedHollowStatus(receipt, warnings = []) {
        hollowStatus.textContent = `Hollowed · saved ${receipt.savedPct.toFixed(1)}%`
            + ` · used ${receipt.engineUsed} engine${receipt.fellBack ? " (fallback)" : ""}`
            + (warnings.length ? ` · ${warningText(warnings)}` : "");
        hollowStatus.classList.toggle("warning", warnings.length > 0 || receipt.fellBack);
        hollowOn.checked = true;
        hollowOn.disabled = true;
        hollowFields.style.display = "";
        hollowTeaser.textContent = "";
        hollowWall.disabled = true;
        hollowApply.disabled = true;
        hollowStatusSettled = true;
    }

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
        cancelPrintManifoldWarm();
        clearPrintManifoldCache();
        active = true;
        CC.bigPrintActive = true;
        exportCompleted = false;
        model = CC.pieces[0];
        const hollowState = hollowStates.get(model);
        if (hollowState) {
            baseSize = hollowState.baseSize.clone();
            scale = hollowState.scale;
        } else {
            model.geometry.computeBoundingBox();
            const bb = model.geometry.boundingBox;
            baseSize = new THREE.Vector3();
            bb.getSize(baseSize);
            scale = 1;
        }

        printerSelect.value = "0";
        applyPreset();
        marginInput.value = 5;
        nudgeX.value = 0; nudgeY.value = 0; nudgeZ.value = 0;
        hollowWall.value = hollowState ? model.userData.bigPrintHollow.wallMm : 6;
        hollowOn.checked = !!hollowState;
        hollowOn.disabled = !!hollowState;
        hollowFields.style.display = hollowState ? "" : "none";
        hollowTeaser.textContent = "";
        lastSavingsStory = null;
        updateWallHint();
        setScale(scale);
        if (hollowState) appliedHollowStatus(
            model.userData.bigPrintHollow, hollowState.warnings);
        else {
            hollowWall.disabled = false;
            hollowApply.disabled = false;
            hollowStatus.textContent = "";
            hollowStatus.classList.remove("warning");
        }

        gsap.to([actionDock], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        panelCollapse.reset(); // Big Print re-entry always starts expanded
        gsap.fromTo(panel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out" });
        refresh();

        // dowel-ish connector default, proportional to the printable cell
        const u = grid ? Math.min(grid.usable.x, grid.usable.y, grid.usable.z) : 200;
        document.getElementById("bp-conn-size").value =
            Math.round(Math.min(Math.max(u * 0.05, 4), 12));
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
        resetExportConfirmation();
        cancelHollowUpdate();
        disposePrintManifoldCache();
        active = false;
        CC.bigPrintActive = false;
        disposeProxies();
        removeGrid();
        if (!modelLoaded && !exportCompleted) {
            const restoredScale = Math.abs(scale - 1) > 1e-9;
            const restoredHollow = hollowStates.has(model) && restorePreHollow();
            scale = 1;
            model.scale.setScalar(1);
            if (restoredHollow) {
                window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                    { detail: { source: "hollow-revert" } }));
            }
            if (restoredScale || restoredHollow) {
                CC.toast("Big Print cancelled — model restored.");
            }
            CC.flyHome();
            showModelStats(model);
        } else if (!modelLoaded && exportCompleted) {
            const keptScale = scale;
            const hollowState = hollowStates.get(model);
            if (!hollowState && Math.abs(keptScale - 1) > 1e-9) {
                model.geometry.scale(keptScale, keptScale, keptScale);
                model.geometry.computeBoundingBox();
                baseSize.multiplyScalar(keptScale);
                scale = 1;
                model.scale.setScalar(1);
            }
            if (!hollowState || !hollowState.bakedScaleRecorded) {
                recordBakedScale(model, keptScale);
                if (hollowState) hollowState.bakedScaleRecorded = true;
            }
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
    }

    // ------------------------------------------------------- apply hollow

    let hollowRunning = false;

    async function applyHollow() {
        if (hollowRunning || hollowStates.has(model)) return;
        const wall = wallMm();
        if (!Number.isFinite(wall) || wall < 0.8) {
            hollowStatus.textContent = "Wall thickness must be at least 0.8 mm.";
            hollowStatus.classList.add("warning");
            return;
        }
        if (!computeWorkerPath() && !CutCore.isReady()) {
            CC.toast("The hollow engine is still warming up — one moment.");
            return;
        }
        if (CC.ops.busy()) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }
        const op = CC.ops.begin("hollow");
        if (!op) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }

        let source = null;
        let lease = null;
        let result = null;
        let hollowStats = null;
        let geometry = null;
        const target = { model, geometry: model.geometry, scale };
        hollowRunning = true;
        hollowApply.disabled = true;
        cancelHollowUpdate();
        CC.progress.show("Preparing hollow…");
        try {
            await new Promise((resolve) => setTimeout(resolve, 30));
            if (!op.alive()) throw new CC.hollowCore.HollowCancelled();
            let workerResult = null;
            if (computeWorkerPath()) {
                workerResult = await runWorkerHollow(target, "hollowApply", { wallMm: wall }, {
                    onProgress(progress) {
                        const label = (progress.stage || "compute").replace(/-/g, " ");
                        CC.progress.update(`Hollowing — ${label}…`, progress.fraction);
                        if (!op.alive()) cancelHollowComputeJob(true);
                    },
                }, "apply");
            }
            if (workerResult) {
                const arrays = workerResult.value;
                geometry = new THREE.BufferGeometry();
                geometry.setAttribute("position",
                    new THREE.BufferAttribute(arrays.vertProperties, 3));
                geometry.setIndex(new THREE.BufferAttribute(arrays.triVerts, 1));
                hollowStats = arrays.stats;
            } else {
                await CutCore.init();
                lease = await manifoldForPrint();
                if (!lease || !op.alive() || !currentPrintManifoldTarget(target)) {
                    throw new CC.hollowCore.HollowCancelled();
                }
                source = lease.manifold;
                result = CC.hollowCore.hollow(source, wall, {
                    onProgress(stage, fraction) {
                        const label = stage.replace(/-/g, " ");
                        CC.progress.update(`Hollowing — ${label}…`, fraction);
                    },
                    shouldCancel: () => !op.alive(),
                });
                hollowStats = result.stats;
                geometry = CutCore.toGeometry(result.hollow);
            }
            if (!op.alive()) throw new CC.hollowCore.HollowCancelled();
            disposePrintManifoldCache();

            const receipt = {
                wallMm: wall,
                savedPct: hollowStats.savedPct,
                engineUsed: hollowStats.engineUsed,
                fellBack: hollowStats.fellBack,
            };
            const previous = model;
            const preHollowGeometry = previous.geometry.clone();
            const next = new THREE.Mesh(geometry, previous.material);
            geometry = null;
            next.name = previous.name;
            next.visible = previous.visible;
            next.userData = Object.assign({}, previous.userData, { bigPrintHollow: receipt });
            next.scale.setScalar(1);

            CC.history.capture();
            CC.scene.remove(previous);
            CC.scene.add(next);
            CC.pieces[0] = next;
            model = next;
            hollowStates.set(next, {
                preHollowGeometry,
                baseSize: baseSize.clone(),
                scale,
                bakedScaleRecorded: false,
                warnings: hollowStats.warnings.slice(),
            });
            appliedHollowStatus(receipt, hollowStats.warnings);
            window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                { detail: { source: "hollow" } }));
            refresh();
            CC.toast(`Hollowed — saved ${receipt.savedPct.toFixed(1)}% of material (wall ${wall} mm)`);
        } catch (error) {
            if (error instanceof CC.hollowCore.HollowCancelled
                || (CC.compute && error instanceof CC.compute.ComputeCancelled)) {
                hollowStatus.textContent = "Hollowing cancelled — model unchanged.";
                hollowStatus.classList.remove("warning");
                CC.toast("Hollowing cancelled — model unchanged.");
            } else if (error instanceof CC.hollowCore.HollowGridTooLarge) {
                hollowStatus.textContent = `Hollowing needs too much memory (${error.voxels.toLocaleString()} grid cells) — model unchanged.`;
                hollowStatus.classList.add("warning");
                CC.toast("Hollowing needs too much memory at this wall thickness.");
            } else {
                console.error("Hollowing failed:", error);
                hollowStatus.textContent = "Hollowing failed — model unchanged. See the console for details.";
                hollowStatus.classList.add("warning");
                CC.toast("Hollowing failed — the model was not changed.");
            }
        } finally {
            if (geometry) geometry.dispose();
            if (result) result.hollow.delete();
            if (lease) releasePrintManifold(lease);
            source = null;
            CC.progress.hide();
            CC.ops.end(op);
            hollowRunning = false;
            hollowApply.disabled = hollowStates.has(model);
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

        const piece = CC.pieces[0];
        disposePrintManifoldCache();
        const state = hollowStates.get(piece);
        const restoredHollow = !!state;
        let geometry;

        CC.history.capture();
        if (state) {
            const hollowGeometry = piece.geometry;
            piece.geometry = hollowGeometry.clone();
            hollowGeometry.dispose();
            geometry = state.preHollowGeometry;
            const priorScale = piece.userData.bakedScale / state.scale;
            if (Math.abs(priorScale - 1) > 1e-9) {
                geometry.scale(1 / priorScale, 1 / priorScale, 1 / priorScale);
                geometry.computeBoundingBox();
            }
            hollowStates.delete(piece);
        } else {
            geometry = piece.geometry.clone();
            const k = piece.userData.bakedScale;
            geometry.scale(1 / k, 1 / k, 1 / k);
            geometry.computeBoundingBox();
        }

        const next = new THREE.Mesh(geometry, piece.material);
        next.name = piece.name;
        next.visible = piece.visible;
        next.userData = Object.assign({}, piece.userData);
        delete next.userData.bakedScale;
        if (restoredHollow) delete next.userData.bigPrintHollow;

        CC.scene.remove(piece);
        CC.scene.add(next);
        CC.pieces[0] = next;
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
            { detail: { source: "scale-reset" } }));
        showModelStats(next);
        CC.toast(restoredHollow
            ? "Restored the imported model — 1×."
            : "Restored to imported size — 1×.");
    }

    // ------------------------------------------------------- cut & export

    const gapInput = document.getElementById("bp-gap");
    const connBox = document.getElementById("bp-connectors");
    const connShape = document.getElementById("bp-conn-shape");
    const connSize = document.getElementById("bp-conn-size");
    const connTol = document.getElementById("bp-conn-tol");
    const engraveBox = document.getElementById("bp-engrave");
    const cancelBtn = document.getElementById("bp-cancel");

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

    /* Assembly map: one top-view grid per layer, spreadsheet-style labels,
       print-friendly black-on-white. Returns PNG bytes. */
    async function renderAssemblyMap(g, occupied, s) {
        const cell = Math.max(26, Math.min(64, Math.floor(560 / Math.max(g.counts.x, g.counts.z))));
        const pad = 34, header = 26, footer = 74;
        const gw = g.counts.x * cell, gh = g.counts.z * cell;
        const canvas = document.createElement("canvas");
        canvas.width = gw + pad * 2;
        canvas.height = (header + gh + 18) * g.counts.y + footer + pad;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(`assembly map canvas refused (${canvas.width}×${canvas.height} px — over the browser limit?)`);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";

        let y = pad / 2;
        for (let li = 0; li < g.counts.y; li++) {
            ctx.fillStyle = "#000";
            ctx.font = "bold 15px Inter, sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(g.counts.y > 1 ? `Layer ${li + 1}${li ? ` (-L${li + 1})` : ""}` : "Top view", pad, y + header / 2);
            ctx.textAlign = "center";
            y += header;
            for (let ri = 0; ri < g.counts.z; ri++) {
                for (let ci = 0; ci < g.counts.x; ci++) {
                    const x = pad + ci * cell, yy = y + ri * cell;
                    const id = Core.partId(ci, ri, li, g.counts.y);
                    const has = occupied.has(id);
                    ctx.fillStyle = has ? "#f2f2f2" : "#ffffff";
                    ctx.fillRect(x, yy, cell, cell);
                    ctx.strokeStyle = "#999";
                    ctx.strokeRect(x + 0.5, yy + 0.5, cell, cell);
                    if (has) {
                        ctx.fillStyle = "#000";
                        ctx.font = `${Math.max(10, cell * 0.3)}px Inter, sans-serif`;
                        ctx.fillText(id, x + cell / 2, yy + cell / 2);
                    }
                }
            }
            y += gh + 18;
        }
        ctx.fillStyle = "#000";
        ctx.textAlign = "left";
        ctx.font = "12px Inter, sans-serif";
        ctx.fillText(`${s.name} — ×${s.scale}  ·  ${s.size.x.toFixed(0)} × ${s.size.z.toFixed(0)} × ${s.size.y.toFixed(0)} mm  ·  ${occupied.size} parts`, pad, y + 14);
        ctx.fillText(`Columns = letters (left→right) · rows = numbers (back→front) · layers bottom-up`, pad, y + 32);
        ctx.fillText(`Printer ${s.printer}, margin ${s.margin} mm · gap ${s.gap} mm · connectors ${s.connectors}`, pad, y + 50);

        const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!blob) throw new Error("assembly map PNG encode returned null");
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function cutAndExport() {
        if (running) return;
        const p = params();
        const g = grid;
        if (!g) return;
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
        const rows = [];
        const occupied = new Set();
        let skippedEngravings = 0;
        try {
            disposeProxies(); // fresh proxy set per export
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
                size: Math.max(parseFloat(connSize.value) || 4, 2),
                depth: Math.max((parseFloat(connSize.value) || 4) * 0.8, 2),
                shape: connShape.value,
                tolR: Math.max(parseFloat(connTol.value) || 0, 0),
                tolD: Math.max(parseFloat(connTol.value) || 0, 0),
            } : null;

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
                const geo = CutCore.cutGridCell(solid, cell, gap, conn);
                if (!geo) continue; // the model never enters this cell
                const bytes = fmt === "3mf" ? Core.serialize3MF(geo) : Core.serializeSTL(geo);
                const file = `Part_${cell.id}.${fmt}`;
                writer.add(file, bytes);
                rows.push({
                    id: cell.id, file,
                    tris: geo.getIndex().count / 3,
                    engraved: !!(geo.userData && geo.userData.engraved),
                });
                if (engraveBox.checked && !(geo.userData && geo.userData.engraved)) {
                    skippedEngravings++;
                }
                occupied.add(cell.id);
                // budgeted stand-in; i was bumped before the cut, so this cell
                // and everything after it is totalCells - (i - 1)
                const proxyGoal = Core.proxyTargetFor(
                    totalCells - (i - 1), PROXY_TRI_BUDGET - proxyTris, PROXY_TARGET);
                if (!proxies.length) proxyFirstTarget = proxyGoal;
                collectProxy(geo, cell.id, proxyGoal);
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
                scale: +scale.toFixed(3),
                size: p.size, bed: p.bed, margin: p.margin, nudge: p.nudge, gap,
                format: fmt.toUpperCase(),
                engraveIds: engraveBox.checked,
                candidateCount: totalCells,
                printer: printerSelect.value === "custom" ? "custom bed" : opt.textContent,
                connectors: conn
                    ? `${conn.shape} ${conn.size} mm, tolerance ${conn.tolR} mm`
                    : "off",
            };
            if (model.userData.bigPrintHollow) {
                const hollow = model.userData.bigPrintHollow;
                settings.hollow = {
                    wallMm: hollow.wallMm,
                    savedPct: hollow.savedPct,
                    engineUsed: hollow.engineUsed,
                    fellBack: hollow.fellBack,
                };
            }
            CC.progress.update("Drawing the assembly map…", 1);
            try {
                writer.add("assembly-map.png", await renderAssemblyMap(g, occupied, settings));
            } catch (mapErr) { // the parts matter more than the map — ship without it
                console.warn("assembly map skipped:", mapErr);
                CC.toast("The assembly map couldn't be rendered — the zip ships without it.");
            }
            writer.add("manifest.txt",
                new TextEncoder().encode(Core.buildManifest(rows, settings)));
            const files = await writer.end();

            CC.bigPrint._lastExport = { parts: rows.length, files, skippedEngravings, rows,
                proxies: proxies.length, proxyTruncated, proxySimplified, proxyFirstTarget };
            exportCompleted = true;
            if (proxies.length) explodeBtn.style.display = "";
            const story = Core.partStory(rows.length, !!settings.hollow);
            CC.toast(`Big Print done — ${story.exportLabel} in `
                + `${files.length} zip${files.length === 1 ? "" : "s"}`
                + (skippedEngravings ? ` (${skippedEngravings} too small to engrave)` : "")
                + ".");
        } catch (err) {
            console.error("Big Print export failed:", err);
            CC.toast(err.message === "not-watertight"
                ? "That piece isn't watertight — repair the model first (the repair button in the stats chip), then reopen Big Print."
                : "The export failed — see the console for details.");
            writer.abort();
        } finally {
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
    hollowApply.addEventListener("click", applyHollow);
    cancelBtn.addEventListener("click", () => {
        if (hollowRunning) {
            CC.ops.cancel();
            cancelHollowComputeJob(true);
            CC.toast("Stopping hollowing…");
            return;
        }
        if (running) { cancelled = true; return; }
        exit();
    });
    exportBtn.addEventListener("click", cutAndExport);

    window.addEventListener("keydown", (e) => {
        if (!active || e.key !== "Escape") return;
        if (hollowRunning) {
            CC.ops.cancel();
            cancelHollowComputeJob(true);
            CC.toast("Stopping hollowing…");
            return;
        }
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
            cancelHollowUpdate();
            schedulePrintManifoldWarm();
            return;
        }
        cancelHollowUpdate();
        model = CC.pieces[0];
        const state = hollowStates.get(model);
        if (state) {
            baseSize = state.baseSize.clone();
            scale = state.scale;
            model.scale.setScalar(1);
            hollowWall.value = model.userData.bigPrintHollow.wallMm;
            appliedHollowStatus(model.userData.bigPrintHollow, state.warnings);
        } else {
            model.geometry.computeBoundingBox();
            baseSize = new THREE.Vector3();
            model.geometry.boundingBox.getSize(baseSize);
            scale = model.scale.x || 1;
            hollowOn.disabled = false;
            hollowFields.style.display = hollowOn.checked ? "" : "none";
            hollowWall.disabled = false;
            hollowApply.disabled = false;
            hollowStatus.textContent = "";
            hollowStatus.classList.remove("warning");
        }
        updateWallHint();
        scaleInput.value = scale.toFixed(2).replace(/\.?0+$/, "");
        scaleSlider.value = Math.min(scale, parseFloat(scaleSlider.max));
        sizeInput.value = Core.targetForScale(longestSide(), scale).toFixed(0);
        refitCamera();
        refresh();
        if (hollowOn.checked) scheduleHollowUpdate();
        else {
            lastSavingsStory = null;
            hollowTeaser.textContent = "";
        }
        schedulePrintManifoldWarm();
    });

    const bigPrintApi = {
        enter, exit, resetImportScale, isActive: () => active,
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
