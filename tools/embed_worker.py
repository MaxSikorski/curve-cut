#!/usr/bin/env python3
"""Embed the file:// compute worker source.

Chromium blocks workers loaded from sibling file URLs on a plain file:// page.
This generator makes the worker a deterministic Blob source containing the
vendored Manifold loader and the DOM-free engine cores.

    uv run --no-project python tools/embed_worker.py
    uv run --no-project python tools/embed_worker.py --check

The default command rewrites the checked-in generated script. ``--check``
reports the generated path and exits 1 when it is stale.
"""

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "js" / "compute-worker-src.js"
SOURCES = (
    ROOT / "vendor" / "three" / "three.min.js",
    ROOT / "vendor" / "manifold" / "manifold.wasm.b64.js",
    ROOT / "vendor" / "manifold" / "manifold.js",
    ROOT / "js" / "cut-core.js",
    ROOT / "js" / "hollow-core.js",
)
CHUNK_SIZE = 64000

HEADER = """/* GENERATED FILE — do not edit.
   Source assembly: tools/embed_worker.py
   Re-run after editing vendor/three/three.min.js, vendor/manifold/manifold.wasm.b64.js,
   vendor/manifold/manifold.js,
   js/cut-core.js, or js/hollow-core.js.
   The Blob worker owns transferred input buffers until result buffers are sent back. */
"""

BOOTSTRAP = """/* Blob workers have no window object; the embedded classic sources expect one. */
self.window = self;
"""

