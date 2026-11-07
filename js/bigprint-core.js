/* Curve Cut — Big Print core (v2.0)
   DOM-free math for the Big Print mode: printer presets, scale linking,
   grid-cut positions, part IDs. No Three.js, no DOM — covered headlessly
   by tests/bigprint-test.html via tools/check_bigprint.py.

   Axis mapping (the scene is Y-up, printers are Z-up):
   bed width  → scene X (columns, lettered A..Z, AA..)
   bed depth  → scene Z (rows, numbered 1..)
   bed height → scene Y (layers, suffixed -L2.. — omitted on layer 1) */

window.BigPrintCore = (() => {
    "use strict";

    /* Meetup printer list (Max, 2026-07-13) — w×d×h in mm, printer coordinates.
       H2C uses its dual-nozzle usable volume, the conservative number. */
    const PRINTERS = [
        { brand: "Bambu Lab", model: "H2S", w: 340, d: 320, h: 340 },
        { brand: "Bambu Lab", model: "H2D", w: 340, d: 320, h: 325 },
        { brand: "Bambu Lab", model: "H2C", w: 300, d: 320, h: 325 },
        { brand: "Bambu Lab", model: "A1 / P1 / X1", w: 256, d: 256, h: 256 },
        { brand: "Bambu Lab", model: "A1 mini", w: 180, d: 180, h: 180 },
        { brand: "Sovol", model: "SV08", w: 350, d: 350, h: 350 },
        { brand: "Sovol", model: "SV08 Max", w: 500, d: 500, h: 500 },
        { brand: "Creality", model: "CR-10", w: 300, d: 300, h: 400 },
        { brand: "Creality", model: "Ender 3", w: 220, d: 220, h: 250 },
        { brand: "Qidi", model: "Plus 4", w: 305, d: 305, h: 280 },
        { brand: "Qidi", model: "Q2", w: 270, d: 270, h: 256 },
        { brand: "Flashforge", model: "AD5X", w: 220, d: 220, h: 220 },
        { brand: "Snapmaker", model: "U1", w: 270, d: 270, h: 270 },
        { brand: "Prusa", model: "MK4 / MK3", w: 250, d: 210, h: 220 },
    ];

    /* Cut positions along one axis, as offsets in (0, size).
       Segments never exceed `usable`. Default phase centers the grid so the
       two edge parts share the slack equally; `nudge` (mm) slides every cut. */
    function axisCuts(size, usable, nudge = 0) {
        if (!(usable > 0) || size <= usable) return [];
        const n = Math.ceil(size / usable);
        const slack = n * usable - size;
        const w = slack / 2;
        // A nudge past the window would wrap round and add a sliver part, so it
        // stops at the window edge instead (the part count never rises).
        const nd = Number.isFinite(nudge) ? Math.min(Math.max(nudge, -w), w) : 0;
        let phase = usable - w + nd;
        phase = Math.min(Math.max(phase, usable - slack), usable);
        const cuts = [];
        for (let t = phase; t < size - 1e-9 && cuts.length < n - 1; t += usable) cuts.push(t);
        return cuts;
    }

    /* How far the cuts on one axis can slide before another part would appear. */
    function nudgeWindow(size, usable) {
        if (!(usable > 0) || size <= usable) return { lo: 0, hi: 0 };
        const w = (Math.ceil(size / usable) * usable - size) / 2;
        return { lo: -w, hi: w };
    }

    /* Wall lists (DESIGN-SLIVERS phase 0): the grid is three sorted lists of wall
       positions, mm from the scaled model's low edge on each axis. */
    const MIN_WALL_GAP_MM = 1;

    /* The biggest cell on one axis. An axis with walls has pegs, so with a
       reserve the cell shrinks by it; an axis without walls keeps the full room. */
    function cellLimit(room, reserve, hasWalls) {
        return hasWalls && reserve > 0 ? room - reserve : room;
    }

    /* Grid from explicit wall lists. Same shape as computeGrid's result. Does not
       validate the lists (see checkWalls): auto lists are trusted. */
    function gridFromWalls({ size, bed, margin = 5, reserve = 0, walls }) {
        const room = {
            x: bed.w - 2 * margin,
            z: bed.d - 2 * margin,
            y: bed.h - 2 * margin,
        };
        if (room.x <= 0 || room.y <= 0 || room.z <= 0) return null;
        const r = reserve > 0 ? reserve : 0;
        const usable = {}, cuts = {};
        for (const axis of ["x", "y", "z"]) {
            usable[axis] = cellLimit(room[axis], r, walls[axis].length > 0);
            if (usable[axis] <= 0) return null;
            cuts[axis] = walls[axis].slice();
        }
        const counts = { x: cuts.x.length + 1, y: cuts.y.length + 1, z: cuts.z.length + 1 };
        return { room, usable, reserve: r, cuts, counts, total: counts.x * counts.y * counts.z };
    }

    /* Full auto-placed grid for a scaled model: sizes in mm (scene axes), bed in
       printer coordinates, margin off every bed dimension, per-axis nudges.
       `reserve` (mm) = how far a connector peg stands past a cell face. On an
       axis that gets cut (so it gets seams, so it gets pegs) the cell shrinks
       by `reserve`, so a part plus its pegs still fits the bed minus margin.
       `room` = bed minus margin; `usable` = the cell size the cuts use. */
    function computeGrid({ size, bed, margin = 5, nudge = { x: 0, y: 0, z: 0 }, reserve = 0 }) {
        const room = {
            x: bed.w - 2 * margin,
            z: bed.d - 2 * margin,
            y: bed.h - 2 * margin,
        };
        if (room.x <= 0 || room.y <= 0 || room.z <= 0) return null;
        const r = reserve > 0 ? reserve : 0;
        const cuts = {};
        for (const axis of ["x", "y", "z"]) {
            const n = nudge[axis] || 0;
            cuts[axis] = axisCuts(size[axis], room[axis], n);
            if (cuts[axis].length && r > 0) {
                const usable = room[axis] - r;
                if (usable <= 0) return null;
                cuts[axis] = axisCuts(size[axis], usable, n);
            }
        }
        return gridFromWalls({ size, bed, margin, reserve: r, walls: cuts });
    }

    /* null if a hand-placed list is fine, else why not. First failure wins. */
    function checkWalls(list, size, limit) {
        if (list.some((v) => !Number.isFinite(v) || v <= 0 || v >= size)) return "outside";
        for (let i = 1; i < list.length; i++) if (!(list[i] > list[i - 1])) return "not-sorted";
        const b = [0, ...list, size];
        for (let i = 1; i < b.length; i++) if (b[i] - b[i - 1] < MIN_WALL_GAP_MM - 1e-9) return "too-close";
        for (let i = 1; i < b.length; i++) if (b[i] - b[i - 1] > limit + 1e-9) return "too-big";
        return null;
    }

    const limitKey = (p) => JSON.stringify([p.size.x, p.size.y, p.size.z,
        p.bed.w, p.bed.d, p.bed.h, p.margin, p.reserve > 0 ? p.reserve : 0]);

    /* Where auto walls come from. The only such place (no-cut zones plug in here). */
    function autoWalls(auto, axis) {
        return auto.cuts[axis].slice();
    }

    /* The one place params turn into walls. `prev` = last return value or null.
       Hand axes survive a refresh unless the cell limit's inputs changed (scale,
       printer, margin, reserve) or the list is no longer valid. */
    function resolveLayout(prev, p) {
        const auto = computeGrid(p);
        if (!auto) return null;
        const key = limitKey(p);
        const reset = !prev || prev.key !== key;
        const mode = {}, walls = {}, win = {}, nudge = {};
        for (const axis of ["x", "y", "z"]) {
            mode[axis] = "auto";
            if (!reset && prev.mode[axis] === "hand") {
                const list = prev.walls[axis];
                const lim = cellLimit(auto.room[axis], auto.reserve, list.length > 0);
                if (lim > 0 && checkWalls(list, p.size[axis], lim) === null) {
                    mode[axis] = "hand";
                    walls[axis] = list.slice();
                }
            }
            if (mode[axis] === "auto") walls[axis] = autoWalls(auto, axis);
        }
        const grid = gridFromWalls({ size: p.size, bed: p.bed, margin: p.margin, reserve: p.reserve, walls });
        for (const axis of ["x", "y", "z"]) {
            win[axis] = nudgeWindow(p.size[axis], auto.usable[axis]);
            const raw = (p.nudge || {})[axis];
            nudge[axis] = mode[axis] === "auto" && Number.isFinite(raw)
                ? Math.min(Math.max(raw, win[axis].lo), win[axis].hi) : 0;
        }
        return { key, mode, walls, nudge, window: win, grid };
    }

    /* 0 → A, 25 → Z, 26 → AA (spreadsheet style). */
    function colLetter(i) {
        let s = "";
        for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
            s = String.fromCharCode(65 + (n % 26)) + s;
        }
        return s;
    }

    /* B2-style ID: column letter + row number, -L<layer> above layer 1. */
    function partId(col, row, layer = 0, layerCount = 1) {
        const base = colLetter(col) + (row + 1);
        return layerCount > 1 && layer > 0 ? `${base}-L${layer + 1}` : base;
    }

    /* Candidate-cell count from the grid spans. Kept separate from iteration
       so estimates and safety checks never need to materialize cells. */
    function cellCount(grid) {
        return (grid.cuts.x.length + 1) * (grid.cuts.y.length + 1)
            * (grid.cuts.z.length + 1);
    }

    /* Lazily enumerate grid cells in assembly order (layer → row → column),
       each with world bounds and interior-face flags for the kerf insets and
       (step 4) seam connectors. `min` = the scaled model's bbox minimum.
       Cells are candidates — the cutter skips the ones the model never enters. */
    function* gridCells(grid, size, min) {
        const bounds = (axis) => {
            const b = [0, ...grid.cuts[axis], size[axis]];
            return b;
        };
        const bx = bounds("x"), by = bounds("y"), bz = bounds("z");
        for (let li = 0; li < grid.counts.y; li++) {
            for (let ri = 0; ri < grid.counts.z; ri++) {
                for (let ci = 0; ci < grid.counts.x; ci++) {
                    yield {
                        ci, ri, li,
                        id: partId(ci, ri, li, grid.counts.y),
                        x0: min.x + bx[ci], x1: min.x + bx[ci + 1],
                        y0: min.y + by[li], y1: min.y + by[li + 1],
                        z0: min.z + bz[ri], z1: min.z + bz[ri + 1],
                        in: {
                            x0: ci > 0, x1: ci < grid.counts.x - 1,
                            y0: li > 0, y1: li < grid.counts.y - 1,
                            z0: ri > 0, z1: ri < grid.counts.z - 1,
                        },
                    };
                }
            }
        }
    }

    /* Canonical seam descriptor for one interior face of a cell. Both
       neighbors of a seam produce IDENTICAL descriptors (the plane and the
       u/v ranges come from the shared global grid), which is what lets each
       side compute the same connector placements with no bookkeeping.
       axis: "x"|"y"|"z", dir: +1 (the cell's high face) or -1 (low face). */
    function seamOf(cell, axis, dir) {
        const plane = dir > 0 ? cell[axis + "1"] : cell[axis + "0"];
        const [uAxis, vAxis] = axis === "x" ? ["y", "z"]
            : axis === "y" ? ["x", "z"] : ["x", "y"];
        return {
            axis, plane,
            u: { axis: uAxis, lo: cell[uAxis + "0"], hi: cell[uAxis + "1"] },
            v: { axis: vAxis, lo: cell[vAxis + "0"], hi: cell[vAxis + "1"] },
        };
    }

    /* Candidate connector spots on a seam: a centered grid, `spacing` mm
       apart, kept `inset` mm off the seam rectangle's edges. Count grows
       with the face area; a seam too small for the inset gets no candidates.
       Returns [{u, v}] in seam-plane coordinates, deterministic order. */
    function seamGridPositions(seam, spacing, inset) {
        const line = (lo, hi) => {
            const mid = (lo + hi) / 2;
            const half = (hi - lo) / 2 - inset;
            if (half < 0) return [];
            const steps = Math.floor(half / spacing);
            const out = [];
            for (let i = -steps; i <= steps; i++) out.push(mid + i * spacing);
            return out;
        };
        const us = line(seam.u.lo, seam.u.hi);
        const vs = line(seam.v.lo, seam.v.hi);
        const pts = [];
        for (const u of us) for (const v of vs) pts.push({ u, v });
        return pts;
    }

    /* Every interior cut plane of the grid as { axis, plane }. Same arithmetic
       as gridCells (min + cut offset), so the doubles match its cell faces. */
    function seamPlanes(grid, min) {
        const out = [];
        for (const axis of ["x", "y", "z"]) {
            for (const t of grid.cuts[axis]) out.push({ axis, plane: min[axis] + t });
        }
        return out;
    }

    /* Indexed BufferGeometry -> binary STL bytes, rotated back to printer
       Z-up (the scene is Y-up): (x, y, z) -> (x, -z, y), matching the
       pieces-panel exporter. Duck-typed on getAttribute/getIndex so this
       file stays THREE-free and headless-testable. */
    function serializeSTL(geometry) {
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const triCount = (index ? index.count : pos.count) / 3;
        const at = index ? (i) => index.getX(i) : (i) => i;

        const buf = new ArrayBuffer(84 + triCount * 50);
        const dv = new DataView(buf);
        const header = "Curve Cut Big Print (binary STL)";
        for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i));
        dv.setUint32(80, triCount, true);

        let o = 84;
        const v = new Float64Array(9); // one triangle, Z-up
        for (let t = 0; t < triCount * 3; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = at(t + k);
                v[k * 3] = pos.getX(i);
                v[k * 3 + 1] = -pos.getZ(i);
                v[k * 3 + 2] = pos.getY(i);
            }
            const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
            const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
            let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
            const len = Math.hypot(nx, ny, nz) || 1;
            dv.setFloat32(o, nx / len, true);
            dv.setFloat32(o + 4, ny / len, true);
            dv.setFloat32(o + 8, nz / len, true);
            o += 12;
            for (let k = 0; k < 9; k++) { dv.setFloat32(o, v[k], true); o += 4; }
            dv.setUint16(o, 0, true); o += 2;
        }
        return new Uint8Array(buf);
    }

    /* Indexed BufferGeometry -> 3MF bytes (a zip; needs the global fflate).
       Way lighter than STL: vertices stay shared and the XML deflates well.
       Same Z-up mapping as serializeSTL: (x, y, z) -> (x, -z, y). µm-rounded
       coordinates keep the XML small without losing print precision. */
    function serialize3MF(geometry) {
        const pos = geometry.getAttribute("position");
        const index = geometry.getIndex();
        const N = (v) => String(Math.round(v * 1000) / 1000);

        let verts = "";
        for (let i = 0; i < pos.count; i++) {
            verts += `<vertex x="${N(pos.getX(i))}" y="${N(-pos.getZ(i))}" z="${N(pos.getY(i))}"/>`;
        }
        let tris = "";
        const count = index ? index.count : pos.count;
        const at = index ? (i) => index.getX(i) : (i) => i;
        for (let i = 0; i < count; i += 3) {
            tris += `<triangle v1="${at(i)}" v2="${at(i + 1)}" v3="${at(i + 2)}"/>`;
        }

        const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources><object id="1" type="model"><mesh>
  <vertices>${verts}</vertices>
  <triangles>${tris}</triangles>
 </mesh></object></resources>
 <build><item objectid="1"/></build>
</model>`;
        const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;
        const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

        const enc = new TextEncoder();
        return window.fflate.zipSync({
            "[Content_Types].xml": enc.encode(contentTypes),
            "_rels/.rels": enc.encode(rels),
            "3D/3dmodel.model": enc.encode(modelXml),
        }, { level: 6 });
    }

    /* Human-readable manifest for the export zip. rows = [{ id, file, size?: {w,d,h}, tris,
       engraved, pegs?, sockets?, thinSeams?, onPad?, noPadRoom? }]; settings includes provenance plus the complete export UI
       state (scale, size, bed, printer, margin, nudge, gap, format, IDs and
       connectors). */
    function buildManifest(rows, s) {
        const L = [];
        const nudge = s.nudge || { x: 0, y: 0, z: 0 };
        const fmtMm = (v) => String(+(+v).toFixed(2));
        L.push(`Curve Cut — Big Print manifest`);
        L.push(`Provenance:`);
        L.push(`  Application: Curve Cut`);
        L.push(`  Version: ${s.version || "unknown"}`);
        L.push(`  Export date: ${s.exportDate || "unknown"}`);
        L.push(`  Original model filename: ${s.name}`);
        L.push(`  Settings:`);
        L.push(`    Scale: ×${s.scale}`);
        L.push(`    Final size (W×D×H): ${s.size.x.toFixed(0)} × ${s.size.z.toFixed(0)} × ${s.size.y.toFixed(0)} mm`);
        L.push(`    Printer: ${s.printer}`);
        L.push(`    Bed (W×D×H): ${s.bed.w} × ${s.bed.d} × ${s.bed.h} mm`);
        L.push(`    Margin: ${s.margin} mm`);
        L.push(`    Nudge (W×D×H): ${fmtMm(nudge.x)} × ${fmtMm(nudge.z)} × ${fmtMm(nudge.y)} mm`);
        L.push(`    Assembly gap: ${s.gap} mm`);
        L.push(`    Format: ${s.format || "not recorded"}`);
        L.push(`    Connectors: ${s.connectors}`);
        L.push(`    Engrave IDs: ${s.engraveIds === undefined ? "not recorded" : (s.engraveIds ? "on" : "off")}`);
        if (s.seams !== undefined) {
            const thin = s.seams - (s.seamsWithPegs || 0);
            L.push(`    Connector seams: ${s.seamsWithPegs || 0} of ${s.seams} got connectors`
                + (thin > 0 ? ` (${thin} too thin — see the connectors column)` : ""));
        }
        if (s.hollow && s.blocks && (s.connectors !== "off" || s.engraveIds)) {
            L.push(`    Hollow parts: connectors and ID labels sit on small solid blocks added inside the shell.`);
        }
        L.push(`    Candidate cells: ${s.candidateCount === undefined ? rows.length : s.candidateCount}`);
        if (s.hollow) {
            const open = s.hollow.openFaces || [];
            const closed = s.hollow.closedFaces || [];
            L.push(`    Hollow:`);
            L.push(`      Wall: ${s.hollow.wallMm} mm`);
            L.push(`      Open faces: ${open.length ? open.join(", ") : "none"}`);
            if (closed.length) L.push(`      Asked to open but left closed: ${closed.join(", ")}`);
            L.push(`      Drilled holes: ${s.hollow.holes || 0}`);
            L.push(`      Material saved: ${s.hollow.savedPct.toFixed(1)}%`);
            L.push(`      Engine: ${s.hollow.engineUsed}`);
            L.push(`      Fallback: ${s.hollow.fellBack ? "yes" : "no"}`);
        } else {
            L.push(`    Hollow: none (solid parts)`);
        }
        L.push(`  Part count: ${rows.length}`);
        L.push("");
        L.push(`Model: ${s.name}`);
        L.push(`Scale: ×${s.scale} → ${s.size.x.toFixed(0)} × ${s.size.z.toFixed(0)} × ${s.size.y.toFixed(0)} mm (W×D×H)`);
        L.push(`Printer: ${s.printer} (bed ${s.bed.w}×${s.bed.d}×${s.bed.h} mm, margin ${s.margin} mm)`);
        L.push(`Assembly gap: ${s.gap} mm · Connectors: ${s.connectors}`);
        L.push(`Parts: ${rows.length} (grid IDs: columns = letters, rows = numbers, -L2.. = higher layers)`);
        L.push(`Print each part file listed below; assemble layer by layer using assembly-map.png.`);
        L.push("");
        const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
        const rowConn = (r) => r.pegs === undefined ? "-"
            : `${plural(r.pegs, "peg")}, ${plural(r.sockets || 0, "socket")}`
                + (r.thinSeams ? `, ${plural(r.thinSeams, "seam")} too thin` : "");
        const connW = Math.max(26, ...rows.map((r) => rowConn(r).length + 2));
        const rowSize = (r) => r.size
            ? [r.size.w, r.size.d, r.size.h].map((v) => +(+v).toFixed(3)).join(" x ") : "-";
        const sizeW = Math.max(14, ...rows.map((r) => rowSize(r).length + 2));
        L.push("ID        file                 " + "W x D x H mm".padEnd(sizeW) + "triangles  "
            + "connectors".padEnd(connW) + "engraved ID");
        for (const r of rows) {
            const conn = rowConn(r);
            const id = r.engraved ? (r.onPad ? "yes (on a pad)" : "yes")
                : (r.noPadRoom ? "no (no room for a label pad)" : "no (face too small)");
            L.push(`${r.id.padEnd(10)}${r.file.padEnd(21)}${rowSize(r).padEnd(sizeW)}${String(r.tris).padEnd(11)}${conn.padEnd(connW)}${id}`);
        }
        return L.join("\n");
    }

    /* Assembly map (front view), drawn to scale: one panel per depth row, front
       row first, each panel as wide and tall as the model in px (one px-per-mm
       factor for the whole map), split into columns and layers at the real cut
       positions, layer 1 at the bottom. Pure geometry, no DOM: the caller
       passes `measure(text)` → px width (ctx.measureText). colMm / layerMm are
       the mm extents of each column (left→right) and layer (bottom-up). */
    const MAP_MAX_PANEL_W = 600, MAP_MAX_PANEL_H = 1000, MAP_MAX_H = 4096, MAP_MIN_CELL = 22,
        MAP_HARD_SIDE = 8192, MAP_MAX_AREA = 32e6;

    function assemblyPanelTitle(row, rows) {
        if (rows === 1) return "Front view";
        return row === rows ? `Row ${row} — front` : row === 1 ? "Row 1 — back" : `Row ${row}`;
    }

    /* px per mm: widest panel ≤ 600 px, tallest ≤ 1000 px, canvas ≤ 4096 px tall,
       but the smallest cell side is never under 22 px (then the canvas grows).
       Hard ceiling over all of that: canvas side ≤ 8192 px, area ≤ 32e6 px. */
    function assemblyScale(colMm, layerMm, rows, footerCount, { pad = 34, header = 26, gapPx = 18, lineH = 18 } = {}) {
        const sum = (a) => a.reduce((t, v) => t + v, 0);
        const fixed = pad / 2 + rows * (header + gapPx) + footerCount * lineH + pad;
        const sx = sum(colMm), sy = rows * sum(layerMm);
        const s = Math.min(MAP_MAX_PANEL_W / sx, MAP_MAX_PANEL_H / sum(layerMm), (MAP_MAX_H - fixed) / sy);
        const grown = Math.max(s, MAP_MIN_CELL / Math.min(...colMm, ...layerMm));
        // area: (sx·s + 2·pad)(sy·s + fixed) ≤ 32e6, solved for s
        const a = sx * sy, b = sx * fixed + 2 * pad * sy, c = 2 * pad * fixed - MAP_MAX_AREA;
        const byArea = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
        return Math.min(grown, (MAP_HARD_SIDE - 2 * pad) / sx, (MAP_HARD_SIDE - fixed) / sy, 0.999 * byArea);
    }

    /* ID label size for one cell: 28% of the short side, at most 28 px, then
       shrunk so the text fits 85% of the cell width; never under 10 px.
       widthAt(px) → text width at that font size. */
    function assemblyLabelPx(w, h, widthAt) {
        const px = Math.max(10, Math.min(Math.min(w, h) * 0.28, 28));
        const tw = widthAt(px);
        return tw > w * 0.85 ? Math.max(10, px * (w * 0.85) / tw) : px;
    }

    function assemblyMapLayout({ colMm, layerMm, rows, pxPerMm, footerLines, measure, measureTitle = measure,
            pad = 34, header = 26, gapPx = 18, lineH = 18 }) {
        // rounded cumulative edges, so cells tile the panel exactly
        const edges = (mm) => {
            const e = [0]; let t = 0;
            for (const v of mm) { t += v; e.push(Math.round(t * pxPerMm)); }
            return e;
        };
        const ex = edges(colMm), ey = edges(layerMm);
        const panelW = ex[ex.length - 1], panelH = ey[ey.length - 1];
        let inner = panelW;
        for (const t of footerLines) inner = Math.max(inner, measure(t));
        for (let r = 1; r <= rows; r++) inner = Math.max(inner, measureTitle(assemblyPanelTitle(r, rows)));
        const panels = [];
        let y = pad / 2;
        for (let row = rows; row >= 1; row--) { // rows number back→front, so the front row is the highest
            panels.push({ row, x: pad, y: y + header, w: panelW, h: panelH, ex, ey });
            y += header + panelH + gapPx;
        }
        return { width: Math.ceil(inner) + 2 * pad, height: Math.ceil(y + footerLines.length * lineH + pad),
            panels, footerY: y };
    }

    /* Rect of one cell inside a panel: layer 0 sits at the panel's bottom. */
    function assemblyCellRect(panel, col, layer) {
        const { ex, ey } = panel;
        return { x: panel.x + ex[col], y: panel.y + panel.h - ey[layer + 1],
            w: ex[col + 1] - ex[col], h: ey[layer + 1] - ey[layer] };
    }

    /* Exploded-view placement: parts drift away from the model's center by
       `amount` (0 = assembled, 1 = spread out one full model-radius-ish). */
    function explodedPosition(center, origin, amount) {
        return {
            x: (center.x - origin.x) * amount * 1.2,
            y: (center.y - origin.y) * amount * 1.2,
            z: (center.z - origin.z) * amount * 1.2,
        };
    }

    /* Exploded-view stand-ins: every part gets the same triangle target, the
       budget split evenly across the candidate cells but never below `floor`. */
    function proxyTargetFor(totalCells, budget, floor) {
        const cells = Math.max(totalCells | 0, 1);
        return Math.max(floor, Math.floor(budget / cells));
    }

    /* The note under the exploded-view slider: says honestly when the view is
       cut short or simplified. */
    function explodeNoteText(count, truncated, simplified) {
        const base = truncated ? `showing the first ${count} parts (memory budget)` : `${count} parts`;
        return simplified ? `${base} \u00b7 simplified preview \u2014 exported files are full detail` : base;
    }

    /* Target size (longest side, mm) ⇄ multiplier, linked live in the UI. */
    const scaleForTarget = (baseLongest, targetMm) =>
        baseLongest > 0 ? targetMm / baseLongest : 1;
    const targetForScale = (baseLongest, k) => baseLongest * k;

    function bakedScaleLabel(k) {
        if (!Number.isFinite(k) || Math.abs(k - 1) <= 1e-9) return null;
        const value = k.toFixed(9).replace(/\.?0+$/, "");
        return `${value}× of imported`;
    }

    function partStory(count, hollowed) {
        const onePiece = count === 1;
        return {
            statusSuffix: onePiece
                ? " — fits the bed in one piece, no cuts needed"
                    + (hollowed
                        ? " (the cavity stays sealed — pick a smaller bed or bigger scale for open shells)"
                        : "")
                : "",
            exportLabel: onePiece
                ? (hollowed ? "1 sealed hollow part" : "1 part")
                : `${count} parts`,
        };
    }

    return { PRINTERS, axisCuts, nudgeWindow, MIN_WALL_GAP_MM, cellLimit, gridFromWalls, checkWalls,
        resolveLayout, computeGrid, cellCount, gridCells, seamOf, seamGridPositions, seamPlanes,
        serializeSTL, serialize3MF, buildManifest, assemblyMapLayout, assemblyCellRect, assemblyScale, assemblyLabelPx,
        assemblyPanelTitle, explodedPosition, proxyTargetFor, explodeNoteText,
        colLetter, partId, scaleForTarget, targetForScale, bakedScaleLabel,
        partStory };
})();
