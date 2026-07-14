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
        let phase = (usable - slack / 2 + nudge) % usable;
        if (phase <= 0) phase += usable;
        const cuts = [];
        for (let t = phase; t < size - 1e-9; t += usable) cuts.push(t);
        return cuts;
    }

    /* Full grid for a scaled model: sizes in mm (scene axes), bed in printer
       coordinates, margin off every bed dimension, per-axis nudges. */
    function computeGrid({ size, bed, margin = 5, nudge = { x: 0, y: 0, z: 0 } }) {
        const usable = {
            x: bed.w - 2 * margin,
            z: bed.d - 2 * margin,
            y: bed.h - 2 * margin,
        };
        if (usable.x <= 0 || usable.y <= 0 || usable.z <= 0) return null;
        const cuts = {
            x: axisCuts(size.x, usable.x, nudge.x || 0),
            y: axisCuts(size.y, usable.y, nudge.y || 0),
            z: axisCuts(size.z, usable.z, nudge.z || 0),
        };
        const counts = { x: cuts.x.length + 1, y: cuts.y.length + 1, z: cuts.z.length + 1 };
        return { usable, cuts, counts, total: counts.x * counts.y * counts.z };
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

    /* Enumerate every grid cell in assembly order (layer → row → column),
       each with world bounds and interior-face flags for the kerf insets and
       (step 4) seam connectors. `min` = the scaled model's bbox minimum.
       Cells are candidates — the cutter skips the ones the model never enters. */
    function gridCells(grid, size, min) {
        const bounds = (axis) => {
            const b = [0, ...grid.cuts[axis], size[axis]];
            return b;
        };
        const bx = bounds("x"), by = bounds("y"), bz = bounds("z");
        const cells = [];
        for (let li = 0; li < grid.counts.y; li++) {
            for (let ri = 0; ri < grid.counts.z; ri++) {
                for (let ci = 0; ci < grid.counts.x; ci++) {
                    cells.push({
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
                    });
                }
            }
        }
        return cells;
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

    /* Human-readable manifest for the export zip. rows = [{ id, file, tris,
       engraved }], settings = { name, scale, size, bed, printer, margin, gap,
       connectors }. */
    function buildManifest(rows, s) {
        const L = [];
        L.push(`Curve Cut — Big Print manifest`);
        L.push(`Model: ${s.name}`);
        L.push(`Scale: ×${s.scale} → ${s.size.x.toFixed(0)} × ${s.size.z.toFixed(0)} × ${s.size.y.toFixed(0)} mm (W×D×H)`);
        L.push(`Printer: ${s.printer} (bed ${s.bed.w}×${s.bed.d}×${s.bed.h} mm, margin ${s.margin} mm)`);
        L.push(`Assembly gap: ${s.gap} mm · Connectors: ${s.connectors}`);
        L.push(`Parts: ${rows.length} (grid IDs: columns = letters, rows = numbers, -L2.. = higher layers)`);
        L.push(`Print each Part_<ID>.stl; assemble layer by layer using assembly-map.png.`);
        L.push("");
        L.push("ID        file                 triangles  engraved ID");
        for (const r of rows) {
            L.push(`${r.id.padEnd(10)}${r.file.padEnd(21)}${String(r.tris).padEnd(11)}${r.engraved ? "yes" : "no (face too small)"}`);
        }
        return L.join("\n");
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

    /* Target size (longest side, mm) ⇄ multiplier, linked live in the UI. */
    const scaleForTarget = (baseLongest, targetMm) =>
        baseLongest > 0 ? targetMm / baseLongest : 1;
    const targetForScale = (baseLongest, k) => baseLongest * k;

    return { PRINTERS, axisCuts, computeGrid, gridCells, seamOf, seamGridPositions,
        serializeSTL, serialize3MF, buildManifest, explodedPosition,
        colLetter, partId, scaleForTarget, targetForScale };
})();
