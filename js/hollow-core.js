/* Embedded into js/compute-worker-src.js — run `uv run --no-project python tools/embed_worker.py` after editing. */
/* Curve Cut — hybrid hollowing engine core.
   DOM-free mesh/QEF and signed-grid engines. The caller owns the returned
   Manifold; the source Manifold is never consumed. */

(() => {
    "use strict";

    const root = typeof window !== "undefined" ? window : globalThis;
    const CC = root.CurveCut = root.CurveCut || {};
    const MAX_GRID_VOXELS = 64000000;
    const MESH_TRIANGLE_LIMIT = 50000;
    const MAX_WALL_SAMPLES = 4096;
    const TRIPWIRE_RMS_MM = 0.05;
    const TRIPWIRE_MIN_FACTOR = 0.5;
    const TRIPWIRE_SHELL_FACTOR = 4;

    class HollowCancelled extends Error {
        constructor() {
            super("Hollowing cancelled");
            this.name = "HollowCancelled";
        }
    }

    class HollowGridTooLarge extends Error {
        constructor(voxels) {
            super(`Hollow grid needs ${voxels} voxels at wall-sized spacing`);
            this.name = "HollowGridTooLarge";
            this.voxels = voxels;
        }
    }

    function dispose(value) {
        if (value && typeof value.delete === "function") value.delete();
    }

    function now() {
        return typeof performance !== "undefined" ? performance.now() : Date.now();
    }

    function makeControl(opts, stageMs) {
        const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
        const shouldCancel = typeof opts.shouldCancel === "function" ? opts.shouldCancel : () => false;
        return {
            check() {
                if (shouldCancel()) throw new HollowCancelled();
            },
            progress(stage, frac) {
                onProgress(stage, frac);
                if (shouldCancel()) throw new HollowCancelled();
            },
            stage(stage, fn) {
                this.check();
                const started = now();
                const value = fn();
                stageMs[stage] = now() - started;
                onProgress(stage, 1);
                return value;
            },
        };
    }

    function arraysFromManifold(manifold) {
        const mesh = manifold.getMesh();
        const numProp = mesh.numProp || 3;
        const count = mesh.vertProperties.length / numProp;
        const vertProperties = new Float32Array(count * 3);
        for (let q = 0; q < count; q++) {
            const source = q * numProp, target = q * 3;
            vertProperties[target] = mesh.vertProperties[source];
            vertProperties[target + 1] = mesh.vertProperties[source + 1];
            vertProperties[target + 2] = mesh.vertProperties[source + 2];
        }
        return {
            vertProperties,
            triVerts: mesh.triVerts.slice(),
            Mesh: mesh.constructor,
            Manifold: manifold.constructor,
        };
    }

    function toArrays(manifold) {
        const arrays = arraysFromManifold(manifold);
        return { vertProperties: arrays.vertProperties.slice(), triVerts: arrays.triVerts.slice() };
    }

    function manifoldFromArrays(arrays) {
        const mesh = new arrays.Mesh({
            numProp: 3,
            vertProperties: arrays.vertProperties,
            triVerts: arrays.triVerts,
        });
        mesh.merge();
        const manifold = new arrays.Manifold(mesh);
        const status = typeof manifold.status === "function" ? String(manifold.status()) : "NoError";
        if (status !== "NoError") {
            dispose(manifold);
            throw new Error(`inner manifold status ${status}`);
        }
        return manifold;
    }

    function boundsOf(arrays) {
        const v = arrays.vertProperties;
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < v.length; i += 3) {
            for (let k = 0; k < 3; k++) {
                if (v[i + k] < min[k]) min[k] = v[i + k];
                if (v[i + k] > max[k]) max[k] = v[i + k];
            }
        }
        return { min, max, size: max.map((value, k) => value - min[k]) };
    }

    function signedVolume(arrays) {
        const v = arrays.vertProperties, t = arrays.triVerts;
        let sum = 0;
        for (let i = 0; i < t.length; i += 3) {
            const A = t[i] * 3, B = t[i + 1] * 3, C = t[i + 2] * 3;
            sum += (v[A] * (v[B + 1] * v[C + 2] - v[B + 2] * v[C + 1])
                + v[A + 1] * (v[B + 2] * v[C] - v[B] * v[C + 2])
                + v[A + 2] * (v[B] * v[C + 1] - v[B + 1] * v[C])) / 6;
        }
        return sum;
    }

    function solveSymmetric3(a00, a01, a02, a11, a12, a22, b0, b1, b2) {
        const c00 = a11 * a22 - a12 * a12;
        const c01 = a02 * a12 - a01 * a22;
        const c02 = a01 * a12 - a02 * a11;
        const c11 = a00 * a22 - a02 * a02;
        const c12 = a01 * a02 - a00 * a12;
        const c22 = a00 * a11 - a01 * a01;
        const det = a00 * c00 + a01 * c01 + a02 * c02;
        if (!Number.isFinite(det) || Math.abs(det) < 1e-24) return null;
        return [
            (c00 * b0 + c01 * b1 + c02 * b2) / det,
            (c01 * b0 + c11 * b1 + c12 * b2) / det,
            (c02 * b0 + c12 * b1 + c22 * b2) / det,
        ];
    }

    function qefOffset(arrays, wall) {
        const v = arrays.vertProperties, t = arrays.triVerts, nv = v.length / 3;
        const mat = new Float64Array(nv * 6), rhs = new Float64Array(nv * 3);
        const orientation = signedVolume(arrays) >= 0 ? 1 : -1;
        for (let i = 0; i < t.length; i += 3) {
            const ia = t[i], ib = t[i + 1], ic = t[i + 2];
            const A = ia * 3, B = ib * 3, C = ic * 3;
            const ux = v[B] - v[A], uy = v[B + 1] - v[A + 1], uz = v[B + 2] - v[A + 2];
            const wx = v[C] - v[A], wy = v[C + 1] - v[A + 1], wz = v[C + 2] - v[A + 2];
            let nx = orientation * (uy * wz - uz * wy);
            let ny = orientation * (uz * wx - ux * wz);
            let nz = orientation * (ux * wy - uy * wx);
            const area2 = Math.hypot(nx, ny, nz);
            if (area2 < 1e-18) continue;
            nx /= area2; ny /= area2; nz /= area2;
            for (const q of [ia, ib, ic]) {
                const m = q * 6, b = q * 3;
                mat[m] += area2 * nx * nx;
                mat[m + 1] += area2 * nx * ny;
                mat[m + 2] += area2 * nx * nz;
                mat[m + 3] += area2 * ny * ny;
                mat[m + 4] += area2 * ny * nz;
                mat[m + 5] += area2 * nz * nz;
                rhs[b] -= area2 * wall * nx;
                rhs[b + 1] -= area2 * wall * ny;
                rhs[b + 2] -= area2 * wall * nz;
            }
        }
        const out = new Float32Array(v.length), maxMove = wall * 4;
        for (let q = 0; q < nv; q++) {
            const m = q * 6, b = q * 3;
            const trace = mat[m] + mat[m + 3] + mat[m + 5];
            const lambda = Math.max(trace * 1e-8, 1e-18);
            let d = solveSymmetric3(mat[m] + lambda, mat[m + 1], mat[m + 2],
                mat[m + 3] + lambda, mat[m + 4], mat[m + 5] + lambda,
                rhs[b], rhs[b + 1], rhs[b + 2]) || [0, 0, 0];
            const length = Math.hypot(d[0], d[1], d[2]);
            if (length > maxMove) {
                const scale = maxMove / length;
                d = [d[0] * scale, d[1] * scale, d[2] * scale];
            }
            out[b] = v[b] + d[0];
            out[b + 1] = v[b + 1] + d[1];
            out[b + 2] = v[b + 2] + d[2];
        }
        return {
            vertProperties: out,
            triVerts: t.slice(),
            Mesh: arrays.Mesh,
            Manifold: arrays.Manifold,
        };
    }

    function normalOffset(arrays, wall) {
        const v = arrays.vertProperties, t = arrays.triVerts, n = new Float64Array(v.length);
        for (let i = 0; i < t.length; i += 3) {
            const A = t[i] * 3, B = t[i + 1] * 3, C = t[i + 2] * 3;
            const ux = v[B] - v[A], uy = v[B + 1] - v[A + 1], uz = v[B + 2] - v[A + 2];
            const wx = v[C] - v[A], wy = v[C + 1] - v[A + 1], wz = v[C + 2] - v[A + 2];
            const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
            for (const o of [A, B, C]) {
                n[o] += nx; n[o + 1] += ny; n[o + 2] += nz;
            }
        }
        const orientation = signedVolume(arrays) >= 0 ? 1 : -1;
        const out = new Float32Array(v.length);
        for (let i = 0; i < v.length; i += 3) {
            const length = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
            out[i] = v[i] - wall * orientation * n[i] / length;
            out[i + 1] = v[i + 1] - wall * orientation * n[i + 1] / length;
            out[i + 2] = v[i + 2] - wall * orientation * n[i + 2] / length;
        }
        return out;
    }

    function makeBVH(arrays) {
        const v = arrays.vertProperties, id = arrays.triVerts, nt = id.length / 3;
        const lo = new Float32Array(nt * 3), hi = new Float32Array(nt * 3);
        const center = new Float32Array(nt * 3);
        for (let q = 0; q < nt; q++) {
            for (let k = 0; k < 3; k++) {
                const x = v[id[q * 3] * 3 + k];
                const y = v[id[q * 3 + 1] * 3 + k];
                const z = v[id[q * 3 + 2] * 3 + k];
                lo[q * 3 + k] = Math.min(x, y, z);
                hi[q * 3 + k] = Math.max(x, y, z);
                center[q * 3 + k] = (x + y + z) / 3;
            }
        }
        function build(list) {
            const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
            for (const q of list) {
                for (let k = 0; k < 3; k++) {
                    min[k] = Math.min(min[k], lo[q * 3 + k]);
                    max[k] = Math.max(max[k], hi[q * 3 + k]);
                }
            }
            if (list.length <= 12) return { min, max, list };
            let axis = max[1] - min[1] > max[0] - min[0] ? 1 : 0;
            if (max[2] - min[2] > max[axis] - min[axis]) axis = 2;
            list.sort((a, b) => center[a * 3 + axis] - center[b * 3 + axis]);
            const middle = list.length >> 1;
            return { min, max, left: build(list.slice(0, middle)), right: build(list.slice(middle)) };
        }
        const root = build(Array.from({ length: nt }, (_, i) => i));
        const rayDirection = [0.8427009716, 0.3713906764, 0.3901721411];

        function boxDist2(p, node) {
            let distance = 0;
            for (let k = 0; k < 3; k++) {
                const d = p[k] < node.min[k] ? node.min[k] - p[k]
                    : p[k] > node.max[k] ? p[k] - node.max[k] : 0;
                distance += d * d;
            }
            return distance;
        }

        function triDist2(p, q) {
            const ia = id[q * 3] * 3, ib = id[q * 3 + 1] * 3, ic = id[q * 3 + 2] * 3;
            const ax = v[ia], ay = v[ia + 1], az = v[ia + 2];
            const bx = v[ib], by = v[ib + 1], bz = v[ib + 2];
            const cx = v[ic], cy = v[ic + 1], cz = v[ic + 2];
            const abx = bx - ax, aby = by - ay, abz = bz - az;
            const acx = cx - ax, acy = cy - ay, acz = cz - az;
            const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az;
            const d1 = abx * apx + aby * apy + abz * apz;
            const d2 = acx * apx + acy * apy + acz * apz;
            if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
            const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz;
            const d3 = abx * bpx + aby * bpy + abz * bpz;
            const d4 = acx * bpx + acy * bpy + acz * bpz;
            if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
            const vc = d1 * d4 - d3 * d2;
            if (vc <= 0 && d1 >= 0 && d3 <= 0) {
                const f = d1 / (d1 - d3), x = apx - f * abx, y = apy - f * aby, z = apz - f * abz;
                return x * x + y * y + z * z;
            }
            const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz;
            const d5 = abx * cpx + aby * cpy + abz * cpz;
            const d6 = acx * cpx + acy * cpy + acz * cpz;
            if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
            const vb = d5 * d2 - d1 * d6;
            if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                const f = d2 / (d2 - d6), x = apx - f * acx, y = apy - f * acy, z = apz - f * acz;
                return x * x + y * y + z * z;
            }
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
                const f = (d4 - d3) / (d4 - d3 + d5 - d6);
                const x = bpx + f * (cx - bx), y = bpy + f * (cy - by), z = bpz + f * (cz - bz);
                return x * x + y * y + z * z;
            }
            const denom = 1 / (va + vb + vc), f = vb * denom, g = vc * denom;
            const x = apx - abx * f - acx * g;
            const y = apy - aby * f - acy * g;
            const z = apz - abz * f - acz * g;
            return x * x + y * y + z * z;
        }

        function nearest(p) {
            let best = Infinity;
            const stack = [root];
            while (stack.length) {
                const node = stack.pop();
                if (boxDist2(p, node) >= best) continue;
                if (node.list) {
                    for (const q of node.list) best = Math.min(best, triDist2(p, q));
                } else {
                    stack.push(node.left, node.right);
                }
            }
            return Math.sqrt(best);
        }

        function rayBox(p, node) {
            let near = 0, far = Infinity;
            for (let k = 0; k < 3; k++) {
                let a = (node.min[k] - p[k]) / rayDirection[k];
                let b = (node.max[k] - p[k]) / rayDirection[k];
                if (a > b) { const swap = a; a = b; b = swap; }
                near = Math.max(near, a); far = Math.min(far, b);
                if (far < near) return false;
            }
            return far > 1e-8;
        }

        function rayTri(p, q) {
            const ia = id[q * 3] * 3, ib = id[q * 3 + 1] * 3, ic = id[q * 3 + 2] * 3;
            const e1x = v[ib] - v[ia], e1y = v[ib + 1] - v[ia + 1], e1z = v[ib + 2] - v[ia + 2];
            const e2x = v[ic] - v[ia], e2y = v[ic + 1] - v[ia + 1], e2z = v[ic + 2] - v[ia + 2];
            const hx = rayDirection[1] * e2z - rayDirection[2] * e2y;
            const hy = rayDirection[2] * e2x - rayDirection[0] * e2z;
            const hz = rayDirection[0] * e2y - rayDirection[1] * e2x;
            const determinant = e1x * hx + e1y * hy + e1z * hz;
            if (Math.abs(determinant) < 1e-12) return false;
            const inverse = 1 / determinant;
            const sx = p[0] - v[ia], sy = p[1] - v[ia + 1], sz = p[2] - v[ia + 2];
            const u = inverse * (sx * hx + sy * hy + sz * hz);
            if (u < -1e-10 || u > 1 + 1e-10) return false;
            const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
            const w = inverse * (rayDirection[0] * qx + rayDirection[1] * qy + rayDirection[2] * qz);
            return w >= -1e-10 && u + w <= 1 + 1e-10
                && inverse * (e2x * qx + e2y * qy + e2z * qz) > 1e-8;
        }

        function query(p) {
            const distance = nearest(p);
            let hits = 0;
            const stack = [root];
            while (stack.length) {
                const node = stack.pop();
                if (!rayBox(p, node)) continue;
                if (node.list) {
                    for (const q of node.list) if (rayTri(p, q)) hits++;
                } else {
                    stack.push(node.left, node.right);
                }
            }
            return (hits & 1) ? distance : -distance;
        }
        return { nearest, query };
    }

    function projectOffset(source, moved, bvh, wall, control) {
        const v = source.vertProperties, out = moved.vertProperties, nv = v.length / 3;
        const bad = [];
        for (let q = 0; q < nv; q++) {
            if ((q & 2047) === 0) control.check();
            const i = q * 3;
            const dx = out[i] - v[i], dy = out[i + 1] - v[i + 1], dz = out[i + 2] - v[i + 2];
            let scale = 1, bestScale = 1, bestError = Infinity;
            for (let iteration = 0; iteration < 3; iteration++) {
                const p = [v[i] + dx * scale, v[i + 1] + dy * scale, v[i + 2] + dz * scale];
                const distance = bvh.nearest(p), error = Math.abs(distance - wall);
                if (error < bestError) { bestError = error; bestScale = scale; }
                if (error <= Math.max(0.01, wall * 1e-3) || distance < 1e-9) break;
                scale = Math.max(0.05, Math.min(8, scale * wall / distance));
            }
            if (bestError > 0.15) bad.push({ q, dx, dy, dz, bestError });
            out[i] = v[i] + dx * bestScale;
            out[i + 1] = v[i + 1] + dy * bestScale;
            out[i + 2] = v[i + 2] + dz * bestScale;
        }
        if (!bad.length || nv > 10000) return;

        const normal = normalOffset(source, wall), centroid = [0, 0, 0];
        for (let i = 0; i < v.length; i += 3) {
            centroid[0] += v[i]; centroid[1] += v[i + 1]; centroid[2] += v[i + 2];
        }
        centroid[0] /= nv; centroid[1] /= nv; centroid[2] /= nv;
        const distances = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8]
            .map((factor) => factor * wall);
        for (const item of bad) {
            control.check();
            const i = item.q * 3;
            const directions = [
                [item.dx, item.dy, item.dz],
                [normal[i] - v[i], normal[i + 1] - v[i + 1], normal[i + 2] - v[i + 2]],
                [centroid[0] - v[i], centroid[1] - v[i + 1], centroid[2] - v[i + 2]],
            ];
            let bestError = item.bestError, best = [out[i], out[i + 1], out[i + 2]];
            for (const direction of directions) {
                const length = Math.hypot(direction[0], direction[1], direction[2]);
                if (length < 1e-9) continue;
                for (const distance of distances) {
                    const p = [v[i] + direction[0] * distance / length,
                        v[i + 1] + direction[1] * distance / length,
                        v[i + 2] + direction[2] * distance / length];
                    const signed = bvh.query(p), error = Math.abs(signed - wall);
                    if (signed > 0 && error < bestError) { bestError = error; best = p; }
                }
            }
            if (bestError < item.bestError) {
                out[i] = best[0]; out[i + 1] = best[1]; out[i + 2] = best[2];
            }
        }

        const remaining = new Set();
        for (const item of bad) {
            const i = item.q * 3;
            if (Math.abs(bvh.nearest([out[i], out[i + 1], out[i + 2]]) - wall) > 0.15) {
                remaining.add(item.q);
            }
        }
        if (!remaining.size) return;
        const adjacency = new Map();
        for (const q of remaining) adjacency.set(q, new Set());
        const tri = source.triVerts;
        for (let i = 0; i < tri.length; i += 3) {
            const a = tri[i], b = tri[i + 1], c = tri[i + 2];
            if (remaining.has(a)) { adjacency.get(a).add(b); adjacency.get(a).add(c); }
            if (remaining.has(b)) { adjacency.get(b).add(a); adjacency.get(b).add(c); }
            if (remaining.has(c)) { adjacency.get(c).add(a); adjacency.get(c).add(b); }
        }
        for (const q of remaining) {
            const i = q * 3;
            let bestError = Math.abs(bvh.nearest([out[i], out[i + 1], out[i + 2]]) - wall), best = null;
            for (const neighbor of adjacency.get(q)) {
                const j = neighbor * 3, p = [out[j], out[j + 1], out[j + 2]];
                const signed = bvh.query(p), error = Math.abs(signed - wall);
                if (signed > 0 && error < bestError) { bestError = error; best = p; }
            }
            if (best) { out[i] = best[0]; out[i + 1] = best[1]; out[i + 2] = best[2]; }
        }
    }

    function sampleWallStats(innerArrays, bvh, wall) {
        const v = innerArrays.vertProperties, n = v.length / 3;
        const count = Math.min(n, MAX_WALL_SAMPLES);
        if (!count) return { samples: 0, minMm: 0, p05Mm: 0, medianMm: 0, rmsErrorMm: wall };
        const values = new Array(count);
        let sum2 = 0;
        for (let s = 0; s < count; s++) {
            const q = count === n ? s : Math.floor(s * n / count), i = q * 3;
            const distance = bvh.nearest([v[i], v[i + 1], v[i + 2]]);
            values[s] = distance;
            sum2 += (distance - wall) * (distance - wall);
        }
        values.sort((a, b) => a - b);
        const pick = (fraction) => values[Math.min(count - 1, Math.floor(fraction * (count - 1)))];
        return {
            samples: count,
            minMm: values[0],
            p05Mm: pick(0.05),
            medianMm: pick(0.5),
            rmsErrorMm: Math.sqrt(sum2 / count),
        };
    }

    function shellCount(manifold) {
        let parts = [];
        try {
            parts = manifold.decompose();
            return parts.length;
        } finally {
            for (const part of parts) dispose(part);
        }
    }

    function wallWarnings(wallStats, wallMm) {
        const warnings = [];
        if (wallStats.minMm < wallMm * 0.9) {
            warnings.push({ code: "thin-wall", detail: `sampled minimum ${wallStats.minMm.toFixed(3)} mm is below 90% of ${wallMm} mm` });
        }
        if (wallStats.minMm < 1.6) {
            warnings.push({ code: "thin-wall-hard", detail: `sampled minimum ${wallStats.minMm.toFixed(3)} mm is below 1.6 mm` });
        }
        return warnings;
    }

    function pointTriDist2XYZ(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
        const abx = bx - ax, aby = by - ay, abz = bz - az;
        const acx = cx - ax, acy = cy - ay, acz = cz - az;
        const apx = px - ax, apy = py - ay, apz = pz - az;
        const d1 = abx * apx + aby * apy + abz * apz;
        const d2 = acx * apx + acy * apy + acz * apz;
        if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
        const bpx = px - bx, bpy = py - by, bpz = pz - bz;
        const d3 = abx * bpx + aby * bpy + abz * bpz;
        const d4 = acx * bpx + acy * bpy + acz * bpz;
        if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
        const vc = d1 * d4 - d3 * d2;
        if (vc <= 0 && d1 >= 0 && d3 <= 0) {
            const f = d1 / (d1 - d3), x = apx - f * abx, y = apy - f * aby, z = apz - f * abz;
            return x * x + y * y + z * z;
        }
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
        const vb = d5 * d2 - d1 * d6;
        if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const f = d2 / (d2 - d6), x = apx - f * acx, y = apy - f * acy, z = apz - f * acz;
            return x * x + y * y + z * z;
        }
        const va = d3 * d6 - d5 * d4;
        if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
            const f = (d4 - d3) / (d4 - d3 + d5 - d6);
            const x = bpx + f * (cx - bx), y = bpy + f * (cy - by), z = bpz + f * (cz - bz);
            return x * x + y * y + z * z;
        }
        const denom = 1 / (va + vb + vc), f = vb * denom, g = vc * denom;
        const x = apx - abx * f - acx * g;
        const y = apy - aby * f - acy * g;
        const z = apz - abz * f - acz * g;
        return x * x + y * y + z * z;
    }

    function gridSpec(arrays, wall) {
        const bounds = boundsOf(arrays);
        function measure(h) {
            const dims = bounds.size.map((size) => Math.ceil(size / h) + 5);
            return { h, dims, voxels: dims[0] * dims[1] * dims[2] };
        }
        const requestedH = wall / 2;
        const wallSized = measure(wall);
        if (wallSized.voxels > MAX_GRID_VOXELS) throw new HollowGridTooLarge(wallSized.voxels);
        let measured = measure(requestedH);
        if (measured.voxels > MAX_GRID_VOXELS) {
            let h = requestedH * Math.cbrt(measured.voxels / (MAX_GRID_VOXELS * 0.97));
            h = Math.min(wall, h);
            measured = measure(h);
            while (measured.voxels > MAX_GRID_VOXELS && h < wall) {
                h = Math.min(wall, h * 1.005);
                measured = measure(h);
            }
        }
        const min = bounds.min.map((value) => value - 2 * measured.h);
        return {
            requestedH,
            h: measured.h,
            dims: measured.dims,
            voxels: measured.voxels,
            min,
            coarsened: measured.h > requestedH * 1.000001,
        };
    }

    function columnSignPass(arrays, spec, grid, control) {
        const v = arrays.vertProperties, t = arrays.triVerts;
        const [nx, ny, nz] = spec.dims, [ox, oy, oz] = spec.min, h = spec.h;
        const columns = new Array(nx * ny), epsArea = h * h * 1e-10;
        for (let q = 0; q < t.length; q += 3) {
            if ((q & 1023) === 0) {
                control.check();
                control.progress("grid-sign", q / t.length);
            }
            const A = t[q] * 3, B = t[q + 1] * 3, C = t[q + 2] * 3;
            const ax = v[A], ay = v[A + 1], az = v[A + 2];
            const bx = v[B], by = v[B + 1], bz = v[B + 2];
            const cx = v[C], cy = v[C + 1], cz = v[C + 2];
            const denom = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
            if (Math.abs(denom) < epsArea) continue;
            const ix0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - ox) / h - 1e-9));
            const ix1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - ox) / h + 1e-9));
            const iy0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - oy) / h - 1e-9));
            const iy1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - oy) / h + 1e-9));
            const inverse = 1 / denom;
            for (let iy = iy0, y = oy + iy0 * h; iy <= iy1; iy++, y += h) {
                for (let ix = ix0, x = ox + ix0 * h; ix <= ix1; ix++, x += h) {
                    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) * inverse;
                    const w = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) * inverse;
                    const s = 1 - u - w;
                    if (u >= -1e-9 && w >= -1e-9 && s >= -1e-9) {
                        const column = ix + nx * iy;
                        (columns[column] || (columns[column] = [])).push(u * az + w * bz + s * cz);
                    }
                }
            }
        }
        const far = Math.max(spec.wall, 2 * h) + h;
        grid.fill(-far);
        const mergeEps = Math.max(1e-5, h * 1e-5), plane = nx * ny;
        for (let column = 0; column < columns.length; column++) {
            if ((column & 4095) === 0) control.check();
            const zs = columns[column];
            if (!zs || zs.length < 2) continue;
            zs.sort((a, b) => a - b);
            let write = 1;
            for (let j = 1; j < zs.length; j++) {
                if (Math.abs(zs[j] - zs[write - 1]) > mergeEps) zs[write++] = zs[j];
            }
            let crossing = 0, inside = false;
            for (let iz = 0, z = oz; iz < nz; iz++, z += h) {
                while (crossing < write && zs[crossing] < z - mergeEps) {
                    inside = !inside;
                    crossing++;
                }
                if (inside) grid[column + plane * iz] = far;
            }
        }
    }

    function exactBandPass(arrays, spec, grid, control) {
        const v = arrays.vertProperties, t = arrays.triVerts;
        const [nx, ny, nz] = spec.dims, [ox, oy, oz] = spec.min, h = spec.h;
        const plane = nx * ny, radius = Math.max(spec.wall, 2 * h), radius2 = radius * radius;
        for (let q = 0; q < t.length; q += 3) {
            if ((q & 255) === 0) {
                control.check();
                control.progress("grid-band", q / t.length);
            }
            const A = t[q] * 3, B = t[q + 1] * 3, C = t[q + 2] * 3;
            const ax = v[A], ay = v[A + 1], az = v[A + 2];
            const bx = v[B], by = v[B + 1], bz = v[B + 2];
            const cx = v[C], cy = v[C + 1], cz = v[C + 2];
            const tx0 = Math.min(ax, bx, cx), tx1 = Math.max(ax, bx, cx);
            const ty0 = Math.min(ay, by, cy), ty1 = Math.max(ay, by, cy);
            const tz0 = Math.min(az, bz, cz), tz1 = Math.max(az, bz, cz);
            const ix0 = Math.max(0, Math.ceil((tx0 - radius - ox) / h));
            const ix1 = Math.min(nx - 1, Math.floor((tx1 + radius - ox) / h));
            const iy0 = Math.max(0, Math.ceil((ty0 - radius - oy) / h));
            const iy1 = Math.min(ny - 1, Math.floor((ty1 + radius - oy) / h));
            const iz0 = Math.max(0, Math.ceil((tz0 - radius - oz) / h));
            const iz1 = Math.min(nz - 1, Math.floor((tz1 + radius - oz) / h));
            for (let iz = iz0, z = oz + iz0 * h; iz <= iz1; iz++, z += h) {
                const dz = z < tz0 ? tz0 - z : z > tz1 ? z - tz1 : 0, dz2 = dz * dz;
                for (let iy = iy0, y = oy + iy0 * h; iy <= iy1; iy++, y += h) {
                    const dy = y < ty0 ? ty0 - y : y > ty1 ? y - ty1 : 0;
                    const yz2 = dz2 + dy * dy;
                    if (yz2 > radius2) continue;
                    let index = ix0 + nx * iy + plane * iz;
                    for (let ix = ix0, x = ox + ix0 * h; ix <= ix1; ix++, x += h, index++) {
                        if (grid[index] < 0) continue;
                        const dx = x < tx0 ? tx0 - x : x > tx1 ? x - tx1 : 0;
                        if (yz2 + dx * dx > radius2) continue;
                        const distance2 = pointTriDist2XYZ(x, y, z,
                            ax, ay, az, bx, by, bz, cx, cy, cz);
                        if (distance2 <= radius2) {
                            const distance = Math.sqrt(distance2);
                            if (distance < Math.abs(grid[index])) grid[index] = distance;
                        }
                    }
                }
            }
        }
    }

    function growF32(array, need) {
        if (need <= array.length) return array;
        const grown = new Float32Array(Math.max(need, array.length * 2));
        grown.set(array);
        return grown;
    }

    function growU32(array, need) {
        if (need <= array.length) return array;
        const grown = new Uint32Array(Math.max(need, array.length * 2));
        grown.set(array);
        return grown;
    }

    function marchGrid(grid, spec, control) {
        const [nx, ny, nz] = spec.dims, [ox, oy, oz] = spec.min, h = spec.h;
        const plane = nx * ny, total = grid.length;
        let vp = new Float32Array(1 << 20), tv = new Uint32Array(1 << 20), nv = 0, nt = 0;
        let xBottom = new Int32Array(plane), xTop = new Int32Array(plane);
        let yBottom = new Int32Array(plane), yTop = new Int32Array(plane);
        const zEdges = new Int32Array(plane);
        xBottom.fill(-1); xTop.fill(-1); yBottom.fill(-1); yTop.fill(-1); zEdges.fill(-1);
        const openEdges = new Map();
        let misorientedEdges = 0;
        const trackEdge = (a, b) => {
            const lo = Math.min(a, b), hi = Math.max(a, b), key = lo * total + hi;
            const direction = a < b ? 0 : 1, previous = openEdges.get(key);
            if (previous === undefined) openEdges.set(key, direction);
            else { if (previous === direction) misorientedEdges++; openEdges.delete(key); }
        };
        const cx = [0, 1, 1, 0, 0, 1, 1, 0], cy = [0, 0, 1, 1, 0, 0, 1, 1];
        const cz = [0, 0, 0, 0, 1, 1, 1, 1];
        const edgeCorners = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6],
            [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
        const faces = [
            [[0, 1, 2, 3], [0, 1, 2, 3]], [[4, 5, 6, 7], [4, 5, 6, 7]],
            [[0, 1, 5, 4], [0, 9, 4, 8]], [[1, 2, 6, 5], [1, 10, 5, 9]],
            [[3, 2, 6, 7], [2, 10, 6, 11]], [[0, 3, 7, 4], [3, 11, 7, 8]],
        ];
        const adjA = new Int8Array(12), adjB = new Int8Array(12), edgeVert = new Int32Array(12);
        const loop = new Int8Array(12), gi = new Int32Array(8), gv = new Float32Array(8);
        const connect = (a, b) => {
            if (adjA[a] < 0) adjA[a] = b; else adjB[a] = b;
            if (adjA[b] < 0) adjA[b] = a; else adjB[b] = a;
        };
        const iso = spec.wall - h * 1e-3;
        for (let iz = 0; iz < nz - 1; iz++) {
            if ((iz & 7) === 0) {
                control.check();
                control.progress("grid-march", iz / (nz - 1));
            }
            const z = oz + iz * h;
            for (let iy = 0; iy < ny - 1; iy++) {
                const y = oy + iy * h;
                let base = iy * nx + iz * plane;
                for (let ix = 0; ix < nx - 1; ix++, base++) {
                    const indices = [base, base + 1, base + 1 + nx, base + nx,
                        base + plane, base + plane + 1, base + plane + 1 + nx, base + plane + nx];
                    let cubeMask = 0;
                    for (let q = 0; q < 8; q++) {
                        gi[q] = indices[q]; gv[q] = grid[indices[q]];
                        if (gv[q] >= iso) cubeMask |= 1 << q;
                    }
                    if (cubeMask === 0 || cubeMask === 255) continue;
                    const x = ox + ix * h;
                    adjA.fill(-1); adjB.fill(-1); edgeVert.fill(-1);
                    let crossingMask = 0;
                    for (let edge = 0; edge < 12; edge++) {
                        const pair = edgeCorners[edge];
                        if (((cubeMask >> pair[0]) & 1) !== ((cubeMask >> pair[1]) & 1)) {
                            crossingMask |= 1 << edge;
                        }
                    }
                    for (let f = 0; f < 6; f++) {
                        const fc = faces[f][0], fe = faces[f][1], hits = [];
                        for (let q = 0; q < 4; q++) if (crossingMask & (1 << fe[q])) hits.push(fe[q]);
                        if (hits.length === 2) connect(hits[0], hits[1]);
                        else if (hits.length === 4) {
                            const centerInside = (gv[fc[0]] + gv[fc[1]] + gv[fc[2]] + gv[fc[3]]) * 0.25 > iso;
                            const cornerInside = (cubeMask & (1 << fc[0])) !== 0;
                            if (centerInside === cornerInside) {
                                connect(fe[0], fe[1]); connect(fe[2], fe[3]);
                            } else {
                                connect(fe[3], fe[0]); connect(fe[1], fe[2]);
                            }
                        }
                    }
                    for (let edge = 0; edge < 12; edge++) if (crossingMask & (1 << edge)) {
                        const pair = edgeCorners[edge], ca = pair[0], cb = pair[1];
                        let cache, cacheIndex;
                        if (edge === 0) { cache = xBottom; cacheIndex = ix + nx * iy; }
                        else if (edge === 1) { cache = yBottom; cacheIndex = ix + 1 + nx * iy; }
                        else if (edge === 2) { cache = xBottom; cacheIndex = ix + nx * (iy + 1); }
                        else if (edge === 3) { cache = yBottom; cacheIndex = ix + nx * iy; }
                        else if (edge === 4) { cache = xTop; cacheIndex = ix + nx * iy; }
                        else if (edge === 5) { cache = yTop; cacheIndex = ix + 1 + nx * iy; }
                        else if (edge === 6) { cache = xTop; cacheIndex = ix + nx * (iy + 1); }
                        else if (edge === 7) { cache = yTop; cacheIndex = ix + nx * iy; }
                        else if (edge === 8) { cache = zEdges; cacheIndex = ix + nx * iy; }
                        else if (edge === 9) { cache = zEdges; cacheIndex = ix + 1 + nx * iy; }
                        else if (edge === 10) { cache = zEdges; cacheIndex = ix + 1 + nx * (iy + 1); }
                        else { cache = zEdges; cacheIndex = ix + nx * (iy + 1); }
                        const va = gv[ca], vb = gv[cb];
                        const fraction = Math.max(0, Math.min(1, (iso - va) / (vb - va)));
                        let vertex = cache[cacheIndex];
                        if (vertex < 0) {
                            vp = growF32(vp, nv * 3 + 3);
                            vp[nv * 3] = x + h * (cx[ca] + fraction * (cx[cb] - cx[ca]));
                            vp[nv * 3 + 1] = y + h * (cy[ca] + fraction * (cy[cb] - cy[ca]));
                            vp[nv * 3 + 2] = z + h * (cz[ca] + fraction * (cz[cb] - cz[ca]));
                            vertex = nv++;
                            cache[cacheIndex] = vertex;
                        }
                        edgeVert[edge] = vertex;
                    }
                    let visited = 0;
                    for (let start = 0; start < 12; start++) {
                        if (!(crossingMask & (1 << start)) || (visited & (1 << start))) continue;
                        let count = 0, previous = -1, edge = start;
                        while (count < 12 && edge >= 0 && !(visited & (1 << edge))) {
                            loop[count++] = edge;
                            visited |= 1 << edge;
                            const next = adjA[edge] !== previous ? adjA[edge] : adjB[edge];
                            previous = edge; edge = next;
                        }
                        if (count < 3) continue;
                        for (let q = 1; q < count - 1; q++) {
                            let a = edgeVert[loop[0]], b = edgeVert[loop[q]], c = edgeVert[loop[q + 1]];
                            if (a === b || b === c || c === a) continue;
                            const A = a * 3, B = b * 3, C = c * 3;
                            const ux = vp[B] - vp[A], uy = vp[B + 1] - vp[A + 1], uz = vp[B + 2] - vp[A + 2];
                            const vx = vp[C] - vp[A], vy = vp[C + 1] - vp[A + 1], vz = vp[C + 2] - vp[A + 2];
                            const nnx = uy * vz - uz * vy, nny = uz * vx - ux * vz, nnz = ux * vy - uy * vx;
                            const px = Math.max(0, Math.min(1, ((vp[A] + vp[B] + vp[C]) / 3 - x) / h));
                            const py = Math.max(0, Math.min(1, ((vp[A + 1] + vp[B + 1] + vp[C + 1]) / 3 - y) / h));
                            const pz = Math.max(0, Math.min(1, ((vp[A + 2] + vp[B + 2] + vp[C + 2]) / 3 - z) / h));
                            const gx = (1 - py) * (1 - pz) * (gv[1] - gv[0]) + py * (1 - pz) * (gv[2] - gv[3])
                                + (1 - py) * pz * (gv[5] - gv[4]) + py * pz * (gv[6] - gv[7]);
                            const gy = (1 - px) * (1 - pz) * (gv[3] - gv[0]) + px * (1 - pz) * (gv[2] - gv[1])
                                + (1 - px) * pz * (gv[7] - gv[4]) + px * pz * (gv[6] - gv[5]);
                            const gz = (1 - px) * (1 - py) * (gv[4] - gv[0]) + px * (1 - py) * (gv[5] - gv[1])
                                + px * py * (gv[6] - gv[2]) + (1 - px) * py * (gv[7] - gv[3]);
                            let direction = -(nnx * gx + nny * gy + nnz * gz);
                            if (Math.abs(direction) < 1e-12) {
                                for (const loopEdge of [loop[0], loop[q], loop[q + 1]]) {
                                    const pair = edgeCorners[loopEdge];
                                    const inside = (cubeMask & (1 << pair[0])) ? pair[0] : pair[1];
                                    const outside = inside === pair[0] ? pair[1] : pair[0];
                                    const dot = nnx * (cx[outside] - cx[inside])
                                        + nny * (cy[outside] - cy[inside]) + nnz * (cz[outside] - cz[inside]);
                                    if (Math.abs(dot) > Math.abs(direction)) direction = dot;
                                }
                            }
                            if (direction < 0) { const swap = b; b = c; c = swap; }
                            tv = growU32(tv, nt * 3 + 3);
                            tv[nt * 3] = a; tv[nt * 3 + 1] = b; tv[nt * 3 + 2] = c;
                            trackEdge(a, b); trackEdge(b, c); trackEdge(c, a);
                            nt++;
                        }
                    }
                }
            }
            let swap = xBottom; xBottom = xTop; xTop = swap; xTop.fill(-1);
            swap = yBottom; yBottom = yTop; yTop = swap; yTop.fill(-1);
            zEdges.fill(-1);
        }
        const boundaryPairs = [];
        for (const [key, direction] of openEdges) {
            const lo = Math.floor(key / total), hi = key - lo * total;
            boundaryPairs.push(direction === 0 ? lo : hi, direction === 0 ? hi : lo);
        }
        return {
            vertProperties: vp.slice(0, nv * 3),
            triVerts: tv.slice(0, nt * 3),
            vertices: nv,
            misorientedEdges,
            boundaryPairs,
        };
    }

    function orientMesh(arrays, control) {
        const t = arrays.triVerts, nt = t.length / 3, nv = arrays.vertices;
        if (nv > 2097151 || nt > 2097151) throw new Error("orientation pack limit exceeded");
        const records = new BigUint64Array(t.length), vertexMask = (1n << 21n) - 1n;
        let write = 0;
        for (let q = 0; q < t.length; q += 3) {
            if ((q & 16383) === 0) control.check();
            for (const pair of [[t[q], t[q + 1]], [t[q + 1], t[q + 2]], [t[q + 2], t[q]]]) {
                const lo = Math.min(pair[0], pair[1]), hi = Math.max(pair[0], pair[1]);
                const direction = pair[0] < pair[1] ? 0n : 1n;
                records[write++] = (BigInt(lo) << 43n) | (BigInt(hi) << 22n)
                    | (BigInt(q / 3) << 1n) | direction;
            }
        }
        records.sort();
        const parent = new Int32Array(nt), rank = new Uint8Array(nt), parity = new Uint8Array(nt);
        for (let i = 0; i < nt; i++) parent[i] = i;
        const find = (value) => {
            if (parent[value] === value) return value;
            const old = parent[value], rootValue = find(old);
            parity[value] ^= parity[old];
            parent[value] = rootValue;
            return rootValue;
        };
        let conflicts = 0, overused = 0;
        const boundaryRecords = [];
        for (let i = 0; i < records.length;) {
            if ((i & 16383) === 0) control.check();
            const key = records[i] >> 22n, start = i;
            while (i < records.length && (records[i] >> 22n) === key) i++;
            const count = i - start;
            if (count === 1) {
                const record = records[start];
                boundaryRecords.push(Number(key >> 21n), Number(key & vertexMask),
                    Number((record >> 1n) & 2097151n), Number(record & 1n));
                continue;
            }
            if (count !== 2) { overused++; continue; }
            const first = records[start], second = records[start + 1];
            const a = Number((first >> 1n) & 2097151n), b = Number((second >> 1n) & 2097151n);
            const relation = Number(first & 1n) ^ Number(second & 1n) ^ 1;
            const rootA = find(a), parityA = parity[a], rootB = find(b), parityB = parity[b];
            if (rootA === rootB) {
                if ((parityA ^ parityB) !== relation) conflicts++;
            } else if (rank[rootA] < rank[rootB]) {
                parent[rootA] = rootB;
                parity[rootA] = parityA ^ parityB ^ relation;
            } else {
                parent[rootB] = rootA;
                parity[rootB] = parityA ^ parityB ^ relation;
                if (rank[rootA] === rank[rootB]) rank[rootA]++;
            }
        }
        for (let triangle = 0; triangle < nt; triangle++) {
            if ((triangle & 16383) === 0) control.check();
            find(triangle);
            if (parity[triangle]) {
                const q = triangle * 3, swap = t[q + 1];
                t[q + 1] = t[q + 2]; t[q + 2] = swap;
            }
        }
        const boundaryPairs = [];
        for (let i = 0; i < boundaryRecords.length; i += 4) {
            const lo = boundaryRecords[i], hi = boundaryRecords[i + 1];
            const direction = boundaryRecords[i + 3] ^ parity[boundaryRecords[i + 2]];
            boundaryPairs.push(direction === 0 ? lo : hi, direction === 0 ? hi : lo);
        }
        return { boundaryPairs, overused, conflicts };
    }

    function capDirectedBoundaries(arrays, pairs, control) {
        if (!pairs.length) return;
        const next = new Map();
        for (let i = 0; i < pairs.length; i += 2) next.set(pairs[i], pairs[i + 1]);
        const seen = new Set(), extra = [];
        let checked = 0;
        for (const start of next.keys()) if (!seen.has(start)) {
            if ((checked++ & 4095) === 0) control.check();
            const loop = [];
            let current = start;
            while (!seen.has(current) && next.has(current)) {
                seen.add(current); loop.push(current); current = next.get(current);
            }
            if (current === start && loop.length >= 3) {
                for (let q = 1; q < loop.length - 1; q++) extra.push(loop[0], loop[q + 1], loop[q]);
            }
        }
        if (extra.length) {
            const grown = new Uint32Array(arrays.triVerts.length + extra.length);
            grown.set(arrays.triVerts); grown.set(extra, arrays.triVerts.length);
            arrays.triVerts = grown;
        }
    }

    function runMesh(source, arrays, wall, control, stageMs) {
        let inner = null, hollow = null;
        try {
            const moved = control.stage("mesh-qef", () => qefOffset(arrays, wall));
            const bvh = control.stage("mesh-bvh", () => makeBVH(arrays));
            control.stage("mesh-project", () => projectOffset(arrays, moved, bvh, wall, control));
            inner = control.stage("mesh-build", () => manifoldFromArrays(moved));
            hollow = control.stage("mesh-boolean", () => source.subtract(inner));
            const validation = control.stage("mesh-validate", () => ({
                wallStats: sampleWallStats(moved, bvh, wall),
                sourceShells: shellCount(source),
                innerShells: shellCount(inner),
            }));
            const shellLimit = Math.max(validation.sourceShells * TRIPWIRE_SHELL_FACTOR,
                validation.sourceShells + 2);
            const tripwireReasons = [];
            if (validation.wallStats.rmsErrorMm > TRIPWIRE_RMS_MM) tripwireReasons.push("rms");
            if (validation.innerShells > shellLimit) tripwireReasons.push("shells");
            if (validation.wallStats.minMm < wall * TRIPWIRE_MIN_FACTOR) tripwireReasons.push("minimum");
            return {
                hollow,
                wallStats: validation.wallStats,
                failed: tripwireReasons.length > 0,
                tripwireReasons,
            };
        } catch (error) {
            dispose(hollow);
            throw error;
        } finally {
            dispose(inner);
        }
    }

    function runGrid(source, arrays, wall, control, stageMs) {
        let grid = null, meshArrays = null, inner = null, hollow = null;
        const warnings = [];
        try {
            const spec = control.stage("grid-spec", () => gridSpec(arrays, wall));
            spec.wall = wall;
            if (spec.coarsened) {
                warnings.push({
                    code: "coarsened-grid",
                    detail: `grid spacing coarsened from ${spec.requestedH.toFixed(3)} mm to ${spec.h.toFixed(3)} mm (${spec.voxels} voxels)`,
                });
            }
            grid = control.stage("grid-allocate", () => new Float32Array(spec.voxels));
            control.stage("grid-sign", () => columnSignPass(arrays, spec, grid, control));
            control.stage("grid-band", () => exactBandPass(arrays, spec, grid, control));
            meshArrays = control.stage("grid-march", () => marchGrid(grid, spec, control));
            grid = null;
            control.stage("grid-audit", () => {
                let boundaryPairs = meshArrays.boundaryPairs;
                if (meshArrays.misorientedEdges) {
                    const oriented = orientMesh(meshArrays, control);
                    if (oriented.overused || oriented.conflicts) {
                        throw new Error(`grid mesh audit failed: overused=${oriented.overused}, conflicts=${oriented.conflicts}`);
                    }
                    boundaryPairs = oriented.boundaryPairs;
                }
                capDirectedBoundaries(meshArrays, boundaryPairs, control);
            });
            meshArrays.Mesh = arrays.Mesh;
            meshArrays.Manifold = arrays.Manifold;
            inner = control.stage("grid-build", () => manifoldFromArrays(meshArrays));
            inner = control.stage("grid-simplify", () => {
                const simplified = inner.simplify(0);
                dispose(inner);
                return simplified;
            });
            hollow = control.stage("grid-boolean", () => source.subtract(inner));
            const bvh = control.stage("grid-bvh", () => makeBVH(arrays));
            const innerArrays = arraysFromManifold(inner);
            const wallStats = control.stage("grid-validate", () => sampleWallStats(innerArrays, bvh, wall));
            return { hollow, wallStats, warnings };
        } catch (error) {
            dispose(hollow);
            throw error;
        } finally {
            dispose(inner);
            grid = null;
            meshArrays = null;
        }
    }

    function validateInputs(sourceManifold, wallMm, opts) {
        if (!sourceManifold || typeof sourceManifold.getMesh !== "function") {
            throw new TypeError("sourceManifold must be a Manifold");
        }
        if (!Number.isFinite(wallMm) || wallMm <= 0) throw new RangeError("wallMm must be positive");
        const engine = opts.engine === undefined ? "auto" : opts.engine;
        if (engine !== "auto" && engine !== "mesh" && engine !== "grid") {
            throw new RangeError("opts.engine must be auto, mesh, or grid");
        }
        return engine;
    }

    function hollow(sourceManifold, wallMm, opts = {}) {
        const requestedEngine = validateInputs(sourceManifold, wallMm, opts);
        const stageMs = {}, control = makeControl(opts, stageMs), started = now();
        const arrays = control.stage("prepare", () => arraysFromManifold(sourceManifold));
        const volumeBeforeMm3 = sourceManifold.volume();
        const selected = requestedEngine === "auto"
            ? (arrays.triVerts.length / 3 <= MESH_TRIANGLE_LIMIT ? "mesh" : "grid")
            : requestedEngine;
        let attempt = null, fellBack = false, tripwireReasons = [];
        if (selected === "mesh") {
            try {
                attempt = runMesh(sourceManifold, arrays, wallMm, control, stageMs);
            } catch (error) {
                if (error instanceof HollowCancelled) throw error;
                attempt = null;
                fellBack = true;
            }
            if (!attempt || attempt.failed) {
                if (attempt) tripwireReasons = attempt.tripwireReasons.slice();
                if (attempt) dispose(attempt.hollow);
                attempt = runGrid(sourceManifold, arrays, wallMm, control, stageMs);
                fellBack = true;
            }
        } else {
            attempt = runGrid(sourceManifold, arrays, wallMm, control, stageMs);
        }
        try {
            control.check();
            const volumeAfterMm3 = attempt.hollow.volume();
            const savedPct = 100 * (1 - volumeAfterMm3 / volumeBeforeMm3);
            const warnings = attempt.warnings ? attempt.warnings.slice() : [];
            warnings.push(...wallWarnings(attempt.wallStats, wallMm));
            stageMs.total = now() - started;
            return {
                hollow: attempt.hollow,
                stats: {
                    engineUsed: fellBack ? "grid" : selected,
                    fellBack,
                    tripwireReasons,
                    volumeBeforeMm3,
                    volumeAfterMm3,
                    savedPct,
                    wallStats: attempt.wallStats,
                    warnings,
                    stageMs,
                    triangles: attempt.hollow.numTri(),
                },
            };
        } catch (error) {
            dispose(attempt.hollow);
            throw error;
        }
    }

    function estimate(sourceManifold, wallMm) {
        validateInputs(sourceManifold, wallMm, {});
        const arrays = arraysFromManifold(sourceManifold), moved = qefOffset(arrays, wallMm);
        let inner = null;
        try {
            inner = manifoldFromArrays(moved);
            return 100 * inner.volume() / sourceManifold.volume();
        } finally {
            dispose(inner);
        }
    }

    function previewShell(sourceManifold, wallMm, opts = {}) {
        validateInputs(sourceManifold, wallMm, {});
        const arrays = arraysFromManifold(sourceManifold);
        const moved = qefOffset(arrays, wallMm);
        const bvh = makeBVH(arrays);
        const vertexCount = moved.vertProperties.length / 3;
        const requestedSamples = Number.isFinite(opts.maxSamples)
            ? Math.max(1, Math.floor(opts.maxSamples)) : vertexCount;
        const sampleCount = Math.min(vertexCount, requestedSamples);
        const displacementsMm = new Float32Array(sampleCount);
        for (let s = 0; s < sampleCount; s++) {
            const q = sampleCount === vertexCount
                ? s : Math.min(vertexCount - 1, Math.floor(s * vertexCount / sampleCount));
            const i = q * 3;
            displacementsMm[s] = bvh.nearest([
                moved.vertProperties[i], moved.vertProperties[i + 1], moved.vertProperties[i + 2],
            ]);
        }
        return {
            vertProperties: moved.vertProperties,
            triVerts: moved.triVerts,
            displacementsMm,
            sampleCount,
        };
    }

    CC.hollowCore = {
        hollow,
        estimate,
        previewShell,
        toArrays,
        wallWarnings,
        HollowCancelled,
        HollowGridTooLarge,
    };
})();
