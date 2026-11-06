/* Curve Cut — DOM-free mesh analysis for the page API (measure, section
   profile, mesh diagnosis). Input is {positions, index}: a Float32Array of
   xyz in scene axes (Y up) and a Uint32Array of triangle corners, already
   welded (indexed). Everything it returns is in printer axes and millimetres:
   x = width, y = depth, z = height (scene x, z, y). */

((root) => {
    "use strict";

    const CC = root.CurveCut = root.CurveCut || {};
    const AXIS = { x: 0, y: 1, z: 2 };
    const OVERHANG_COS = Math.SQRT1_2;   // 45 degrees from straight down
    const CONTACT_COS = 0.99;            // "flat enough to sit on the bed"
    const CONTACT_DEPTH_MM = 0.01;
    const TINY_AREA_MM2 = 1e-5;

    /* Scene (x, y, z) -> printer (x, z, y). Swapping two axes mirrors the mesh,
       so two corners of every triangle swap too and normals stay outward. */
    function toPrinter(mesh) {
        const src = mesh.positions, idx = mesh.index;
        const pos = new Float32Array(src.length);
        for (let i = 0; i < src.length; i += 3) {
            pos[i] = src[i]; pos[i + 1] = src[i + 2]; pos[i + 2] = src[i + 1];
        }
        const tri = new Uint32Array(idx.length);
        for (let i = 0; i < idx.length; i += 3) {
            tri[i] = idx[i]; tri[i + 1] = idx[i + 2]; tri[i + 2] = idx[i + 1];
        }
        return { pos, tri };
    }

    function bounds(pos) {
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i += 3) {
            for (let a = 0; a < 3; a++) {
                const v = pos[i + a];
                if (v < min[a]) min[a] = v;
                if (v > max[a]) max[a] = v;
            }
        }
        return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
    }

    /* Cross product of a triangle's two edges (twice its area, pointing outward). */
    function triCross(pos, tri, t, out) {
        const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        out[0] = uy * vz - uz * vy;
        out[1] = uz * vx - ux * vz;
        out[2] = ux * vy - uy * vx;
    }

    /* Edge bookkeeping: how many triangles share each edge, and whether the
       two sides run opposite ways (a consistent, closed surface). */
    function topology(tri, vertexCount) {
        const K = vertexCount + 1;
        const index = new Map();
        const count = [], forward = [], backward = [];
        for (let t = 0; t < tri.length; t += 3) {
            for (let e = 0; e < 3; e++) {
                const a = tri[t + e], b = tri[t + (e + 1) % 3];
                const lo = a < b ? a : b, hi = a < b ? b : a;
                const key = lo * K + hi;
                let i = index.get(key);
                if (i === undefined) {
                    i = count.length;
                    index.set(key, i);
                    count.push(0); forward.push(0); backward.push(0);
                }
                count[i]++;
                if (a < b) forward[i]++; else backward[i]++;
            }
        }
        let open = 0, nonManifold = 0, inconsistent = 0;
        for (let i = 0; i < count.length; i++) {
            if (count[i] === 1) open++;
            else if (count[i] > 2) nonManifold++;
            else if (forward[i] !== 1 || backward[i] !== 1) inconsistent++;
        }
        return { open, nonManifold, inconsistent };
    }

    /* Connected pieces of the surface (triangles that share a vertex). */
    function shells(tri, vertexCount) {
        const parent = new Int32Array(vertexCount);
        for (let i = 0; i < vertexCount; i++) parent[i] = i;
        const find = (v) => {
            while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v]; }
            return v;
        };
        for (let t = 0; t < tri.length; t += 3) {
            const a = find(tri[t]), b = find(tri[t + 1]), c = find(tri[t + 2]);
            if (a !== b) parent[b] = a;
            const a2 = find(a);
            if (a2 !== c) parent[c] = a2;
        }
        const sizes = new Map();
        for (let t = 0; t < tri.length; t += 3) {
            const r = find(tri[t]);
            sizes.set(r, (sizes.get(r) || 0) + 1);
        }
        return [...sizes.values()].sort((p, q) => q - p);
    }

    /* Overhang / flat-contact areas for one "down" direction ({axis, sign}). */
    function overhangFor(pos, tri, axis, sign) {
        let lowest = -Infinity;
        for (let i = axis; i < pos.length; i += 3) {
            const d = pos[i] * sign;
            if (d > lowest) lowest = d;
        }
        const n = [0, 0, 0];
        let overhang = 0, contact = 0, total = 0;
        for (let t = 0; t < tri.length; t += 3) {
            triCross(pos, tri, t, n);
            const len = Math.hypot(n[0], n[1], n[2]);
            if (len === 0) continue;
            const area = len / 2;
            total += area;
            const facing = (n[axis] * sign) / len;
            if (facing <= OVERHANG_COS) continue;
            const onBed = facing > CONTACT_COS
                && pos[tri[t] * 3 + axis] * sign > lowest - CONTACT_DEPTH_MM
                && pos[tri[t + 1] * 3 + axis] * sign > lowest - CONTACT_DEPTH_MM
                && pos[tri[t + 2] * 3 + axis] * sign > lowest - CONTACT_DEPTH_MM;
            if (onBed) contact += area; else overhang += area;
        }
        return { overhang, contact, total, height: 0 };
    }

    const round = (v, d = 3) => { const k = 10 ** d; return Math.round(v * k) / k; };

    /* Everything `measure` reports for one piece. */
    function measure(mesh) {
        const { pos, tri } = toPrinter(mesh);
        const box = bounds(pos);
        let volume = 0, area = 0;
        const n = [0, 0, 0];
        for (let t = 0; t < tri.length; t += 3) {
            triCross(pos, tri, t, n);
            area += Math.hypot(n[0], n[1], n[2]) / 2;
            const a = tri[t] * 3;   // signed tetrahedron against the origin
            volume += (pos[a] * n[0] + pos[a + 1] * n[1] + pos[a + 2] * n[2]) / 6;
        }
        const vertexCount = pos.length / 3;
        const topo = topology(tri, vertexCount);
        const shellSizes = shells(tri, vertexCount);

        // "down" = the model-space direction that points at the bed in that pose
        const dirs = [["+x", 0, 1], ["-x", 0, -1], ["+y", 1, 1], ["-y", 1, -1], ["+z", 2, 1], ["-z", 2, -1]];
        let best = null;
        for (const [down, axis, sign] of dirs) {
            const r = overhangFor(pos, tri, axis, sign);
            const candidate = { down, overhang_area_mm2: r.overhang, contact_area_mm2: r.contact,
                height_mm: box.size[axis] };
            if (!best || candidate.overhang_area_mm2 < best.overhang_area_mm2 - 1e-6
                || (Math.abs(candidate.overhang_area_mm2 - best.overhang_area_mm2) <= 1e-6
                    && candidate.contact_area_mm2 > best.contact_area_mm2)) best = candidate;
        }
        const now = overhangFor(pos, tri, 2, -1);
        const pct = (v) => (area > 0 ? round(100 * v / area, 1) : 0);
        return {
            size_mm: box.size.map((v) => round(v)),
            volume_mm3: Math.abs(volume),
            surface_area_mm2: area,
            triangles: tri.length / 3,
            watertight: topo.open === 0 && topo.nonManifold === 0 && topo.inconsistent === 0 && tri.length > 0,
            shells: shellSizes.length,
            open_edges: topo.open,
            overhang: { area_mm2: round(now.overhang), percent: pct(now.overhang) },
            best_orientation: {
                down: best.down,
                overhang_area_mm2: round(best.overhang_area_mm2),
                overhang_percent: pct(best.overhang_area_mm2),
                contact_area_mm2: round(best.contact_area_mm2),
                height_mm: round(best.height_mm),
            },
        };
    }

    function pointInLoop(x, y, loop) {
        let inside = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const [xi, yi] = loop[i], [xj, yj] = loop[j];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    const loopArea = (loop) => {
        let s = 0;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            s += loop[j][0] * loop[i][1] - loop[i][0] * loop[j][1];
        }
        return Math.abs(s) / 2;
    };

    function sectionProfile(mesh, axisName, samples) {
        const axis = AXIS[axisName];
        const { pos, tri } = toPrinter(mesh);
        const box = bounds(pos);
        const len = box.size[axis];
        const step = len / samples;
        const K = pos.length / 3 + 1;
        const buckets = Array.from({ length: samples }, () => []);
        for (let t = 0; t < tri.length; t += 3) {
            const a = pos[tri[t] * 3 + axis], b = pos[tri[t + 1] * 3 + axis], c = pos[tri[t + 2] * 3 + axis];
            const lo = Math.max(0, Math.ceil((Math.min(a, b, c) - box.min[axis]) / step - 0.5));
            const hi = Math.min(samples - 1, Math.floor((Math.max(a, b, c) - box.min[axis]) / step - 0.5));
            for (let s = lo; s <= hi; s++) buckets[s].push(t);
        }
        const out = [];
        for (let s = 0; s < samples; s++) {
            const c = box.min[axis] + (s + 0.5) * step;
            const u = (axis + 1) % 3, v = (axis + 2) % 3;
            const points = new Map(), links = new Map();
            const crossing = (a, b) => {
                const lo = a < b ? a : b, hi = a < b ? b : a, key = lo * K + hi;
                if (!points.has(key)) {
                    const f = (c - pos[lo * 3 + axis]) / (pos[hi * 3 + axis] - pos[lo * 3 + axis]);
                    points.set(key, [pos[lo * 3 + u] + f * (pos[hi * 3 + u] - pos[lo * 3 + u]),
                        pos[lo * 3 + v] + f * (pos[hi * 3 + v] - pos[lo * 3 + v])]);
                }
                return key;
            };
            for (const t of buckets[s]) {
                const corner = [tri[t], tri[t + 1], tri[t + 2]];
                const above = corner.map((q) => pos[q * 3 + axis] >= c);
                if (above[0] === above[1] && above[1] === above[2]) continue;
                const keys = [];
                for (let e = 0; e < 3; e++) {
                    if (above[e] !== above[(e + 1) % 3]) keys.push(crossing(corner[e], corner[(e + 1) % 3]));
                }
                if (keys.length !== 2) continue;
                for (const [p, q] of [[keys[0], keys[1]], [keys[1], keys[0]]]) {
                    const list = links.get(p);
                    if (list) list.push(q); else links.set(p, [q]);
                }
            }
            // walk the links into closed loops (open chains are dropped)
            const used = new Set(), loops = [];
            for (const start of links.keys()) {
                if (used.has(start)) continue;
                const loop = [];
                let prev = null, cur = start;
                for (;;) {
                    used.add(cur);
                    loop.push(points.get(cur));
                    const next = links.get(cur).find((k) => k !== prev && !used.has(k));
                    if (next === undefined) break;
                    prev = cur; cur = next;
                }
                if (loop.length >= 3 && links.get(cur).includes(start)) loops.push(loop);
            }
            const info = loops.map((loop) => ({ loop, area: loopArea(loop), depth: 0 }));
            for (const a of info) {
                for (const b of info) {
                    if (b !== a && b.area > a.area && pointInLoop(a.loop[0][0], a.loop[0][1], b.loop)) a.depth++;
                }
            }
            let area = 0, islands = 0;
            for (const a of info) {
                if (a.depth % 2 === 0) { area += a.area; islands++; } else area -= a.area;
            }
            out.push({ at_mm: round(c - box.min[axis]), area_mm2: round(Math.max(0, area)), islands });
        }
        return out;
    }

    /* Defects and plain-language hints. `holeLoops` comes from the caller
       (CutCore.findBoundaryLoops) so this file stays free of the engine. */
    function diagnose(mesh, holeLoops) {
        const { pos, tri } = toPrinter(mesh);
        const vertexCount = pos.length / 3;
        const topo = topology(tri, vertexCount);
        const shellSizes = shells(tri, vertexCount);
        const n = [0, 0, 0];
        let tiny = 0;
        for (let t = 0; t < tri.length; t += 3) {
            triCross(pos, tri, t, n);
            if (Math.hypot(n[0], n[1], n[2]) / 2 < TINY_AREA_MM2) tiny++;
        }
        const looseShells = shellSizes.slice(1).filter((s) => s < Math.max(10, shellSizes[0] * 0.01)).length;
        const hints = [];
        if (topo.open) {
            hints.push(`The surface has ${topo.open} open edge${topo.open === 1 ? "" : "s"}`
                + (holeLoops ? ` forming ${holeLoops} hole${holeLoops === 1 ? "" : "s"}` : "")
                + ". Run repair before cutting.");
        }
        if (topo.nonManifold) hints.push(`${topo.nonManifold} edges are shared by more than two faces. Repair may fix it; otherwise the model needs editing in a modelling tool.`);
        if (topo.inconsistent) hints.push(`${topo.inconsistent} edges have faces turned the wrong way round. Repair usually flips them.`);
        if (looseShells) hints.push(`${looseShells} tiny loose piece${looseShells === 1 ? "" : "s"} float apart from the main body. They are usually leftovers and can be removed.`);
        else if (shellSizes.length > 1) hints.push(`The model is ${shellSizes.length} separate bodies, not one.`);
        if (tiny) hints.push(`${tiny} triangles are nearly flat slivers. Simplify or repair will clear them.`);
        if (!hints.length) hints.push("No defects found. The mesh is a clean closed surface.");
        return {
            open_edges: topo.open,
            hole_loops: holeLoops || 0,
            non_manifold_edges: topo.nonManifold,
            inconsistent_edges: topo.inconsistent,
            shells: shellSizes.length,
            loose_shells: looseShells,
            tiny_triangles: tiny,
            hints,
        };
    }

    CC.AnalysisCore = { measure, sectionProfile, diagnose, round };
})(typeof window === "undefined" ? globalThis : window);
