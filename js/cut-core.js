/* Embedded into js/compute-worker-src.js — run `uv run --no-project python tools/embed_worker.py` after editing. */
/* Curve Cut — cut engine core (MVP step 3)
   Pure geometry: THREE <-> Manifold conversion, spline sampling, cutter
   solid construction, boolean split. No DOM, no UI — js/cut.js wires it up
   and tests/cut-test.html exercises it headlessly. */

(() => {
    "use strict";

    let wasm = null; // initialized Manifold module
    let initPromise = null;

    // ------------------------------------------------------------------ init

    function init() {
        if (initPromise) return initPromise;
        initPromise = initNow();
        return initPromise;
    }

    function initNow() {
        const b64 = window.MANIFOLD_WASM_B64;
        const raw = atob(b64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        window.MANIFOLD_WASM_B64 = null; // ~1.7 MB of string, never needed again
        return window.ManifoldModule({ wasmBinary: bytes }).then((m) => {
            m.setup();
            wasm = m;
            return wasm;
        });
    }

    // -------------------------------------------------- THREE -> Manifold

    /* Weld duplicate vertices (STLs are unindexed triangle soup) and drop
       degenerate triangles, producing the indexed arrays Manifold wants.
       tol (mm) is the merge distance — the 1e-4 default is "exact"; the
       repair ladder passes coarser values to close small seams. */
    function weldGeometry(geometry, tol = 1e-4) {
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const count = index ? index.count : pos.count;
        const getIdx = index ? (i) => index.getX(i) : (i) => i;

        // Same cells as the old `${round(x/tol)},…` string key: Map's SameValueZero
        // and the exact compare below both join -0 with 0 and NaN with NaN, as
        // String() did. The hash only picks a bucket.
        const heads = new Map();   // cell hash -> newest vertex in that bucket
        const next = [];           // vertex -> next vertex in the same bucket, -1 = end
        const cells = [];          // vertex -> its rounded x, y, z
        const seen = new Int32Array(pos.count).fill(-1); // source index -> welded vertex
        const verts = [];
        const tris = [];
        const same = (a, b) => a === b || (a !== a && b !== b);

        const lookup = (i) => {
            const known = seen[i];
            if (known >= 0) return known;
            const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
            const cx = Math.round(x / tol), cy = Math.round(y / tol), cz = Math.round(z / tol);
            const h = (Math.imul(cx | 0, 73856093) ^ Math.imul(cy | 0, 19349663)
                ^ Math.imul(cz | 0, 83492791)) & 0x3fffffff;
            const head = heads.get(h);
            let v = head === undefined ? -1 : head;
            while (v >= 0 && !(same(cells[v * 3], cx) && same(cells[v * 3 + 1], cy)
                && same(cells[v * 3 + 2], cz))) v = next[v];
            if (v < 0) {
                v = verts.length / 3;
                verts.push(x, y, z);
                cells.push(cx, cy, cz);
                next.push(head === undefined ? -1 : head);
                heads.set(h, v);
            }
            seen[i] = v;
            return v;
        };

        for (let i = 0; i < count; i += 3) {
            const a = lookup(getIdx(i)), b = lookup(getIdx(i + 1)), c = lookup(getIdx(i + 2));
            if (a !== b && b !== c && c !== a) tris.push(a, b, c);
        }
        return {
            vertProperties: new Float32Array(verts),
            triVerts: new Uint32Array(tris),
        };
    }

    function meshArrays(geometry) {
        if (geometry.vertProperties && geometry.triVerts) {
            return { vertProperties: geometry.vertProperties, triVerts: geometry.triVerts };
        }
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        if (!index) return weldGeometry(geometry);

        const vertProperties = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
            vertProperties[i * 3] = pos.getX(i);
            vertProperties[i * 3 + 1] = pos.getY(i);
            vertProperties[i * 3 + 2] = pos.getZ(i);
        }
        const triVerts = new Uint32Array(index.count);
        for (let i = 0; i < index.count; i++) triVerts[i] = index.getX(i);
        return { vertProperties, triVerts };
    }

    /* Edges used by exactly one triangle, in first-seen order. lo * K + hi is
       exact and one-to-one while K² < 2^53 (K <= 94906265); non-integer or
       negative indices, or a bigger K, fall back to the old string key. */
    function boundaryEdgesOf(triVerts) {
        let top = -1, packable = true;
        for (let i = 0; i < triVerts.length; i++) {
            const v = triVerts[i];
            if (!(Number.isInteger(v) && v >= 0)) { packable = false; break; }
            if (v > top) top = v;
        }
        const K = top + 1;
        const key = packable && K <= 94906265
            ? (lo, hi) => lo * K + hi : (lo, hi) => `${lo}_${hi}`;
        const edges = new Map();
        const addEdge = (a, b) => {
            const k = a < b ? key(a, b) : key(b, a);
            let edge = edges.get(k);
            if (!edge) {
                edge = { from: a, to: b, count: 0 };
                edges.set(k, edge);
            }
            edge.count++;
        };

        for (let i = 0; i + 2 < triVerts.length; i += 3) {
            const a = triVerts[i], b = triVerts[i + 1], c = triVerts[i + 2];
            addEdge(a, b); addEdge(b, c); addEdge(c, a);
        }

        const boundaryEdges = [];
        for (const edge of edges.values()) {
            if (edge.count === 1) boundaryEdges.push(edge);
        }
        return boundaryEdges;
    }

    function traceBoundaryLoops(boundaryEdges) {
        const outgoing = new Map();
        const ambiguous = new Set();
        for (const edge of boundaryEdges) {
            if (outgoing.has(edge.from)) {
                outgoing.delete(edge.from);
                ambiguous.add(edge.from);
            } else if (!ambiguous.has(edge.from)) {
                outgoing.set(edge.from, edge);
            }
        }

        const unused = new Set(boundaryEdges.map((edge, i) => {
            edge.index = i;
            return i;
        }));
        const loops = [];
        let openChains = 0;

        while (unused.size) {
            const seedIndex = unused.values().next().value;
            const seed = boundaryEdges[seedIndex];
            const start = seed.from;
            const path = [start];
            const visited = new Set([start]);
            let current = start;
            let first = true;
            let closed = false;

            while (true) {
                const edge = first ? seed : outgoing.get(current);
                first = false;
                if (!edge || !unused.has(edge.index)) break;
                unused.delete(edge.index);
                current = edge.to;
                if (current === start) {
                    closed = path.length >= 3;
                    break;
                }
                if (visited.has(current)) break;
                visited.add(current);
                path.push(current);
            }

            if (closed) loops.push(path);
            else openChains++;
        }

        return { loops, openChains, boundaryEdges: boundaryEdges.length };
    }

    function findBoundaryLoops(geometry) {
        return traceBoundaryLoops(boundaryEdgesOf(meshArrays(geometry).triVerts));
    }

    function loopProjection(loop, vertProperties) {
        const points = loop.map((index) => ({
            x: vertProperties[index * 3],
            y: vertProperties[index * 3 + 1],
            z: vertProperties[index * 3 + 2],
        }));
        const centroid = { x: 0, y: 0, z: 0 };
        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const point of points) {
            centroid.x += point.x; centroid.y += point.y; centroid.z += point.z;
            min.x = Math.min(min.x, point.x); min.y = Math.min(min.y, point.y); min.z = Math.min(min.z, point.z);
            max.x = Math.max(max.x, point.x); max.y = Math.max(max.y, point.y); max.z = Math.max(max.z, point.z);
        }
        centroid.x /= points.length; centroid.y /= points.length; centroid.z /= points.length;

        let nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            nx += (a.y - b.y) * (a.z + b.z);
            ny += (a.z - b.z) * (a.x + b.x);
            nz += (a.x - b.x) * (a.y + b.y);
        }
        const scale = Math.max(max.x - min.x, max.y - min.y, max.z - min.z);
        const areaEps = scale * scale * 1e-12;
        let normalLength = Math.hypot(nx, ny, nz);
        if (normalLength <= areaEps) {
            const dx = max.x - min.x, dy = max.y - min.y, dz = max.z - min.z;
            if (dy <= dx && dy <= dz) { nx = 0; ny = 1; nz = 0; }
            else if (dx <= dz) { nx = 1; ny = 0; nz = 0; }
            else { nx = 0; ny = 0; nz = 1; }
            normalLength = 1;
        }
        nx /= normalLength; ny /= normalLength; nz /= normalLength;

        const rx = Math.abs(nx) < 0.9 ? 1 : 0;
        const ry = Math.abs(ny) < 0.9 ? 1 : 0;
        const rz = Math.abs(nz) < 0.9 ? 0 : 1;
        let e1x = ry * nz - rz * ny;
        let e1y = rz * nx - rx * nz;
        let e1z = rx * ny - ry * nx;
        const e1Length = Math.hypot(e1x, e1y, e1z) || 1;
        e1x /= e1Length; e1y /= e1Length; e1z /= e1Length;
        const e2x = ny * e1z - nz * e1y;
        const e2y = nz * e1x - nx * e1z;
        const e2z = nx * e1y - ny * e1x;
        const projected = points.map((point, i) => {
            const dx = point.x - centroid.x, dy = point.y - centroid.y, dz = point.z - centroid.z;
            return { index: loop[i], x: dx * e1x + dy * e1y + dz * e1z,
                y: dx * e2x + dy * e2y + dz * e2z };
        });
        return { projected, centroid, scale, areaEps };
    }

    function projectedCross(a, b, c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }

    function cleanProjectedPolygon(points, areaEps, lengthEps) {
        const cleaned = [];
        const lengthEps2 = lengthEps * lengthEps;
        for (const point of points) {
            const previous = cleaned[cleaned.length - 1];
            if (!previous || (point.x - previous.x) ** 2 + (point.y - previous.y) ** 2 > lengthEps2) {
                cleaned.push(point);
            }
        }
        if (cleaned.length > 1) {
            const first = cleaned[0], last = cleaned[cleaned.length - 1];
            if ((first.x - last.x) ** 2 + (first.y - last.y) ** 2 <= lengthEps2) cleaned.pop();
        }
        let changed = true;
        while (changed && cleaned.length > 3) {
            changed = false;
            for (let i = 0; i < cleaned.length; i++) {
                const previous = cleaned[(i + cleaned.length - 1) % cleaned.length];
                const point = cleaned[i];
                const next = cleaned[(i + 1) % cleaned.length];
                if (Math.abs(projectedCross(previous, point, next)) > areaEps) continue;
                const dot = (point.x - previous.x) * (point.x - next.x)
                    + (point.y - previous.y) * (point.y - next.y);
                if (dot <= lengthEps2) {
                    cleaned.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
        return cleaned;
    }

    function pointInsideTriangle(point, a, b, c, orientation, areaEps) {
        return projectedCross(a, b, point) * orientation > areaEps
            && projectedCross(b, c, point) * orientation > areaEps
            && projectedCross(c, a, point) * orientation > areaEps;
    }

    function earClip(points, areaEps) {
        if (points.length < 3) return null;
        let area = 0;
        for (let i = 0; i < points.length; i++) {
            const a = points[i], b = points[(i + 1) % points.length];
            area += a.x * b.y - b.x * a.y;
        }
        if (Math.abs(area) <= areaEps) return null;
        const orientation = area > 0 ? 1 : -1;
        const work = points.slice();
        const triangles = [];
        let guard = work.length * work.length;
        while (work.length > 3 && guard-- > 0) {
            let ear = -1;
            for (let i = 0; i < work.length; i++) {
                const previous = work[(i + work.length - 1) % work.length];
                const point = work[i];
                const next = work[(i + 1) % work.length];
                if (projectedCross(previous, point, next) * orientation <= areaEps) continue;
                let contains = false;
                for (let j = 0; j < work.length; j++) {
                    if (j === i || j === (i + work.length - 1) % work.length
                        || j === (i + 1) % work.length) continue;
                    if (pointInsideTriangle(work[j], previous, point, next, orientation, areaEps)) {
                        contains = true;
                        break;
                    }
                }
                if (!contains) { ear = i; break; }
            }
            if (ear < 0) return null;
            const previous = work[(ear + work.length - 1) % work.length];
            const point = work[ear];
            const next = work[(ear + 1) % work.length];
            triangles.push([previous.index, point.index, next.index]);
            work.splice(ear, 1);
        }
        if (work.length !== 3 || Math.abs(projectedCross(work[0], work[1], work[2])) <= areaEps) return null;
        triangles.push([work[0].index, work[1].index, work[2].index]);
        return triangles;
    }

    function capBoundaryLoops(geometry, precomputed) {
        const data = meshArrays(geometry);
        const found = precomputed && !Array.isArray(precomputed) ? precomputed : null;
        const loops = Array.isArray(precomputed) ? precomputed : (found ? found.loops : findBoundaryLoops(data).loops);
        if (!loops || !loops.length) return null;

        const vertices = Array.from(data.vertProperties);
        const triangles = Array.from(data.triVerts);
        const originalTriCount = triangles.length;
        for (const loop of loops) {
            if (loop.length < 3) continue;
            const projected = loopProjection(loop, data.vertProperties);
            const cleaned = cleanProjectedPolygon(projected.projected, projected.areaEps,
                projected.scale * 1e-10);
            const clipped = cleaned.length === projected.projected.length
                ? earClip(cleaned, projected.areaEps) : null;
            if (clipped) {
                for (const tri of clipped) triangles.push(tri[0], tri[2], tri[1]);
                continue;
            }

            const centerIndex = vertices.length / 3;
            vertices.push(projected.centroid.x, projected.centroid.y, projected.centroid.z);
            for (let i = 0; i < loop.length; i++) {
                const a = loop[i], b = loop[(i + 1) % loop.length];
                triangles.push(b, a, centerIndex);
            }
        }

        return {
            vertProperties: new Float32Array(vertices),
            triVerts: new Uint32Array(triangles),
            capTris: (triangles.length - originalTriCount) / 3,
            loops,
        };
    }

    /* Byte-identical meshes get the same Manifold verdict. */
    function sameMesh(a, b) {
        const av = new Uint32Array(a.vertProperties.buffer, a.vertProperties.byteOffset, a.vertProperties.length);
        const bv = new Uint32Array(b.vertProperties.buffer, b.vertProperties.byteOffset, b.vertProperties.length);
        if (av.length !== bv.length || a.triVerts.length !== b.triVerts.length) return false;
        for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
        for (let i = 0; i < a.triVerts.length; i++) if (a.triVerts[i] !== b.triVerts[i]) return false;
        return true;
    }

    /* manifoldAccepts runs mesh.merge(), which joins open-edge vertices within
       FLT_EPSILON x the largest |coordinate| per axis (manifold-3d 3.5.1). If
       no vertex sits within 1e-5 x that of a boundary vertex, the open edges
       survive merge and Manifold must reject the mesh. True = can't rule it out. */
    function openEdgesMayMerge(boundaryEdges, vertProperties) {
        let scale = 0;
        for (let i = 0; i < vertProperties.length; i++) scale = Math.max(scale, Math.abs(vertProperties[i]));
        if (!Number.isFinite(scale)) return true;
        const reach = scale * 1e-5;
        const ends = [...new Set(boundaryEdges.flatMap((edge) => [edge.from, edge.to]))]
            .sort((a, b) => vertProperties[a * 3] - vertProperties[b * 3]);
        const xs = ends.map((v) => vertProperties[v * 3]);
        const n = vertProperties.length / 3;
        let budget = 8 * n + ends.length; // pathological slabs: give up, let Manifold decide
        for (let v = 0; v < n; v++) {
            const x = vertProperties[v * 3], y = vertProperties[v * 3 + 1], z = vertProperties[v * 3 + 2];
            let lo = 0, hi = xs.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (xs[mid] < x - reach) lo = mid + 1; else hi = mid;
            }
            for (let j = lo; j < xs.length && xs[j] <= x + reach; j++) {
                if (--budget < 0) return true;
                const b = ends[j];
                if (b !== v && Math.abs(vertProperties[b * 3 + 1] - y) <= reach
                    && Math.abs(vertProperties[b * 3 + 2] - z) <= reach) return true;
            }
        }
        return false;
    }

    function manifoldAccepts(vertProperties, triVerts) {
        try {
            const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
            mesh.merge();
            const solid = new wasm.Manifold(mesh);
            solid.delete();
            return true;
        } catch (err) {
            return false;
        }
    }

    /* THREE.BufferGeometry -> Manifold. Throws if the mesh isn't a closed,
       watertight solid (caller turns that into a friendly message). */
    function toManifold(geometry) {
        const { vertProperties, triVerts } = weldGeometry(geometry);
        const mesh = new wasm.Mesh({ numProp: 3, vertProperties, triVerts });
        mesh.merge();
        return new wasm.Manifold(mesh);
    }

    /* True iff Manifold accepts the mesh as a closed solid. */
    function isWatertight(geometry) {
        try {
            const solid = toManifold(geometry);
            solid.delete();
            return true;
        } catch (err) {
            return false;
        }
    }

    /* Repair ladder: weld small seams, then cap genuine boundary loops. */
    function repairGeometry(geometry) {
        let finest = null, finestEdges = null, previous = null;
        for (const tol of [0.01, 0.05, 0.1]) {
            const welded = weldGeometry(geometry, tol);
            if (previous && sameMesh(previous, welded)) continue; // same mesh, already rejected
            previous = welded;
            const { vertProperties, triVerts } = welded;
            const edges = boundaryEdgesOf(triVerts);
            if (!finest) { finest = { vertProperties, triVerts }; finestEdges = edges; }
            if (edges.length && !openEdgesMayMerge(edges, vertProperties)) continue;
            if (manifoldAccepts(vertProperties, triVerts)) {
                return { vertProperties, triVerts, tol, method: "weld", loops: 0 };
            }
        }

        const boundary = traceBoundaryLoops(finestEdges);
        if (!boundary.loops.length) return null;
        const capped = capBoundaryLoops(finest, boundary);
        if (!capped || !manifoldAccepts(capped.vertProperties, capped.triVerts)) {
            return null;
        }
        return {
            vertProperties: capped.vertProperties,
            triVerts: capped.triVerts,
            tol: 0.01,
            method: "cap",
            loops: capped.loops.length,
        };
    }

    /* Manifold -> THREE.BufferGeometry (copies out of wasm heap).
       Stays INDEXED with no normal attribute — a third of the memory of the
       old unrolled form. Flat looks come from material.flatShading, and the
       STL exporter computes face normals itself. */
    function toGeometry(manifold) {
        const mesh = manifold.getMesh();
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position",
            new THREE.BufferAttribute(mesh.vertProperties.slice(), 3));
        geometry.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1));
        return geometry;
    }

    // ------------------------------------------------------ spline sampling

    const SAMPLES_PER_SEGMENT = 28;

    /* CC.spline {points:[{a,hIn,hOut}], normal, planePoint} -> world-space
       polyline on the cut plane, ends extended straight by extendLen so the
       cut always clears the model. */
    function sampleSpline(spline, extendLen) {
        const pts = [];
        const P = spline.points;
        for (let i = 0; i < P.length - 1; i++) {
            const p0 = P[i], p1 = P[i + 1];
            const a0 = p0.a, c1 = p0.hOut || p0.a, c2 = p1.hIn || p1.a, a1 = p1.a;
            const nSteps = SAMPLES_PER_SEGMENT;
            for (let s = (i === 0 ? 0 : 1); s <= nSteps; s++) {
                const t = s / nSteps, u = 1 - t;
                pts.push(new THREE.Vector3(
                    u * u * u * a0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * a1.x,
                    u * u * u * a0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * a1.y,
                    u * u * u * a0.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * a1.z
                ));
            }
        }
        // drop consecutive duplicates (zero-length handles etc.)
        const clean = pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-6);
        if (clean.length >= 2) {
            const d0 = clean[0].clone().sub(clean[1]).normalize();
            const dn = clean[clean.length - 1].clone().sub(clean[clean.length - 2]).normalize();
            clean.unshift(clean[0].clone().addScaledVector(d0, extendLen));
            clean.push(clean[clean.length - 1].clone().addScaledVector(dn, extendLen));
        }
        return clean;
    }

    // -------------------------------------------------------- cutter solid

    /* Extrude the sampled curve into a closed cutting solid:
       curve polyline (in cut-plane 2D) + a far offset edge close the polygon,
       then extrude along the plane normal through the whole model.
       grow (mm) inflates the cross-section — the kerf-clearance cutter for
       the outside piece, so printed halves mate with a real gap. */
    function buildCutter(spline, extendLen, halfDepth, grow = 0) {
        const n = new THREE.Vector3().copy(spline.normal).normalize();
        const P0 = new THREE.Vector3().copy(spline.planePoint);

        const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const e1 = new THREE.Vector3().crossVectors(up, n).normalize();
        const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();

        const world = sampleSpline(spline, extendLen);
        if (world.length < 2) throw new Error("spline too short");
        const flat = world.map((w) => {
            const d = w.clone().sub(P0);
            return [d.dot(e1), d.dot(e2)];
        });

        // close the polygon on one side, far outside the model
        const first = flat[0], last = flat[flat.length - 1];
        const dir = [last[0] - first[0], last[1] - first[1]];
        const len = Math.hypot(dir[0], dir[1]) || 1;
        const K = extendLen * 2;
        const perp = [(-dir[1] / len) * K, (dir[0] / len) * K];
        const polygon = flat.concat([
            [last[0] + perp[0], last[1] + perp[1]],
            [first[0] + perp[0], first[1] + perp[1]],
        ]);

        // CrossSection sanitizes winding and self-intersections
        let cross = new wasm.CrossSection([polygon], "Positive");
        try {
            if (grow > 0) {
                const grown = cross.offset(grow, "Miter");
                cross.delete();
                cross = grown;
            }
            const cutter = wasm.Manifold.extrude(cross, halfDepth * 2);
            try {
                // extrude() builds from z=0..h in plane space; recenter and move to world
                const m = new THREE.Matrix4().makeBasis(e1, e2, n).setPosition(
                    P0.clone().addScaledVector(n, -halfDepth)
                );
                return cutter.transform(m.elements);
            } finally {
                cutter.delete();
            }
        } finally {
            cross.delete();
        }
    }

    // ------------------------------------------- planar / dovetail cutters

    /* Solid filling everything on the -normal side of the plane through
       `point`. intersect() -> "lower" piece, subtract() -> "upper" piece.
       Works for any plane orientation (the Orca-style rotatable planar cut). */
    function buildPlanarCutter(point, normal, bounds) {
        const size = new THREE.Vector3();
        bounds.getSize(size);
        const reach = size.length() + 20;

        const n = normal.clone().normalize();
        const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const e1 = new THREE.Vector3().crossVectors(up, n).normalize();
        const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();

        const half = reach;
        const cross = new wasm.CrossSection(
            [[[-half, -half], [half, -half], [half, half], [-half, half]]], "Positive");
        try {
            const slab = wasm.Manifold.extrude(cross, reach); // z = 0..reach in plane space
            try {
                // place so the slab fills the -normal side, ending exactly at the plane
                const m = new THREE.Matrix4().makeBasis(e1, e2, n)
                    .setPosition(point.clone().addScaledVector(n, -reach));
                return slab.transform(m.elements);
            } finally {
                slab.delete();
            }
        } finally {
            cross.delete();
        }
    }

    /* Approximate parting-surface height at x for the SINGLE dovetail tooth
       (for the UI preview; the true flanks overhang). Centered at centerX. */
    function dovetailEdgeY(x, centerX, height, depth, width, flare) {
        const dx = Math.abs(x - centerX);
        const innerHalf = Math.max(width / 2 - flare / 2, 0.001);
        const outerHalf = width / 2 + flare / 2;
        if (dx <= innerHalf) return height - depth;
        if (dx >= outerHalf) return height;
        const t = (dx - innerHalf) / (outerHalf - innerHalf);
        return (height - depth) + depth * t;
    }

    /* Orca-style dovetail: ONE trapezoid tongue centered on the cut. The
       parting surface is the plane at `height` with a single dip of `depth`;
       the dip is `width` wide at the plane and flares wider at the tip by the
       flap angle, so the upper piece's tongue slide-locks into the lower
       piece's socket along the groove direction.
       params = {height, depth, width, flapDeg, grooveDeg, cx?, cz?}
       (cx/cz move the tooth across the model; default = bounds center).
       shrink = {w, d} mm — used for the tongue-side cutter so the printed
       pieces mate with clearance instead of binding. */
    function buildDovetailCutter(params, bounds, shrink = { w: 0, d: 0 }) {
        const { height, flapDeg, grooveDeg } = params;
        const depth = Math.max(params.depth - shrink.d, 0.1);
        const width = Math.max(params.width - 2 * shrink.w, 0.2);
        const size = new THREE.Vector3();
        bounds.getSize(size);
        const center = new THREE.Vector3();
        bounds.getCenter(center);
        if (params.cx !== undefined) center.x = params.cx;
        if (params.cz !== undefined) center.z = params.cz;
        const reach = size.length() + 20;
        const yBottom = bounds.min.y - reach;
        const yTip = height - depth;

        // flank overhang: flap measured from the cut plane (Orca convention,
        // 65° default) — steeper flap = less flare
        const flapRad = THREE.MathUtils.degToRad(
            Math.min(Math.max(flapDeg, 30), 89));
        const flare = depth / Math.tan(flapRad);

        // below-the-surface solid: plane at `height` with one flared dip
        const pts = [
            [center.x - reach, yBottom],
            [center.x - reach, height],
            [center.x - width / 2, height],
            [center.x - width / 2 - flare, yTip],
            [center.x + width / 2 + flare, yTip],
            [center.x + width / 2, height],
            [center.x + reach, height],
            [center.x + reach, yBottom],
        ];

        // "Positive" fill needs counterclockwise winding
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
            area += ax * by - bx * ay;
        }
        if (area < 0) pts.reverse();

        const cross = new wasm.CrossSection([pts], "Positive");
        let slab;
        try {
            slab = wasm.Manifold.extrude(cross, 2 * reach);
        } finally {
            cross.delete();
        }
        let cutter;
        try {
            cutter = slab.translate([0, 0, center.z - reach]);
        } finally {
            slab.delete();
        }

        if (grooveDeg) {
            // rotate the tongue's slide direction in the horizontal plane
            const original = cutter;
            let centered = null;
            let rotated = null;
            try {
                centered = original.translate([-center.x, 0, -center.z]);
                rotated = centered.rotate([0, grooveDeg, 0]);
                cutter = rotated.translate([center.x, 0, center.z]);
            } finally {
                if (rotated) rotated.delete();
                if (centered) centered.delete();
                original.delete();
            }
        }
        return cutter;
    }

    // ----------------------------------------------------------- connectors

    /* Plug connector solid: a prism standing on the cut plane at `pos`,
       reaching `depth` along `normal` into the mating piece.
       shape = "circle" (32-gon) | "hexagon"; size = across-flats diameter.
       grow = {r, d} enlarges it for the socket side (the fit tolerance). */
    function buildConnectorSolid(c, grow = { r: 0, d: 0 }) {
        const { pos, normal, shape, size, depth, rotDeg } = c;
        const r = Math.max(size / 2 + grow.r, 0.1);
        const h = Math.max(depth + grow.d, 0.1);
        const n = shape === "hexagon" ? 6 : 32;

        const poly = [];
        const rot = THREE.MathUtils.degToRad(rotDeg || 0);
        for (let i = 0; i < n; i++) {
            const t = rot + (i / n) * Math.PI * 2;
            poly.push([Math.cos(t) * r, Math.sin(t) * r]);
        }

        const nv = normal.clone().normalize();
        const up = Math.abs(nv.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const e1 = new THREE.Vector3().crossVectors(up, nv).normalize();
        const e2 = new THREE.Vector3().crossVectors(nv, e1).normalize();

        const cross = new wasm.CrossSection([poly], "Positive");
        try {
            // start a hair below the plane so the union never leaves a seam
            const prism = wasm.Manifold.extrude(cross, h + 0.05);
            try {
                const m = new THREE.Matrix4().makeBasis(e1, e2, nv)
                    .setPosition(pos.clone().addScaledVector(nv, -0.05));
                return prism.transform(m.elements);
            } finally {
                prism.delete();
            }
        } finally {
            cross.delete();
        }
    }

    // ------------------------------------------------------------- the cut

    /* Split ONE geometry with an already-built cutter solid. Returns
       { inside: BufferGeometry|null, outside: BufferGeometry|null }.
       Throws Error("not-watertight") if the mesh can't be made solid.
       The caller owns (and eventually delete()s) the cutter(s).
       cutterOut (optional) cuts the outside piece with different dimensions —
       that's how dovetail tolerance leaves a clearance gap between pieces.
       connectors (optional) = { pegs: [Manifold], sockets: [Manifold],
       maleSide: "inside"|"outside" } — pegs union onto the male piece (only
       ones that actually touch it), sockets subtract from the female piece.
       The caller owns and deletes the peg/socket solids. */
    function cutWithCutter(geometry, cutter, cutterOut = cutter, connectors = null) {
        let solid;
        try {
            solid = toManifold(geometry);
        } catch (err) {
            throw new Error("not-watertight");
        }
        let a = null;
        let b = null;
        try {
            a = solid.intersect(cutter);
            b = solid.subtract(cutterOut);
            solid.delete();
            solid = null;

            if (connectors) {
                const maleInside = connectors.maleSide === "inside";
                let male = maleInside ? a : b;
                let female = maleInside ? b : a;

                for (const peg of connectors.pegs) {
                    const touch = male.intersect(peg);
                    let touches;
                    try {
                        touches = touch.numTri() > 0;
                    } finally {
                        touch.delete();
                    }
                    if (!touches) continue; // multi-piece scenes: peg belongs elsewhere
                    const previous = male;
                    male = previous.add(peg);
                    if (maleInside) a = male; else b = male;
                    previous.delete();
                }
                for (const socket of connectors.sockets) {
                    const previous = female;
                    female = previous.subtract(socket);
                    if (maleInside) b = female; else a = female;
                    previous.delete();
                }
            }

            let inside = null;
            let outside = null;
            try {
                inside = a.numTri() > 0 ? toGeometry(a) : null;
                outside = b.numTri() > 0 ? toGeometry(b) : null;
                return { inside, outside };
            } catch (err) {
                if (inside) inside.dispose();
                if (outside) outside.dispose();
                throw err;
            }
        } finally {
            if (solid) solid.delete();
            if (a) a.delete();
            if (b) b.delete();
        }
    }

    /* Split each geometry by the spline (same order as input). */
    function cutGeometries(geometries, spline, extendLen, halfDepth) {
        const cutter = buildCutter(spline, extendLen, halfDepth);
        try {
            return geometries.map((g) => cutWithCutter(g, cutter));
        } finally {
            cutter.delete();
        }
    }

    // ------------------------------------------------- Big Print grid cells

    /* Cut ONE grid cell out of an already-built source Manifold (Big Print's
       streaming path: the source stays alive across cells, each part is
       converted out and freed before the next cell starts).
       cell = { x0,x1,y0,y1,z0,z1, in:{x0,x1,y0,y1,z0,z1} } — `in` marks
       interior faces (a neighbor exists there). Interior faces are inset by
       gap/2 so two neighbors assemble with a real `gap` mm clearance; exterior
       faces are padded outward so no boolean runs against a coplanar wall.
       Returns an indexed BufferGeometry, or null for an empty cell.
       conn (optional) adds deterministic seam connectors — pegs on +axis
       interior faces, tolerance-grown sockets on -axis ones; see
       applyCellConnectors. */
    function cutGridCell(solid, cell, gap = 0, conn = null) {
        const g2 = Math.max(gap, 0) / 2;
        const pad = 1; // mm past the model on exterior faces
        const x0 = cell.x0 + (cell.in.x0 ? g2 : -pad);
        const x1 = cell.x1 - (cell.in.x1 ? g2 : -pad);
        const y0 = cell.y0 + (cell.in.y0 ? g2 : -pad);
        const y1 = cell.y1 - (cell.in.y1 ? g2 : -pad);
        const z0 = cell.z0 + (cell.in.z0 ? g2 : -pad);
        const z1 = cell.z1 - (cell.in.z1 ? g2 : -pad);
        if (x1 - x0 <= 0 || y1 - y0 <= 0 || z1 - z0 <= 0) return null;

        const rawBox = wasm.Manifold.cube([x1 - x0, y1 - y0, z1 - z0]);
        let box;
        try {
            box = rawBox.translate([x0, y0, z0]);
        } finally {
            rawBox.delete();
        }
        let part = null;
        try {
            part = solid.intersect(box);
        } finally {
            box.delete();
        }
        try {
            if (part.numTri() === 0) return null;
            if (conn) {
                part = applyCellConnectors(part, solid, cell, { ...conn, gap });
            }
            let engraved = false;
            if (cell.engraveId) {
                const r = engraveCellId(part, cell, cell.engraveId, { gap });
                part = r.part;
                engraved = r.engraved;
            }
            const geometry = toGeometry(part);
            geometry.userData = { engraved };
            return geometry;
        } finally {
            if (part) part.delete();
        }
    }

    /* World-space vector for a seam-plane point (seam from BigPrintCore.seamOf). */
    function seamPoint(seam, p) {
        const v = new THREE.Vector3();
        v[seam.axis] = seam.plane;
        v[seam.u.axis] = p.u;
        v[seam.v.axis] = p.v;
        return v;
    }

    const AXIS_DIR = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

    /* Deterministic connector placement on one seam: candidates come from a
       fixed centered grid (BigPrintCore.seamGridPositions), and a candidate
       survives only if a wall-margin test prism around it sits FULLY inside
       the source model (subtract(prism, solid) is empty — an exact test with
       no orientation bias). Both neighbors of the seam run this with the same
       inputs and get the same answer. Returns world-space THREE.Vector3[].
       opts = { size, depth, spacing?, wall? } (spacing defaults to 5× size,
       wall to 1.5 mm of guaranteed material around peg and socket). */
    function placeSeamConnectors(solid, seam, opts) {
        const spacing = opts.spacing || opts.size * 5;
        const wall = opts.wall === undefined ? 1.5 : opts.wall;
        const inset = opts.size / 2 + wall;
        const candidates = window.BigPrintCore.seamGridPositions(seam, spacing, inset);
        const normal = new THREE.Vector3(...AXIS_DIR[seam.axis]);
        const kept = [];
        for (const c of candidates) {
            const pos = seamPoint(seam, c);
            // test prism: peg + wall margin, both directions from the plane
            const probe = buildConnectorSolid(
                { pos: pos.clone().addScaledVector(normal, -(opts.depth + wall)),
                  normal, shape: "circle", size: opts.size + 2 * wall,
                  depth: 2 * (opts.depth + wall), rotDeg: 0 });
            let fits;
            try {
                const outside = probe.subtract(solid);
                try {
                    fits = outside.numTri() === 0;
                } finally {
                    outside.delete();
                }
            } finally {
                probe.delete();
            }
            if (fits) kept.push(pos);
        }
        return kept;
    }

    /* Big Print seam connectors for ONE cell part (streaming-safe: no state
       shared between cells). Convention: a cell grows PEGS on its +axis
       interior faces (pointing into the higher neighbor) and SOCKETS on its
       -axis interior faces — so every seam gets exactly one peg set and one
       matching tolerance-grown socket set, computed independently by the two
       neighbors. `part` is consumed and a new Manifold returned.
       conn = { size, depth, shape, tolR, tolD, spacing?, wall?, gap } */
    function applyCellConnectors(part, solid, cell, conn) {
        const seams = [];
        for (const axis of ["x", "y", "z"]) {
            if (cell.in[axis + "1"]) seams.push({ axis, dir: +1 });
            if (cell.in[axis + "0"]) seams.push({ axis, dir: -1 });
        }
        let out = part;
        const owned = new Set();
        let complete = false;
        try {
            for (const { axis, dir } of seams) {
                const seam = window.BigPrintCore.seamOf(cell, axis, dir);
                const positions = placeSeamConnectors(solid, seam, conn);
                if (!positions.length) continue;
                const normal = new THREE.Vector3(...AXIS_DIR[axis]);
                const g2 = (conn.gap || 0) / 2;
                for (const pos of positions) {
                    let piece = null;
                    try {
                        if (dir > 0) {
                            // peg: stands on this part's face (gap/2 short of the
                            // seam), reaches depth past the seam into the neighbor
                            piece = buildConnectorSolid(
                                { pos: pos.clone().addScaledVector(normal, -g2),
                                  normal, shape: conn.shape, size: conn.size,
                                  depth: conn.depth + g2, rotDeg: 0 });
                            const touch = out.intersect(piece);
                            let touches;
                            try {
                                touches = touch.numTri() > 0;
                            } finally {
                                touch.delete();
                            }
                            if (touches) {
                                const previous = out;
                                out = previous.add(piece);
                                owned.add(out);
                                if (previous !== part) {
                                    previous.delete();
                                    owned.delete(previous);
                                }
                            }
                        } else {
                            // socket: the neighbor's peg, grown by the fit tolerance
                            piece = buildConnectorSolid(
                                { pos: pos.clone().addScaledVector(normal, -g2),
                                  normal, shape: conn.shape, size: conn.size,
                                  depth: conn.depth + g2, rotDeg: 0 },
                                { r: (conn.tolR || 0) / 2, d: conn.tolD || 0 });
                            const previous = out;
                            out = previous.subtract(piece);
                            owned.add(out);
                            if (previous !== part) {
                                previous.delete();
                                owned.delete(previous);
                            }
                        }
                    } finally {
                        if (piece) piece.delete();
                    }
                }
            }
            if (out !== part) part.delete();
            complete = true;
            return out;
        } finally {
            if (!complete) for (const made of owned) made.delete();
        }
    }

    // ------------------------------------------------- Big Print engraving

    /* Single-stroke font text -> engraving solid. Each Hershey stroke becomes
       a chain of width-`w` quads with small joint circles; the "Positive"
       fill rule unions the overlaps into one clean cross-section. Returns
       { solid, area, width } — `area` is the exact ink area, so tests can
       assert volume drops by area × depth. Layout: text centered on `pos`,
       reading correctly for a viewer looking at the face from OUTSIDE
       (basis e1 = text right, e2 = text up, outward = face normal); the
       solid spans `depth` into the material plus a 0.05 mm proud skin.
       font = window.HERSHEY_FONT (passed in so this file stays vendor-free). */
    function buildTextSolid(font, text, { height, depth, pos, e1, e2, outward }) {
        const s = height / font.capHeight;
        const w = Math.max(0.8, height * 0.14); // stroke width, printable floor
        const polys = [];
        const circle = (cx, cy, r) => {
            const pts = [];
            for (let i = 0; i < 8; i++) {
                const t = (i / 8) * Math.PI * 2;
                pts.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r]);
            }
            return pts;
        };

        let penX = 0;
        for (const ch of text) {
            const g = font.glyphs[ch] || font.glyphs["?"];
            if (!g) { penX += 10 * s; continue; }
            for (const stroke of g.s) {
                const P = stroke.map(([x, y]) => [(penX + (x - g.l)) * 1, -y]); // y-down -> y-up
                for (let i = 0; i < P.length - 1; i++) {
                    const [ax, ay] = P[i], [bx, by] = P[i + 1];
                    const dx = bx - ax, dy = by - ay;
                    const len = Math.hypot(dx, dy);
                    if (len < 1e-6) continue;
                    const nx = (-dy / len) * (w / s / 2), ny = (dx / len) * (w / s / 2);
                    // counterclockwise winding — "Positive" fill unions, CW would subtract
                    polys.push([[ax - nx, ay - ny], [bx - nx, by - ny],
                        [bx + nx, by + ny], [ax + nx, ay + ny]]);
                }
                for (const [px, py] of P) polys.push(circle(px, py, w / s / 2));
            }
            penX += (g.r - g.l);
        }
        if (!polys.length) return null;

        // scale to mm and center the ink on the origin
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const poly of polys) for (const p of poly) {
            p[0] *= s; p[1] *= s;
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        for (const poly of polys) for (const p of poly) { p[0] -= cx; p[1] -= cy; }

        const cross = new wasm.CrossSection(polys, "Positive");
        try {
            const area = cross.area();
            const prism = wasm.Manifold.extrude(cross, depth + 0.05);
            try {
                // extrusion runs 0..depth+0.05 along +z; place z=0 `depth` inside the
                // surface so the solid ends 0.05 proud of the face
                const m = new THREE.Matrix4()
                    .makeBasis(e1.clone().normalize(), e2.clone().normalize(), outward.clone().normalize())
                    .setPosition(pos.clone().addScaledVector(outward.clone().normalize(), -depth));
                return { solid: prism.transform(m.elements), area, width: maxX - minX };
            } finally {
                prism.delete();
            }
        } finally {
            cross.delete();
        }
    }

    /* Rough text width without building the solid (advance sum, a hair
       wider than the real ink — conservative for fit checks). */
    function estimateTextWidth(font, text, height) {
        const s = height / font.capHeight;
        let w = 0;
        for (const ch of text) {
            const g = font.glyphs[ch] || font.glyphs["?"];
            w += g ? (g.r - g.l) * s : 10 * s;
        }
        return w;
    }

    /* Engrave a part's ID onto an interior cut face (Max's B2-style grid
       labels — outside faces stay clean). Real parts rarely fill their grid
       cell, so the label is NOT blindly centered on the cell face: candidate
       spots are probed center-out with a text-sized box that must sit fully
       inside the part's material (the same exact subtract-is-empty test the
       seam connectors use). Falls through every interior face and a ladder
       of smaller text sizes before giving up — and engraved=true is only
       returned when a placement genuinely landed on plastic. `part` is
       consumed and a new Manifold returned. opts = { gap, height?, depth? } */
    function engraveCellId(part, cell, id, opts) {
        const input = part;
        let keepPart = false;
        const finish = (result) => { keepPart = true; return result; };
        try {
            const font = window.HERSHEY_FONT;
            const faces = [];
            for (const axis of ["x", "y", "z"]) {
                for (const dir of [+1, -1]) {
                    if (!cell.in[axis + (dir > 0 ? "1" : "0")]) continue;
                    const seam = window.BigPrintCore.seamOf(cell, axis, dir);
                    const du = seam.u.hi - seam.u.lo, dv = seam.v.hi - seam.v.lo;
                    faces.push({ seam, dir, du, dv, area: du * dv });
                }
            }
            if (!faces.length || !font) return finish({ part, engraved: false });
            faces.sort((a, b) => b.area - a.area);
            const depth = opts.depth || 0.6;
            const g2 = (opts.gap || 0) / 2;
            let probesLeft = 48; // depth-backing booleans, hard budget per part

            for (const f of faces) {
                const outward = new THREE.Vector3(...AXIS_DIR[f.seam.axis]).multiplyScalar(f.dir);
                // text up = world up on vertical faces (x/z seams); on horizontal
                // (y) seams the baseline runs along X
                let e1, e2;
                if (f.seam.axis === "y") {
                    e1 = new THREE.Vector3(1, 0, 0);
                    e2 = new THREE.Vector3().crossVectors(outward, e1);
                } else {
                    e2 = new THREE.Vector3(0, 1, 0);
                    e1 = new THREE.Vector3().crossVectors(e2, outward);
                }

                // the part's REAL material footprint on this face: rotate so the
                // face plane becomes z = h, slice just inside the surface.
                // {e1, e2, outward} is right-handed, so rows(e1,e2,outward) is a
                // pure rotation and slice (x, y) coordinates are (p·e1, p·e2).
                const surfacePoint = seamPoint(f.seam, {
                    u: (f.seam.u.lo + f.seam.u.hi) / 2,
                    v: (f.seam.v.lo + f.seam.v.hi) / 2,
                }).addScaledVector(outward, -g2);
                const h = surfacePoint.dot(outward);
                const rot = new THREE.Matrix4().makeBasis(e1, e2, outward).transpose();
                const rotated = part.transform(rot.elements);
                let cross;
                try {
                    cross = rotated.slice(h - 0.25);
                } finally {
                    rotated.delete();
                }
                try {
                    if (!cross.toPolygons().length) continue;

                    const maxH = Math.min(opts.height || 10, 0.35 * Math.min(f.du, f.dv));
                    for (const height of [maxH, 7, 5, 3.5]) {
                        if (height < 3 || height > maxH + 1e-9) continue;
                        const textW = estimateTextWidth(font, id, height);
                        const probeW = textW + 3, probeH = height + 3;

                        // two erosions of the footprint, tried in order:
                        //  1) half-diagonal — anywhere left fits the whole label, so
                        //     the first candidates on solid faces land immediately;
                        //  2) short-half — survivors trace thin strips' centerlines
                        //     (curved hull walls), where only the real box probe can
                        //     judge the fit.
                        const verts = [];
                        for (const d of [Math.hypot(probeW, probeH) / 2, probeH / 2 + 0.5]) {
                            const eroded = cross.offset(-d, "Round");
                            try {
                                const polys = eroded.toPolygons();
                                if (!polys.length) continue;
                                const b = eroded.bounds();
                                const mid = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
                                verts.push(...polys.flat()
                                    .sort((p, q) => (p[0] - mid[0]) ** 2 + (p[1] - mid[1]) ** 2
                                        - ((q[0] - mid[0]) ** 2 + (q[1] - mid[1]) ** 2))
                                    .slice(0, 6));
                            } finally {
                                eroded.delete();
                            }
                        }
                        if (!verts.length) continue;

                        for (const [a, bV] of verts) {
                            if (probesLeft-- <= 0) break;
                            const pos = new THREE.Vector3()
                                .addScaledVector(e1, a).addScaledVector(e2, bV)
                                .addScaledVector(outward, h);
                            // one boolean check: the slice proves the footprint, this
                            // proves the 0.6 mm of DEPTH behind it (thin shells)
                            const inward = outward.clone().negate();
                            const m = new THREE.Matrix4().makeBasis(e1, e2, inward)
                                .setPosition(pos.clone()
                                    .addScaledVector(e1, -probeW / 2)
                                    .addScaledVector(e2, -probeH / 2)
                                    .addScaledVector(inward, 0.05));
                            const probe = wasm.Manifold.cube([probeW, probeH, depth + 1]);
                            let placed;
                            try {
                                placed = probe.transform(m.elements);
                            } finally {
                                probe.delete();
                            }
                            let fits;
                            try {
                                const leak = placed.subtract(part);
                                try {
                                    fits = leak.numTri() === 0;
                                } finally {
                                    leak.delete();
                                }
                            } finally {
                                placed.delete();
                            }
                            if (!fits) continue;

                            const label = buildTextSolid(font, id,
                                { height, depth, pos, e1, e2, outward });
                            if (!label) return finish({ part, engraved: false });
                            let carved;
                            try {
                                carved = part.subtract(label.solid);
                            } finally {
                                label.solid.delete();
                            }
                            const previous = part;
                            part = carved;
                            previous.delete();
                            return finish({ part, engraved: true, area: label.area, depth, height });
                        }
                    }
                } finally {
                    cross.delete();
                }
            }
            return finish({ part, engraved: false }); // nowhere to land it — manifest says so
        } finally {
            if (!keepPart && part !== input) part.delete();
        }
    }

    /* Reduce triangle count within a geometric tolerance (mm). Throws
       Error("not-watertight") if the mesh can't be made solid first. */
    function simplifyGeometry(geometry, tolerance) {
        let solid;
        try {
            solid = toManifold(geometry);
        } catch (err) {
            throw new Error("not-watertight");
        }
        try {
            const slim = solid.simplify(tolerance);
            try {
                return toGeometry(slim);
            } finally {
                slim.delete();
            }
        } finally {
            solid.delete();
        }
    }

    /* Reduce toward a target triangle count (not a fixed tolerance), so
       detail is only removed until the mesh is light enough — never nuked.
       Ramps the tolerance up gently and stops at the first result under
       target. Throws Error("not-watertight") like simplifyGeometry. */
    function simplifyToTarget(geometry, targetTris) {
        let current;
        try {
            current = toManifold(geometry);
        } catch (err) {
            throw new Error("not-watertight");
        }
        const original = current;
        try {
            geometry.computeBoundingBox();
            const size = new THREE.Vector3();
            geometry.boundingBox.getSize(size);
            const diag = size.length();

            let eps = diag * 2e-6;
            const epsMax = diag * 0.01;
            for (let i = 0; current.numTri() > targetTris && eps < epsMax && i < 24; i++) {
                const next = current.simplify(eps);
                if (current !== original) current.delete();
                current = next;
                eps *= 1.7;
            }
            return toGeometry(current);
        } finally {
            if (current !== original) current.delete();
            original.delete();
        }
    }

    // signed volume of a geometry, indexed or not (for tests / sanity checks)
    function geometryVolume(geometry) {
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const count = index ? index.count : pos.count;
        const at = index ? (i) => index.getX(i) : (i) => i;
        let v = 0;
        for (let i = 0; i < count; i += 3) {
            const a = at(i), b = at(i + 1), c = at(i + 2);
            const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
            const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
            const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
            v += (ax * (by * cz - bz * cy) + bx * (cy * az - cz * ay) + cx * (ay * bz - az * by)) / 6;
        }
        return Math.abs(v);
    }

    window.CutCore = {
        init,
        isReady: () => !!wasm,
        weldGeometry, findBoundaryLoops, capBoundaryLoops,
        toManifold, toGeometry, isWatertight, repairGeometry,
        sampleSpline, buildCutter, cutWithCutter, cutGeometries,
        buildPlanarCutter, buildDovetailCutter, dovetailEdgeY,
        buildConnectorSolid, cutGridCell, placeSeamConnectors, applyCellConnectors,
        buildTextSolid, engraveCellId,
        simplifyGeometry, simplifyToTarget, geometryVolume,
    };
})();