WORKER_SHELL = r'''
/* --------------------------- compute worker shell ----------------------- */
(() => {
    "use strict";

    const root = globalThis;
    const CC = root.CurveCut = root.CurveCut || {};
    const MESSAGE_YIELD_MS = 10;
    let initialized = false;
    let activeId = null;
    let cancelRequested = false;
    let cancelSignal = null;
    const cachedSources = new Map();
    let wasmMemory = null;

    /* The bundled Emscripten loader keeps wasmMemory private. Capture the
       exported memory once; stats read only its current buffer size. */
    const originalManifoldModule = root.ManifoldModule;
    root.ManifoldModule = (moduleArg) => {
        const options = Object.assign({}, moduleArg, {
            instantiateWasm(info, receiveInstance) {
                WebAssembly.instantiate(options.wasmBinary, info).then((result) => {
                    const exports = result.instance.exports;
                    for (const name of Object.keys(exports)) {
                        if (exports[name] instanceof WebAssembly.Memory) {
                            wasmMemory = exports[name];
                            break;
                        }
                    }
                    receiveInstance(result.instance, result.module);
                });
                return {};
            },
        });
        return originalManifoldModule(options);
    };

    class WorkerComputeCancelled extends Error {
        constructor() {
            super("Compute operation cancelled");
            this.name = "ComputeCancelled";
        }
    }

    function serializeError(error) {
        return {
            name: error && error.name ? String(error.name) : "Error",
            message: error && error.message ? String(error.message) : String(error),
            stack: error && error.stack ? String(error.stack) : "",
        };
    }

    function isCancelled() {
        return cancelRequested || (cancelSignal && Atomics.load(cancelSignal, 0) !== 0);
    }

    function checkCancelled() {
        if (isCancelled()) throw new WorkerComputeCancelled();
    }

    function normalizeGeometry(payload) {
        const source = payload && payload.geometry ? payload.geometry
            : (payload && payload.source ? payload.source : payload);
        if (!source || source.vertProperties === undefined || source.triVerts === undefined) {
            throw new TypeError("geometry payload needs vertProperties and triVerts");
        }
        return {
            vertProperties: source.vertProperties instanceof Float32Array
                ? source.vertProperties : new Float32Array(source.vertProperties),
            triVerts: source.triVerts instanceof Uint32Array
                ? source.triVerts : new Uint32Array(source.triVerts),
        };
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
        const source = CutCore.toManifold(geometryAdapter(payload));
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

    function withSource(payload, fn) {
        const source = CutCore.toManifold(geometryAdapter(payload));
        try {
            return fn(source);
        } finally {
            source.delete();
        }
    }

    function cachedSource(payload) {
        if (!payload || typeof payload.token !== "string") {
            throw new TypeError("cached compute operation needs a cache token");
        }
        const source = cachedSources.get(payload.token);
        if (!source) throw new Error(`Unknown compute cache token: ${payload.token}`);
        return source;
    }

    function withCachedOrSource(payload, fn) {
        return payload && payload.token
            ? fn(cachedSource(payload)) : withSource(payload, fn);
    }

    function primeSource(payload) {
        if (!payload || typeof payload.token !== "string") {
            throw new TypeError("compute prime needs a cache token");
        }
        if (cachedSources.has(payload.token)) return { token: payload.token, reused: true };
        const source = sourceFromPayload(payload);
        cachedSources.set(payload.token, source);
        return { token: payload.token, reused: false };
    }

    function storeRepairSource(token, source) {
        if (!token) {
            source.delete();
            return false;
        }
        if (cachedSources.has(token)) {
            source.delete();
            return true;
        }
        cachedSources.set(token, source);
        return true;
    }

    function releaseSource(payload) {
        if (!payload || typeof payload.token !== "string") {
            throw new TypeError("compute release needs a cache token");
        }
        const source = cachedSources.get(payload.token);
        if (source) {
            source.delete();
            cachedSources.delete(payload.token);
        }
        return { token: payload.token, released: !!source };
    }

    function memoryStats() {
        const result = {
            wasmHeapBytes: wasmMemory && wasmMemory.buffer
                ? wasmMemory.buffer.byteLength : null,
        };
        const memory = root.performance && root.performance.memory;
        if (memory && Number.isFinite(memory.usedJSHeapSize)) {
            result.jsHeapBytes = Math.round(memory.usedJSHeapSize);
        }
        return result;
    }

    function hollowResultArrays(result) {
        const arrays = CC.hollowCore.toArrays(result.hollow);
        return { vertProperties: arrays.vertProperties, triVerts: arrays.triVerts,
            stats: result.stats };
    }

    function repairGeometry(payload) {
        const geometry = geometryAdapter(payload);
        const primeToken = payload && typeof payload.primeToken === "string"
            ? payload.primeToken : null;
        if (payload && payload.checkWatertight) {
            const boundary = CutCore.findBoundaryLoops(geometry);
            if (!boundary.boundaryEdges && !boundary.openChains) {
                try {
                    const source = CutCore.toManifold(geometry);
                    const result = { watertight: true };
                    if (primeToken) result.primeReady = storeRepairSource(primeToken, source);
                    else source.delete();
                    return result;
                } catch (_) {}
            }
        }
        const result = CutCore.repairGeometry(geometry);
        if (!result || !primeToken) return result;
        result.primeReady = false;
        try {
            primeSource({ token: primeToken, geometry: result, scale: 1 });
            result.primeReady = true;
        } catch (_) {}
        return result;
    }

    /* One entry per supported protocol op keeps W3 additions local to this registry. */
    const OPS = {
        ping: (payload) => payload,
        memoryStats,
        repairGeometry,
        capBoundaryLoops: (payload) => {
            const geometry = normalizeGeometry(payload);
            return CutCore.capBoundaryLoops(geometry,
                payload && payload.precomputed ? payload.precomputed : null);
        },
        prime: (payload) => primeSource(payload),
        release: (payload) => releaseSource(payload),
        hollowEstimate: (payload, id) => hollowEstimate(payload, id),
        previewShell: (payload) => withCachedOrSource(payload,
            (source) => CC.hollowCore.previewShell(source, payload.wallMm,
                payload.opts || {})),
        hollowApply: (payload, id) => hollowApply(payload, id),
        cutWithCutter: (payload, id) => cutWithCutter(payload, id),
    };

    function collectTransferables(value, result = [], seen = new Set()) {
        if (value instanceof ArrayBuffer) {
            if (!seen.has(value)) {
                seen.add(value);
                result.push(value);
            }
            return result;
        }
        if (ArrayBuffer.isView(value)) {
            collectTransferables(value.buffer, result, seen);
            return result;
        }
        if (!value || typeof value !== "object") return result;
        if (seen.has(value)) return result;
        seen.add(value);
        if (Array.isArray(value)) {
            for (const item of value) collectTransferables(item, result, seen);
        } else {
            for (const key of Object.keys(value)) {
                collectTransferables(value[key], result, seen);
            }
        }
        return result;
    }

    function progress(id, stage, fraction) {
        root.postMessage({ id, progress: { stage, fraction } });
        checkCancelled();
    }

    function hollowEstimate(payload, id) {
        progress(id, "hollow-estimate", 0);
        return new Promise((resolve, reject) => {
            root.setTimeout(() => {
                try {
                    checkCancelled();
                    const value = withCachedOrSource(payload,
                        (source) => CC.hollowCore.estimate(source, payload.wallMm));
                    progress(id, "hollow-estimate", 1);
                    resolve(value);
                } catch (error) {
                    reject(error);
                }
            }, MESSAGE_YIELD_MS);
        });
    }

    function hollowApply(payload, id) {
        progress(id, "hollow-apply", 0);
        return new Promise((resolve, reject) => {
            root.setTimeout(() => {
                let result = null;
                try {
                    checkCancelled();
                    result = withCachedOrSource(payload, (source) => CC.hollowCore.hollow(
                        source, payload.wallMm, Object.assign({}, payload.opts || {}, {
                            onProgress: (stage, fraction) => progress(id, stage, fraction),
                            shouldCancel: isCancelled,
                        })));
                    const output = hollowResultArrays(result);
                    result.hollow.delete();
                    result = null;
                    resolve(output);
                } catch (error) {
                    if (result) result.hollow.delete();
                    reject(error);
                }
            }, MESSAGE_YIELD_MS);
        });
    }

    function vector3(value) {
        if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)
            || !Number.isFinite(value.z)) {
            throw new TypeError("cutter spec needs finite 3D coordinates");
        }
        return new THREE.Vector3(value.x, value.y, value.z);
    }

    function bounds3(value) {
        if (!value || !value.min || !value.max) {
            throw new TypeError("cutter spec needs bounds");
        }
        return new THREE.Box3(vector3(value.min), vector3(value.max));
    }

    function buildCutterPair(spec) {
        if (!spec || typeof spec.type !== "string") {
            throw new TypeError("cutWithCutter needs a cutter spec");
        }
        let inside = null;
        let outside = null;
        try {
            if (spec.type === "spline") {
                inside = CutCore.buildCutter(spec.spline, spec.extendLen, spec.halfDepth,
                    spec.growInside || 0);
                outside = spec.growOutside > 0
                    ? CutCore.buildCutter(spec.spline, spec.extendLen, spec.halfDepth,
                        spec.growOutside)
                    : inside;
            } else if (spec.type === "planar") {
                const point = vector3(spec.point);
                const normal = vector3(spec.normal);
                const bounds = bounds3(spec.bounds);
                inside = CutCore.buildPlanarCutter(point, normal, bounds);
                outside = spec.gap > 0
                    ? CutCore.buildPlanarCutter(point.clone().addScaledVector(normal, spec.gap),
                        normal, bounds)
                    : inside;
            } else if (spec.type === "dovetail") {
                const bounds = bounds3(spec.bounds);
                inside = CutCore.buildDovetailCutter(spec.params, bounds);
                outside = CutCore.buildDovetailCutter(spec.params, bounds,
                    spec.shrinkOutside || { w: 0, d: 0 });
            } else {
                throw new TypeError(`unknown cutter spec: ${spec.type}`);
            }
            return { inside, outside };
        } catch (error) {
            if (inside) inside.delete();
            if (outside && outside !== inside) outside.delete();
            throw error;
        }
    }

    function buildConnectors(spec) {
        if (!spec) return null;
        const make = (entry) => CutCore.buildConnectorSolid({
            pos: vector3(entry.pos), normal: vector3(entry.normal), shape: entry.shape,
            size: entry.size, depth: entry.depth, rotDeg: entry.rotDeg,
        }, entry.grow || { r: 0, d: 0 });
        const connectors = { pegs: [], sockets: [], maleSide: spec.maleSide };
        try {
            for (const entry of spec.pegs || []) connectors.pegs.push(make(entry));
            for (const entry of spec.sockets || []) connectors.sockets.push(make(entry));
            return connectors;
        } catch (error) {
            for (const solid of connectors.pegs.concat(connectors.sockets)) solid.delete();
            throw error;
        }
    }

    function deleteConnectors(connectors) {
        if (!connectors) return;
        for (const solid of connectors.pegs.concat(connectors.sockets)) solid.delete();
    }

    function pieceArrays(geometry) {
        if (!geometry) return null;
        const position = geometry.getAttribute("position");
        const index = geometry.getIndex();
        return {
            // Constructors copy even if a future core implementation exposes a heap view.
            vertProperties: new Float32Array(position.array),
            triVerts: new Uint32Array(index.array),
        };
    }

    function cutWithCutter(payload, id) {
        const parts = Array.isArray(payload && payload.parts)
            ? payload.parts : [payload && payload.geometry ? payload.geometry : payload];
        if (!parts.length) throw new TypeError("cutWithCutter needs at least one geometry");
        const cutters = buildCutterPair(payload.cutter);
        const connectors = buildConnectors(payload.connectors);
        const results = [];
        try {
            progress(id, "cut", 0);
            for (let i = 0; i < parts.length; i++) {
                checkCancelled();
                let split = null;
                try {
                    split = CutCore.cutWithCutter(geometryAdapter(parts[i]),
                        cutters.inside, cutters.outside, connectors);
                    results.push({
                        inside: pieceArrays(split.inside),
                        outside: pieceArrays(split.outside),
                    });
                } catch (error) {
                    if (error.message === "not-watertight") {
                        return { results, failedAt: i, error: "not-watertight" };
                    }
                    throw error;
                } finally {
                    if (split && split.inside) split.inside.dispose();
                    if (split && split.outside) split.outside.dispose();
                }
                progress(id, "cut", (i + 1) / parts.length);
            }
            return { results };
        } finally {
            cutters.inside.delete();
            if (cutters.outside !== cutters.inside) cutters.outside.delete();
            deleteConnectors(connectors);
        }
    }

    function runMessage(message) {
        const handler = OPS[message.op];
        if (typeof handler !== "function") {
            throw new Error(`Unknown compute operation: ${message.op}`);
        }
        activeId = message.id;
        cancelRequested = false;
        if (cancelSignal) Atomics.store(cancelSignal, 0, 0);
        return Promise.resolve().then(() => {
            progress(message.id, "compute", 0);
            return new Promise((resolve, reject) => {
                root.setTimeout(() => {
                    try {
                        checkCancelled();
                        resolve(handler(message.payload, message.id));
                    } catch (error) {
                        reject(error);
                    }
                }, MESSAGE_YIELD_MS);
            });
        }).then((result) => new Promise((resolve, reject) => {
            root.setTimeout(() => {
                try {
                    checkCancelled();
                    progress(message.id, "compute", 1);
                    root.postMessage({ id: message.id, result }, collectTransferables(result));
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }, 0);
        })).catch((error) => {
            const output = error && error.name === "HollowCancelled"
                ? new WorkerComputeCancelled() : error;
            root.postMessage({ id: message.id, error: serializeError(output) });
        }).finally(() => {
            activeId = null;
            cancelRequested = false;
            if (cancelSignal) Atomics.store(cancelSignal, 0, 0);
        });
    }

    root.addEventListener("message", (event) => {
        const message = event.data || {};
        if (message.type === "control") {
            cancelSignal = message.cancelBuffer ? new Int32Array(message.cancelBuffer) : null;
            return;
        }
        if (message.type === "cancel") {
            if (activeId === message.id) cancelRequested = true;
            if (activeId === message.id && cancelSignal) Atomics.store(cancelSignal, 0, 1);
            return;
        }
        if (message.op === "__test_runtime_error__") throw new Error("forced runtime worker error");
        if (!initialized) {
            root.postMessage({ id: message.id, error: serializeError(
                new Error("compute worker is not initialized")) });
            return;
        }
        if (activeId !== null) {
            root.postMessage({ id: message.id, error: serializeError(
                new Error("compute worker is busy")) });
            return;
        }
        if (typeof OPS[message.op] !== "function") {
            root.postMessage({ id: message.id, error: serializeError(
                new Error(`Unknown compute operation: ${message.op}`)) });
            return;
        }
        runMessage(message);
    });

    CutCore.init().then(() => {
        initialized = true;
        root.postMessage({ type: "ready" });
    }, (error) => {
        root.postMessage({ type: "init-error", error: serializeError(error) });
    });
})();
'''


