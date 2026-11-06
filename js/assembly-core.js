/* Curve Cut — 3D assembly viewer: data, packing and the file text (DOM-free).
   window.AssemblyCore. Used by Big Print at export time, and embedded inside
   assembly.html itself so the file and the tests share one decoder.
   Uses only the THREE and fflate globals plus btoa/atob/TextEncoder, and only
   at call time. This file is inlined into assembly.html, so it must never
   contain the literal text of a script tag or an HTML comment opener: the
   tags are written as split strings. tools/embed_viewer.py fails otherwise. */

(() => {
    "use strict";

    const LIMITS = Object.freeze({
        TOTAL_TRIS: 200000,    // the whole file's triangle budget
        MIN_PART_TRIS: 400,    // never below this per part
        MAX_PART_TRIS: 4000,   // never above this per part
        CAP_BYTES: 6000000,    // decimal 6 MB, as Finder shows it
    });
    const OPEN_TAG = "<" + "script";
    const CLOSE_TAG = "<" + "/script>";
    const COMMENT_OPEN = "<" + "!--";
    const COMMENT_CLOSE = "--" + ">";
    const HALVE_MESSAGE = "Making the 3D assembly view smaller…";
    const FAIL_MESSAGE = "This 3D view couldn't start in this browser. "
        + "The parts and manifest.txt in the zip are complete.";

    const pad4 = (n) => Math.ceil(n / 4) * 4;
    const round3 = (v) => Math.round(v * 1000) / 1000;
    const triCount = (g) => (g.getIndex() ? g.getIndex().count
        : g.getAttribute("position").count) / 3;

    /* Per-part triangle target: what is left of the budget divided by the
       cells still to come (empty cells hand their share on), clamped. */
    function viewerTarget(cellsLeft, budgetLeft, halved = false) {
        const lo = halved ? LIMITS.MIN_PART_TRIS / 2 : LIMITS.MIN_PART_TRIS;
        const hi = halved ? LIMITS.MAX_PART_TRIS / 2 : LIMITS.MAX_PART_TRIS;
        const share = Math.floor(budgetLeft / Math.max(cellsLeft, 1));
        return Math.min(Math.max(share, lo), hi);
    }

    /* Same formula as BigPrintCore.explodedPosition (a test pins them equal). */
    function explodedPosition(center, origin, amount) {
        return {
            x: (center.x - origin.x) * amount * 1.2,
            y: (center.y - origin.y) * amount * 1.2,
            z: (center.z - origin.z) * amount * 1.2,
        };
    }

    /* Two grid parts touch when their cells differ by exactly 1 on exactly one
       axis. Returns Map id -> sorted array of ids. */
    function neighbours(parts) {
        const keyOf = (c) => `${c.ci},${c.ri},${c.li}`;
        const byCell = new Map();
        for (const p of parts) byCell.set(keyOf(p.cell), p);
        const result = new Map();
        const order = (a, b) => a.localeCompare(b, undefined, { numeric: true });
        for (const p of parts) {
            const list = [];
            for (const [dc, dr, dl] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                const other = byCell.get(keyOf({ ci: p.cell.ci + dc, ri: p.cell.ri + dr, li: p.cell.li + dl }));
                if (other) list.push(other.id);
            }
            result.set(p.id, list.sort(order));
        }
        return result;
    }

    /* Quantise a mesh to 3 x Uint16 per vertex inside its own box. The block is
       positions, padding to 4 bytes, then indices (Uint16, or Uint32 past 65,535
       vertices), padded to 4 bytes. Offsets are filled in when blocks are joined. */
    function packMesh(geometry) {
        const pos = geometry.getAttribute("position");
        const verts = pos.count;
        const index = geometry.getIndex();
        const tris = (index ? index.count : verts) / 3;
        const qmin = [Infinity, Infinity, Infinity];
        const qmax = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < verts; i++) {
            const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
            for (let a = 0; a < 3; a++) {
                if (v[a] < qmin[a]) qmin[a] = v[a];
                if (v[a] > qmax[a]) qmax[a] = v[a];
            }
        }
        if (!verts) { qmin.fill(0); qmax.fill(0); }
        const step = qmin.map((lo, a) => (qmax[a] - lo) / 65535);
        const wide = verts > 65535;
        const posBytes = pad4(verts * 6);
        const data = new Uint8Array(posBytes + pad4(tris * 3 * (wide ? 4 : 2)));
        const q = new Uint16Array(data.buffer, 0, verts * 3);
        for (let i = 0; i < verts; i++) {
            const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
            for (let a = 0; a < 3; a++) {
                q[i * 3 + a] = step[a] ? Math.min(65535, Math.max(0, Math.round((v[a] - qmin[a]) / step[a]))) : 0;
            }
        }
        const out = wide ? new Uint32Array(data.buffer, posBytes, tris * 3)
            : new Uint16Array(data.buffer, posBytes, tris * 3);
        for (let i = 0; i < tris * 3; i++) out[i] = index ? index.getX(i) : i;
        return { verts, tris, wide, qmin, step, data };
    }

    /* record: { offset?, verts, tris, wide, qmin, step }; bytes: the joined
       uncompressed block. The viewer calls this same function. */
    function unpackMesh(record, bytes) {
        const offset = record.offset || 0;
        const { verts, tris, wide, qmin, step } = record;
        const qb = bytes.slice(offset, offset + verts * 6);
        const q = new Uint16Array(qb.buffer, 0, verts * 3);
        const position = new Float32Array(verts * 3);
        for (let i = 0; i < verts; i++) {
            for (let a = 0; a < 3; a++) position[i * 3 + a] = qmin[a] + q[i * 3 + a] * step[a];
        }
        const start = offset + pad4(verts * 6);
        const width = wide ? 4 : 2;
        const ib = bytes.slice(start, start + tris * 3 * width);
        const index = wide ? new Uint32Array(ib.buffer, 0, tris * 3)
            : new Uint16Array(ib.buffer, 0, tris * 3);
        return { position, index };
    }

    function geometryFrom(record, bytes) {
        const { position, index } = unpackMesh(record, bytes);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        return geometry;
    }

    function toBase64(bytes) {
        const pieces = [];
        for (let i = 0; i < bytes.length; i += 0x8000) {
            pieces.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
        }
        return btoa(pieces.join(""));
    }

    function escapeHtml(text) {
        return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    const BOOTSTRAP = "(function(){var root=document.getElementById('ccav-root');try{"
        + "var data=JSON.parse(document.getElementById('ccav-data').textContent);"
        + "var bin=atob(document.getElementById('ccav-mesh').textContent.trim());"
        + "var packed=new Uint8Array(bin.length);"
        + "for(var i=0;i<bin.length;i++)packed[i]=bin.charCodeAt(i);"
        + "var bytes=fflate.inflateSync(packed);"
        + "window.assemblyViewer=AssemblyViewer.mount(root,{THREE:THREE,data:data,bytes:bytes});"
        + "}catch(e){console.warn('assembly viewer failed',e);"
        + "root.textContent=" + JSON.stringify(FAIL_MESSAGE) + ";}})();";

    /* The whole file as text. source = { three, orbit, fflate, core, viewer, licences }. */
    function buildHtml(source, data, meshBase64) {
        const json = JSON.stringify(data).replace(/</g, "\\u003c");
        const scripts = ["three", "orbit", "fflate", "core", "viewer"]
            .map((key) => OPEN_TAG + ">" + source[key] + CLOSE_TAG).join("\n");
        return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            + "<title>" + escapeHtml(data.name) + " — assembly</title>\n"
            + COMMENT_OPEN + "\n" + source.licences + "\n" + COMMENT_CLOSE + "\n"
            + "<style>html,body{margin:0;height:100%}#ccav-root{position:fixed;inset:0}</style>"
            + "</head><body><div id=\"ccav-root\"></div>\n"
            + OPEN_TAG + " type=\"application/json\" id=\"ccav-data\">" + json + CLOSE_TAG + "\n"
            + OPEN_TAG + " type=\"text/plain\" id=\"ccav-mesh\">" + meshBase64 + CLOSE_TAG + "\n"
            + scripts + "\n"
            + OPEN_TAG + ">" + BOOTSTRAP + CLOSE_TAG + "\n</body></html>\n";
    }

    function manifestNote(report) {
        const mb = (report.sizeBytes / 1e6).toFixed(1);
        let body;
        if (report.ok) {
            body = "  assembly.html — open it in any browser, no internet needed: spin the model, "
                + "pull the parts apart, tap a part to see its ID.\n"
                + `  ${report.parts} parts, ${mb} MB, simplified shapes`
                + (report.halved ? " (half detail to stay under 6 MB)" : "")
                + " — the part files are full detail.";
        } else if (report.reason === "too-big") {
            body = `  Left out — it came to ${mb} MB even at half detail, over the 6 MB limit. `
                + "The part files are complete.";
        } else {
            body = "  Left out — it couldn't be built in this browser. The part files are complete.";
        }
        return "\n\n3D assembly view:\n" + body;
    }

    /* Collects one packed, simplified mesh per part as the export streams by.
       The caller keeps ownership of every geometry it hands in. */
    function createCollector(options) {
        const simplify = options.simplify;
        let cellsLeft = options.candidates | 0;
        let entries = [];
        let trisTotal = 0;

        function skip() { cellsLeft--; }

        function add(part, source) {
            const target = viewerTarget(cellsLeft, LIMITS.TOTAL_TRIS - trisTotal, false);
            cellsLeft--;
            const n = triCount(source);
            let geo = source;
            let owned = false;
            if (n > target) {
                try {
                    geo = simplify(source, target);
                    owned = true;
                } catch (err) {
                    geo = n <= LIMITS.MAX_PART_TRIS ? source : null;
                }
            }
            let packed = null;
            if (geo) {
                try { packed = packMesh(geo); } finally { if (owned) geo.dispose(); }
            }
            entries.push({
                part: {
                    id: part.id, kind: "grid",
                    cell: { ci: part.cell.ci, ri: part.cell.ri, li: part.cell.li },
                    file: part.file,
                    box: { min: part.box.min.map(round3), max: part.box.max.map(round3) },
                    center: part.center.map(round3),
                    engraved: !!part.engraved,
                    pegs: part.pegs === undefined ? null : part.pegs,
                    sockets: part.sockets === undefined ? null : part.sockets,
                },
                packed,
            });
            if (packed) trisTotal += packed.tris;
        }

        /* One entry at half detail (never below 200). Falls back to the entry as is. */
        function halve(entry) {
            if (!entry.packed) return entry;
            const target = Math.max(200, Math.floor(entry.packed.tris / 2));
            if (entry.packed.tris <= target) return entry;
            let geo = null;
            let slim = null;
            try {
                geo = geometryFrom(entry.packed, entry.packed.data);
                slim = simplify(geo, target);
                return { part: entry.part, packed: packMesh(slim) };
            } catch (err) {
                return entry;
            } finally {
                if (geo) geo.dispose();
                if (slim) slim.dispose();
            }
        }

        function assemble(list, meta, source, halved) {
            const nb = neighbours(list.map((e) => e.part));
            const blocks = [];
            let offset = 0;
            let tris = 0;
            let perPartMax = 0;
            const parts = list.map((e) => {
                let mesh = null;
                if (e.packed) {
                    const m = e.packed;
                    mesh = { offset, verts: m.verts, tris: m.tris, wide: m.wide, qmin: m.qmin, step: m.step };
                    blocks.push(m.data);
                    offset += m.data.length;
                    tris += m.tris;
                    perPartMax = Math.max(perPartMax, m.tris);
                }
                return Object.assign({}, e.part, { mesh, neighbours: nb.get(e.part.id) });
            });
            const joined = new Uint8Array(offset);
            let at = 0;
            for (const block of blocks) { joined.set(block, at); at += block.length; }
            const size = { x: round3(meta.size.x), y: round3(meta.size.y), z: round3(meta.size.z) };
            const walls = {};
            for (const axis of ["x", "y", "z"]) {
                walls[axis] = meta.grid.cuts[axis].map((t) => round3(meta.min[axis] + t));
            }
            const data = {
                kind: "curve-cut-assembly", format: 1,
                name: meta.name, exportDate: meta.exportDate, appVersion: meta.appVersion,
                scale: meta.scale, units: "mm",
                size, origin: { x: 0, y: round3(size.y / 2), z: 0 },
                gap: meta.gap, connectors: meta.connectors,
                grid: { counts: Object.assign({}, meta.grid.counts), walls },
                detail: { trisTotal: tris, perPartMax, halved, simplified: true },
                parts,
            };
            const packedText = toBase64(fflate.deflateSync(joined, { level: 9 }));
            const bytes = new TextEncoder().encode(buildHtml(source, data, packedText));
            return { bytes, sizeBytes: bytes.length, tris, parts: parts.length };
        }

        async function build(opts) {
            const capBytes = opts.capBytes === undefined ? LIMITS.CAP_BYTES : opts.capBytes;
            const stop = opts.shouldStop || (() => false);
            try {
                let result = assemble(entries, opts.meta, opts.source, false);
                if (result.sizeBytes <= capBytes) {
                    return { ok: true, bytes: result.bytes, sizeBytes: result.sizeBytes,
                        parts: result.parts, tris: result.tris, halved: false };
                }
                if (opts.onStage) opts.onStage(HALVE_MESSAGE);
                const smaller = [];
                for (let i = 0; i < entries.length; i++) {
                    if (i % 25 === 0) {
                        await new Promise((r) => setTimeout(r));
                        if (stop()) return { ok: false, reason: "stopped" };
                    }
                    smaller.push(halve(entries[i]));
                }
                result = assemble(smaller, opts.meta, opts.source, true);
                if (result.sizeBytes <= capBytes) {
                    return { ok: true, bytes: result.bytes, sizeBytes: result.sizeBytes,
                        parts: result.parts, tris: result.tris, halved: true };
                }
                return { ok: false, reason: "too-big", sizeBytes: result.sizeBytes,
                    parts: result.parts, tris: result.tris, halved: true };
            } catch (err) {
                console.warn("assembly viewer skipped:", err);
                return { ok: false, reason: "error" };
            }
        }

        return {
            add, skip, build,
            count: () => entries.length,
            tris: () => trisTotal,
            dispose() { entries = []; trisTotal = 0; },
        };
    }

    window.AssemblyCore = {
        LIMITS, viewerTarget, explodedPosition, neighbours,
        packMesh, unpackMesh, geometryFrom, buildHtml, manifestNote, createCollector,
    };
})();
