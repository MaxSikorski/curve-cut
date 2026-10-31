/* Curve Cut — compute-worker dispatcher.
   Blob workers keep the file:// build self-contained; the generated source
   carries its own Manifold loader and DOM-free engine cores.

   Transfer ownership: a buffer listed in run()'s transfer option leaves the
   caller detached when the worker receives it. Result buffers belong to the
   worker until its result message transfers them back; the resolved result
   then owns them. Degraded main-thread fallback never transfers its inputs. */

(() => {
    "use strict";

    const root = window;
    const CC = root.CurveCut = root.CurveCut || {};
    const SOURCE_KEY = "CurveCutComputeWorkerSource";
    const CANCEL_GRACE_MS = 250;
    const WORKER_URL_REVOKE_FALLBACK_MS = 5000;
    const GEOMETRY_COPY_CHUNK = 16384;
    // The 512k statue measured 243,335,168 B after repair plus a live prime;
    // 256 MiB leaves 25,100,288 B (about 10%) for post-prime growth.
    const WASM_RECYCLE_THRESHOLD_BYTES = 256 * 1024 * 1024;

    class ComputeCancelled extends Error {
        constructor() {
            super("Compute operation cancelled");
            this.name = "ComputeCancelled";
        }
    }

    let worker = null;
    let workerUrl = null;
    let workerUrlTimer = null;
    let workerCancelSignal = null;
    let readyState = "idle";
    let readyPromise = null;
    let resolveReady = null;
    let degraded = false;
    let runtimeFailures = 0;
    let active = null;
    let nextId = 1;
    const liveWorkers = new Set();
    let lastTerminatedWorker = null;
    const mainCachedSources = new Map();
    const workerCacheTokens = new Set();
    let workerWasmBytes = null;
    let workerWasmSource = "unavailable";
    let workerJsHeapBytes = null;
    let wasmRecycleThresholdBytes = WASM_RECYCLE_THRESHOLD_BYTES;
    let recyclePending = false;
    let recycleTimer = null;
    let lastRecycleReason = null;

    function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function errorFromWire(data) {
        const error = data && data.name === "ComputeCancelled"
            ? new ComputeCancelled()
            : new Error(data && data.message ? data.message : "Compute worker error");
        if (data && data.message) error.message = data.message;
        error.name = data && data.name ? data.name : error.name;
        if (data && data.stack) error.stack = data.stack;
        return error;
    }

    function finishReady(value) {
        if (!resolveReady) return;
        const resolve = resolveReady;
        resolveReady = null;
        resolve(value);
    }

    function finiteBytes(value) {
        return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
    }

    function mainHeapBytes() {
        const memory = root.performance && root.performance.memory;
        return memory ? finiteBytes(memory.usedJSHeapSize) : null;
    }

    function rememberWorkerMemory(report) {
        if (!report) return;
        const wasmBytes = finiteBytes(report.wasmHeapBytes);
        if (wasmBytes !== null) {
            workerWasmBytes = wasmBytes;
            workerWasmSource = "worker.memoryStats";
        }
        const jsBytes = finiteBytes(report.jsHeapBytes);
        if (jsBytes !== null) workerJsHeapBytes = jsBytes;
    }

    function workerMemoryReport() {
        return {
            bytes: workerWasmBytes,
            source: workerWasmSource,
            jsHeapBytes: workerJsHeapBytes,
            thresholdBytes: wasmRecycleThresholdBytes,
        };
    }

    function cacheTokenResult(job, value) {
        if (!job || job.worker !== worker) return;
        if (job.op === "release") {
            const token = job.payload && job.payload.token;
            if (typeof token === "string") workerCacheTokens.delete(token);
            return;
        }
        const payload = job.payload;
        const token = job.op === "prime"
            ? payload && payload.token
            : (job.op === "repairGeometry" && value && value.primeReady === true
                ? payload && payload.primeToken : null);
        if (typeof token === "string") workerCacheTokens.add(token);
    }

    function scheduleMemoryRecycle() {
        if (recycleTimer !== null) return;
        recycleTimer = root.setTimeout(() => {
            recycleTimer = null;
            if (!recyclePending || active || workerCacheTokens.size) return;
            if (degraded || !worker) {
                recyclePending = false;
                return;
            }
            recyclePending = false;
            runtimeFailures = 0;
            stopWorker();
            degraded = false;
            startWorker();
        }, 0);
    }

    function requestMemoryRecycle() {
        if (degraded || !worker
            || workerWasmBytes === null
            || workerWasmBytes <= wasmRecycleThresholdBytes) return;
        recyclePending = true;
        lastRecycleReason = "worker-wasm-threshold";
        scheduleMemoryRecycle();
    }

    function inspectWorkerAfterOp(job, value) {
        const target = job.worker;
        if (!target || target !== worker || degraded) return null;
        if (job.op === "memoryStats") {
            rememberWorkerMemory(value);
            requestMemoryRecycle();
            return null;
        }
        return run("memoryStats").then((report) => {
            if (worker !== target || degraded) return;
            rememberWorkerMemory(report);
            requestMemoryRecycle();
        });
    }

    function releaseWorkerUrl() {
        if (workerUrlTimer !== null) {
            root.clearTimeout(workerUrlTimer);
            workerUrlTimer = null;
        }
        if (workerUrl) {
            const url = workerUrl;
            workerUrl = null;
            root.URL.revokeObjectURL(url);
        }
    }

    function scheduleWorkerUrlRevoke(candidate) {
        if (!workerUrl) return;
        const url = workerUrl;
        workerUrlTimer = root.setTimeout(() => {
            if (worker === candidate && workerUrl === url) releaseWorkerUrl();
        }, WORKER_URL_REVOKE_FALLBACK_MS);
    }

    function terminateWorker(target) {
        target.onmessage = null;
        target.onerror = null;
        target.terminate();
        liveWorkers.delete(target);
        lastTerminatedWorker = target;
    }

    function makeCancelSignal() {
        if (typeof root.SharedArrayBuffer !== "function"
            || typeof root.Atomics !== "object") return null;
        try {
            return new Int32Array(new root.SharedArrayBuffer(4));
        } catch (_) {
            return null;
        }
    }

    function stopWorker() {
        finishReady(false);
        if (worker) terminateWorker(worker);
        worker = null;
        workerCancelSignal = null;
        workerCacheTokens.clear();
        workerWasmBytes = null;
        workerWasmSource = "unavailable";
        workerJsHeapBytes = null;
        releaseWorkerUrl();
        readyState = "idle";
        readyPromise = null;
    }

    function markDegraded(error) {
        degraded = true;
        recyclePending = false;
        if (recycleTimer !== null) {
            root.clearTimeout(recycleTimer);
            recycleTimer = null;
        }
        if (worker) terminateWorker(worker);
        worker = null;
        workerCancelSignal = null;
        workerCacheTokens.clear();
        workerWasmBytes = null;
        workerWasmSource = "unavailable";
        workerJsHeapBytes = null;
        releaseWorkerUrl();
        readyState = "degraded";
        finishReady(false);
        if (root.console && typeof root.console.warn === "function") {
            root.console.warn("Compute worker unavailable; using main-thread fallback.", error);
        }
    }

    function settle(job, succeeded, value) {
        if (active !== job) return;
        active = null;
        if (job.cancelTimer !== null) {
            root.clearTimeout(job.cancelTimer);
            job.cancelTimer = null;
        }
        if (succeeded) {
            cacheTokenResult(job, value);
            const inspection = inspectWorkerAfterOp(job, value);
            if (inspection) {
                inspection.then(() => job.resolve(value), () => job.resolve(value));
            } else job.resolve(value);
        } else {
            job.reject(value);
            if (recyclePending) scheduleMemoryRecycle();
        }
    }

    function handleWorkerMessage(event) {
        const message = event.data || {};
        if (message.type === "ready") {
            releaseWorkerUrl();
            readyState = "ready";
            degraded = false;
            finishReady(true);
            return;
        }
        if (message.type === "init-error") {
            releaseWorkerUrl();
            markDegraded(errorFromWire(message.error));
            return;
        }
        if (!active || message.id !== active.id) return;
        if (hasOwn(message, "progress")) {
            active.onProgress(message.progress);
            return;
        }
        if (hasOwn(message, "result")) {
            if (active.cancelRequested) settle(active, false, new ComputeCancelled());
            else {
                runtimeFailures = 0;
                settle(active, true, message.result);
            }
        } else if (hasOwn(message, "error")) {
            const error = errorFromWire(message.error);
            if (active.cancelRequested && error.name === "ComputeCancelled") {
                settle(active, false, new ComputeCancelled());
            } else settle(active, false, error);
        }
    }

    function handleWorkerError(event) {
        const message = event && event.message ? event.message : "Compute worker failed";
        const error = new Error(message);
        if (readyState === "starting") {
            markDegraded(error);
            return;
        }
        if (active) settle(active, false, error);
        runtimeFailures++;
        if (runtimeFailures >= 2) {
            markDegraded(error);
            return;
        }
        stopWorker();
        degraded = false;
        startWorker();
    }

    function startWorker() {
        if (readyState === "ready") return Promise.resolve(true);
        if (readyState === "starting") return readyPromise;
        if (readyState === "degraded") return Promise.resolve(false);

        readyState = "starting";
        readyPromise = new Promise((resolve) => { resolveReady = resolve; });
        let candidate = null;
        try {
            const source = root[SOURCE_KEY];
            if (typeof root.Blob !== "function" || !root.URL
                || typeof root.URL.createObjectURL !== "function"
                || typeof root.URL.revokeObjectURL !== "function"
                || typeof root.Worker !== "function") {
                throw new Error("Blob workers are unavailable");
            }
            if (typeof source !== "string" || !source) {
                throw new Error("generated compute worker source is missing");
            }
            const blob = new root.Blob([source], { type: "application/javascript" });
            workerUrl = root.URL.createObjectURL(blob);
            candidate = new root.Worker(workerUrl);
            worker = candidate;
            liveWorkers.add(candidate);
            workerCancelSignal = makeCancelSignal();
            candidate.onmessage = (event) => {
                if (worker === candidate) handleWorkerMessage(event);
            };
            candidate.onerror = (event) => {
                if (worker === candidate) handleWorkerError(event);
            };
            scheduleWorkerUrlRevoke(candidate);
            if (workerCancelSignal) {
                try {
                    candidate.postMessage({
                        type: "control", cancelBuffer: workerCancelSignal.buffer,
                    });
                } catch (_) {
                    workerCancelSignal = null;
                }
            }
        } catch (error) {
            if (candidate && candidate !== worker) terminateWorker(candidate);
            markDegraded(error);
        }
        return readyPromise;
    }

    function ready() {
        return startWorker();
    }

    function normalizeGeometry(payload) {
        const source = payload && payload.geometry ? payload.geometry
            : (payload && payload.source ? payload.source : payload);
        if (!source || source.vertProperties === undefined || source.triVerts === undefined) {
            throw new TypeError("geometry payload needs vertProperties and triVerts");
        }
        const vertProperties = source.vertProperties instanceof Float32Array
            ? source.vertProperties : new Float32Array(source.vertProperties);
        const triVerts = source.triVerts instanceof Uint32Array
            ? source.triVerts : new Uint32Array(source.triVerts);
        return { vertProperties, triVerts };
    }

    function geometryAdapter(payload) {
        const arrays = normalizeGeometry(payload);
        const position = {
            count: arrays.vertProperties.length / 3,
            getX: (index) => arrays.vertProperties[index * 3],
            getY: (index) => arrays.vertProperties[index * 3 + 1],
            getZ: (index) => arrays.vertProperties[index * 3 + 2],
        };
        const index = {
            count: arrays.triVerts.length,
            getX: (offset) => arrays.triVerts[offset],
        };
        return {
            vertProperties: arrays.vertProperties,
            triVerts: arrays.triVerts,
            getAttribute(name) {
                if (name !== "position") throw new Error(`unsupported geometry attribute ${name}`);
                return position;
            },
            getIndex: () => index,
        };
    }

    /* Copy a live BufferGeometry into transfer-ready arrays. Callers own the
       copies and may transfer their buffers without detaching scene geometry. */
    function geometryPayload(geometry) {
        const position = geometry && typeof geometry.getAttribute === "function"
            ? geometry.getAttribute("position") : null;
        if (!position) throw new TypeError("geometry payload needs a position attribute");
        const vertProperties = new Float32Array(position.count * 3);
        if (position.array && position.array.length === vertProperties.length) {
            vertProperties.set(position.array);
        } else {
            for (let i = 0; i < position.count; i++) {
                vertProperties[i * 3] = position.getX(i);
                vertProperties[i * 3 + 1] = position.getY(i);
                vertProperties[i * 3 + 2] = position.getZ(i);
            }
        }
        const sourceIndex = geometry.getIndex();
        const triVerts = new Uint32Array(sourceIndex ? sourceIndex.count : position.count);
        if (sourceIndex && sourceIndex.array && sourceIndex.array.length === triVerts.length) {
            triVerts.set(sourceIndex.array);
        } else {
            for (let i = 0; i < triVerts.length; i++) {
                triVerts[i] = sourceIndex ? sourceIndex.getX(i) : i;
            }
        }
        return { vertProperties, triVerts };
    }

    function yieldGeometryCopy() {
        return new Promise((resolve) => root.setTimeout(resolve, 0));
    }

    async function geometryPayloadAsync(geometry) {
        const position = geometry && typeof geometry.getAttribute === "function"
            ? geometry.getAttribute("position") : null;
        if (!position) throw new TypeError("geometry payload needs a position attribute");
        const vertProperties = new Float32Array(position.count * 3);
        const directPositions = position.array
            && typeof position.array.subarray === "function"
            && position.array.length === vertProperties.length;
        const positionChunk = Math.max(1, Math.floor(GEOMETRY_COPY_CHUNK / 3));
        for (let first = 0; first < position.count; first += positionChunk) {
            const last = Math.min(first + positionChunk, position.count);
            const start = first * 3, end = last * 3;
            if (directPositions) {
                vertProperties.set(position.array.subarray(start, end), start);
            } else {
                for (let i = first; i < last; i++) {
                    vertProperties[i * 3] = position.getX(i);
                    vertProperties[i * 3 + 1] = position.getY(i);
                    vertProperties[i * 3 + 2] = position.getZ(i);
                }
            }
            if (last < position.count) await yieldGeometryCopy();
        }
        const sourceIndex = geometry.getIndex();
        const triVerts = new Uint32Array(sourceIndex ? sourceIndex.count : position.count);
        const directIndices = sourceIndex && sourceIndex.array
            && typeof sourceIndex.array.subarray === "function"
            && sourceIndex.array.length === triVerts.length;
        for (let start = 0; start < triVerts.length; start += GEOMETRY_COPY_CHUNK) {
            const end = Math.min(start + GEOMETRY_COPY_CHUNK, triVerts.length);
            if (directIndices) {
                triVerts.set(sourceIndex.array.subarray(start, end), start);
            } else {
                for (let i = start; i < end; i++) {
                    triVerts[i] = sourceIndex ? sourceIndex.getX(i) : i;
                }
            }
            if (end < triVerts.length) await yieldGeometryCopy();
        }
        return { vertProperties, triVerts };
    }

    function scaleValue(payload) {
        const scale = payload && payload.scale === undefined ? 1
            : (payload ? Number(payload.scale) : 1);
        if (!Number.isFinite(scale) || scale <= 0) {
            throw new RangeError("geometry scale must be positive");
        }
        return scale;
    }

    function sourceFromPayload(payload) {
        const scale = scaleValue(payload);
        const source = root.CutCore.toManifold(geometryAdapter(payload));
        if (Math.abs(scale - 1) <= 1e-9) return source;
        try {
            const scaled = source.transform([
                scale, 0, 0, 0, 0, scale, 0, 0,
                0, 0, scale, 0, 0, 0, 0, 1,
            ]);
            source.delete();
            return scaled;
        } catch (error) {
            source.delete();
            throw error;
        }
    }

    function withMainSource(payload, fn) {
        const source = root.CutCore.toManifold(geometryAdapter(payload));
        try {
            return fn(source);
        } finally {
            source.delete();
        }
    }

    function mainCachedSource(payload) {
        if (!payload || typeof payload.token !== "string") {
            throw new TypeError("cached compute operation needs a cache token");
        }
        const source = mainCachedSources.get(payload.token);
        if (!source) throw new Error(`Unknown compute cache token: ${payload.token}`);
        return source;
    }

    function primeMainSource(payload) {
        if (!payload || typeof payload.token !== "string") {
            throw new TypeError("compute prime needs a cache token");
        }
        if (mainCachedSources.has(payload.token)) return { token: payload.token, reused: true };
        const source = sourceFromPayload(payload);
        mainCachedSources.set(payload.token, source);
        return { token: payload.token, reused: false };
    }

    function primeMainRepair(payload, result, sourcePayload = result) {
        if (!payload || typeof payload.primeToken !== "string" || !result) return result;
        result.primeReady = false;
        try {
            primeMainSource({ token: payload.primeToken, geometry: sourcePayload, scale: 1 });
            result.primeReady = true;
        } catch (_) {}
        return result;
    }

    function hollowResultArrays(result) {
        const arrays = CC.hollowCore.toArrays(result.hollow);
        return { vertProperties: arrays.vertProperties, triVerts: arrays.triVerts,
            stats: result.stats };
    }

    function repairGeometry(payload) {
        const geometry = geometryAdapter(payload);
        if (payload && payload.checkWatertight) {
            const boundary = root.CutCore.findBoundaryLoops(geometry);
            if (!boundary.boundaryEdges && !boundary.openChains
                && root.CutCore.isWatertight(geometry)) {
                return primeMainRepair(payload, { watertight: true }, payload);
            }
        }
        return primeMainRepair(payload, root.CutCore.repairGeometry(geometry));
    }

    const MAIN_OPS = {
        ping: (payload) => payload,
        repairGeometry,
        capBoundaryLoops: (payload) => {
            const geometry = normalizeGeometry(payload);
            return root.CutCore.capBoundaryLoops(geometry,
                payload && payload.precomputed ? payload.precomputed : null);
        },
        prime: (payload) => primeMainSource(payload),
        release: (payload) => {
            if (!payload || typeof payload.token !== "string") {
                throw new TypeError("compute release needs a cache token");
            }
            const source = mainCachedSources.get(payload.token);
            if (source) {
                source.delete();
                mainCachedSources.delete(payload.token);
            }
            return { token: payload.token, released: !!source };
        },
        hollowEstimate: (payload) => payload && payload.token
            ? CC.hollowCore.estimate(mainCachedSource(payload), payload.wallMm)
            : withMainSource(payload,
                (source) => CC.hollowCore.estimate(source, payload.wallMm)),
        previewShell: (payload) => payload && payload.token
            ? CC.hollowCore.previewShell(mainCachedSource(payload), payload.wallMm,
                payload.opts || {})
            : withMainSource(payload,
                (source) => CC.hollowCore.previewShell(source, payload.wallMm,
                    payload.opts || payload || {})),
        hollowApply: (payload) => {
            const run = CC.hollowCore.hollow(mainCachedSource(payload), payload.wallMm,
                payload.opts || {});
            try {
                return hollowResultArrays(run);
            } finally {
                run.hollow.delete();
            }
        },
    };

    function runMain(op, payload) {
        const handler = MAIN_OPS[op];
        if (typeof handler !== "function") {
            return Promise.reject(new Error(`Unknown compute operation: ${op}`));
        }
        if (op === "ping") return Promise.resolve().then(() => handler(payload));
        if (!root.CutCore || typeof root.CutCore.init !== "function") {
            return Promise.reject(new Error("CutCore is unavailable for degraded compute"));
        }
        return root.CutCore.init().then(() => handler(payload));
    }

    function transferBuffers(values) {
        if (values === undefined || values === null) return [];
        if (!Array.isArray(values)) throw new TypeError("transfer must be an array");
        const buffers = [];
        const seen = new Set();
        for (const value of values) {
            const buffer = value instanceof ArrayBuffer
                ? value : (ArrayBuffer.isView(value) ? value.buffer : null);
            if (!buffer) throw new TypeError("transfer entries must be ArrayBuffers or views");
            if (!seen.has(buffer)) {
                seen.add(buffer);
                buffers.push(buffer);
            }
        }
        return buffers;
    }

    function recycle() {
        if (active) settle(active, false, new ComputeCancelled());
        recyclePending = false;
        if (recycleTimer !== null) {
            root.clearTimeout(recycleTimer);
            recycleTimer = null;
        }
        runtimeFailures = 0;
        stopWorker();
        degraded = false;
        return startWorker();
    }

    function cancel(id) {
        const cancelId = id && typeof id === "object" ? id.id : id;
        if (!active || active.id !== cancelId) return false;
        const job = active;
        job.cancelRequested = true;
        if (!worker || readyState !== "ready" || degraded) {
            settle(job, false, new ComputeCancelled());
            return true;
        }
        if (workerCancelSignal) root.Atomics.store(workerCancelSignal, 0, 1);
        try { worker.postMessage({ type: "cancel", id: cancelId }); } catch (_) {}
        job.cancelTimer = root.setTimeout(() => {
            if (active !== job) return;
            settle(job, false, new ComputeCancelled());
            recycle();
        }, CANCEL_GRACE_MS);
        return true;
    }

    function postJob(job) {
        if (active !== job) return;
        if (job.cancelRequested) {
            settle(job, false, new ComputeCancelled());
            return;
        }
        if (workerCancelSignal) root.Atomics.store(workerCancelSignal, 0, 0);
        job.worker = worker;
        try {
            worker.postMessage({ id: job.id, op: job.op, payload: job.payload },
                transferBuffers(job.options.transfer));
        } catch (error) {
            settle(job, false, error);
        }
    }

    function run(op, payload, options = {}) {
        options = options || {};
        if (active) throw new Error("CC.compute is busy");
        const id = nextId++;
        const job = { id, op, payload, options,
            onProgress: typeof options.onProgress === "function" ? options.onProgress : () => {},
            resolve: null, reject: null, cancelRequested: false, cancelTimer: null,
            worker: null };
        const promise = new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;
        });
        promise.id = id;
        active = job;

        const dispatch = () => {
            if (readyState === "ready" && !degraded && worker) return true;
            return ready();
        };
        Promise.resolve().then(dispatch).then((workerReady) => {
            if (active !== job) return;
            if (!workerReady || degraded || !worker) {
                runMain(op, payload).then(
                    (result) => settle(job, true, result),
                    (error) => settle(job, false, error));
                return;
            }
            postJob(job);
        }, (error) => settle(job, false, error));

        return promise;
    }

    function memoryReport() {
        const workerMemory = workerMemoryReport();
        const history = CC.history && typeof CC.history.memoryReport === "function"
            ? CC.history.memoryReport() : null;
        const cache = CC.bigPrint && typeof CC.bigPrint._memoryReport === "function"
            ? CC.bigPrint._memoryReport() : null;
        const mainCacheCount = cache && Number.isFinite(cache.liveMainManifoldCacheCount)
            ? cache.liveMainManifoldCacheCount : 0;
        const workerCacheCount = cache && Number.isFinite(cache.liveHollowComputeCacheCount)
            ? cache.liveHollowComputeCacheCount : 0;
        const historyBytes = history && Number.isFinite(history.retainedBytes)
            ? history.retainedBytes : null;
        const historyTris = history && Number.isFinite(history.retainedTris)
            ? history.retainedTris : null;
        const liveMainManifoldCacheCount = mainCachedSources.size + mainCacheCount;
        const liveManifoldCacheCount = liveMainManifoldCacheCount + workerCacheCount;
        return {
            jsHeapBytes: mainHeapBytes(),
            jsHeapLimitBytes: root.performance && root.performance.memory
                ? finiteBytes(root.performance.memory.jsHeapSizeLimit) : null,
            workerWasmBytes: workerMemory.bytes,
            workerWasmHeapBytes: workerMemory.bytes,
            workerWasmSource: workerMemory.source,
            workerJsHeapBytes: workerMemory.jsHeapBytes,
            workerWasmThresholdBytes: wasmRecycleThresholdBytes,
            workerCacheTokenCount: workerCacheTokens.size,
            recyclePending,
            lastRecycleReason,
            historyRetainedBytes: historyBytes,
            historyRetainedTris: historyTris,
            historyCapTris: history && Number.isFinite(history.capTris)
                ? history.capTris : null,
            history,
            liveManifoldCacheCount,
            mainCachedManifoldCount: mainCachedSources.size,
            liveMainManifoldCacheCount,
            liveWorkerManifoldCacheCount: workerCacheCount,
            cache,
        };
    }

    function setTestWasmRecycleThreshold(value) {
        if (!Number.isFinite(value) || value < 0) {
            throw new RangeError("test WASM recycle threshold must be finite and non-negative");
        }
        wasmRecycleThresholdBytes = Math.round(value);
        return wasmRecycleThresholdBytes;
    }

    const api = {
        run, cancel, recycle, ready, geometryPayload, geometryPayloadAsync, ComputeCancelled,
    };
    Object.defineProperty(api, "_testSetWasmRecycleThreshold", {
        value: setTestWasmRecycleThreshold,
    });
    Object.defineProperty(api, "degraded", {
        enumerable: true,
        get: () => degraded,
    });
    Object.defineProperty(api, "_worker", {
        get: () => worker,
    });
    Object.defineProperty(api, "_workerCount", {
        get: () => liveWorkers.size,
    });
    Object.defineProperty(api, "_lastTerminatedWorker", {
        get: () => lastTerminatedWorker,
    });
    CC.compute = api;
    CC.memoryReport = memoryReport;
})();