def read_source(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(path)
    return path.read_bytes().decode("utf-8")


def build() -> str:
    parts = [BOOTSTRAP]
    parts.extend(read_source(path) for path in SOURCES)
    parts.append(WORKER_SHELL)
    source = "\n\n".join(part.rstrip("\n") for part in parts) + "\n"
    literals = []
    for offset in range(0, len(source), CHUNK_SIZE):
        literals.append("    " + json.dumps(
            source[offset:offset + CHUNK_SIZE], ensure_ascii=True))
    return HEADER + "window.CurveCutComputeWorkerSource =\n" \
        + " +\n".join(literals) + ";\n"


def relative(path: Path) -> str:
    return str(path.relative_to(ROOT))


def main() -> int:
    args = sys.argv[1:]
    if args not in ([], ["--check"]):
        print("usage: uv run --no-project python tools/embed_worker.py [--check]")
        return 2
    try:
        generated = build()
    except (FileNotFoundError, OSError) as error:
        print(f"FAIL: cannot assemble worker source: {error}")
        return 1

    existing = DST.read_bytes().decode("utf-8") if DST.exists() else None
    if args == ["--check"]:
        if existing != generated:
            print(f"WARNING: generated worker source mismatch: {relative(DST)}")
            return 1
        print(f"worker source check ok: {relative(DST)}")
        return 0

    if existing is not None and existing != generated:
        print(f"WARNING: replacing stale generated worker source: {relative(DST)}")
    DST.write_bytes(generated.encode("utf-8"))
    print(f"ok   {relative(DST)}: {len(generated):,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
