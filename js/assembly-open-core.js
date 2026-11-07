/* Reads assembly data without executing the exported page. */
(function () {
    "use strict";

    const LIMITS = Object.freeze({
        HEAD_BYTES: 65536, HTML_MAX_BYTES: 12000000, ZIP_TAIL_BYTES: 65557,
        ZIP_DIR_MAX_BYTES: 8000000, MESH_MAX_BYTES: 64000000, PARTS_MAX: 20000,
        TRIS_MAX: 2000000, VERTS_MAX: 1000000, INFLATE_CHUNK: 4096,
        INFLATE_OVERSHOOT: 4300000
    });
    const messages = {
        "not-assembly": "That isn't a curve cut assembly file. Choose the assembly.html from a Big Print zip, or the zip itself.",
        "zip-no-assembly": "This zip has no assembly.html. If the export was split into several zips, try the last one or the one before it. Exports made before the 3D view existed don't have one.",
        "zip-unsupported": "This zip can't be read here (unusual compression or encryption). Unzip it and open assembly.html instead.",
        "too-big": "This file is too big to be a 3D assembly view (over 12 MB).",
        "damaged": "This assembly file is damaged or incomplete. Export it again from Big Print.",
        "newer": "This assembly file was made by a newer curve cut. Reload the app to update, then try again.",
        "read-failed": "The file couldn't be read. Try choosing it again."
    };
    class OpenError extends Error {
        constructor(code) { super(messageFor(code)); this.name = "OpenError"; this.code = code; }
    }
    function messageFor(code) {
        return Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : messages.damaged;
    }
    function fail(code) { throw new OpenError(code); }
    const pad4 = n => Math.ceil(n / 4) * 4;
    const finite = n => typeof n === "number" && Number.isFinite(n);
    const vec = v => Array.isArray(v) && v.length === 3 && v.every(finite);
    const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const nonneg = n => Number.isInteger(n) && n >= 0;

    function validate(data) {
        if (!obj(data) || typeof data.name !== "string" || !obj(data.size) ||
            ![data.size.x, data.size.y, data.size.z].every(n => finite(n) && n > 0) ||
            !finite(data.scale) || !obj(data.grid) || !obj(data.grid.counts)) fail("damaged");
        const counts = data.grid.counts;
        if (![counts.x, counts.y, counts.z].every(n => Number.isInteger(n) && n >= 1) ||
            (data.origin !== undefined && (!obj(data.origin) || ![data.origin.x, data.origin.y, data.origin.z].every(finite))) ||
            (data.detail !== undefined && !obj(data.detail)) || !Array.isArray(data.parts) ||
            data.parts.length < 1 || data.parts.length > LIMITS.PARTS_MAX) fail("damaged");
        const ids = new Set(), records = [];
        let tris = 0, expected = 0;
        for (const p of data.parts) {
            if (!obj(p) || typeof p.id !== "string" || !p.id.length || p.id.length > 24 || ids.has(p.id) ||
                typeof p.file !== "string" || !obj(p.cell) ||
                !nonneg(p.cell.ci) || !nonneg(p.cell.ri) || !nonneg(p.cell.li) ||
                p.cell.ci >= counts.x || p.cell.ri >= counts.z || p.cell.li >= counts.y ||
                !obj(p.box) || !vec(p.box.min) || !vec(p.box.max) || !vec(p.center) ||
                !Array.isArray(p.neighbours) || !p.neighbours.every(n => typeof n === "string")) fail("damaged");
            ids.add(p.id);
            if (p.mesh === null) continue;
            const m = p.mesh;
            if (!obj(m) || !nonneg(m.offset) || m.offset % 4 || !nonneg(m.verts) ||
                m.verts > LIMITS.VERTS_MAX || !nonneg(m.tris) || (m.tris > 0 && !m.verts) ||
                typeof m.wide !== "boolean" || (!m.wide && m.verts > 65535) ||
                !vec(m.qmin) || !vec(m.step) || m.step.some(n => n < 0)) fail("damaged");
            tris += m.tris;
            if (tris > LIMITS.TRIS_MAX) fail("damaged");
            const end = m.offset + pad4(m.verts * 6) + pad4(m.tris * 3 * (m.wide ? 4 : 2));
            if (!Number.isFinite(end)) fail("too-big");
            if (end > LIMITS.MESH_MAX_BYTES) fail("too-big");
            records.push({ start: m.offset, end });
            expected = Math.max(expected, end);
        }
        records.sort((a, b) => a.start - b.start);
        let end = 0;
        for (const r of records) { if (r.start < end) fail("damaged"); end = r.end; }
        return expected;
    }

    function inflateBounded(bytes, limit, onProgress) {
        if (limit > LIMITS.MESH_MAX_BYTES) fail("too-big");
        if (!bytes.length) fail("damaged");
        const chunks = [];
        let total = 0;
        try {
            const inf = new fflate.Inflate();
            inf.ondata = chunk => { chunks.push(chunk); total += chunk.length; };
            for (let i = 0; i < bytes.length; i += LIMITS.INFLATE_CHUNK) {
                inf.push(bytes.subarray(i, i + LIMITS.INFLATE_CHUNK), i + LIMITS.INFLATE_CHUNK >= bytes.length);
                if (onProgress) onProgress(total);
                if (total > limit) { chunks.length = 0; fail("damaged"); }
            }
        } catch (e) { if (e instanceof OpenError) throw e; fail("damaged"); }
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result;
    }

    // Finds the opening <script ... id="..."> tag by plain scanning: each candidate is tested on its own
    // short slice, so a hostile file of thousands of unclosed "<script" cannot make a regex backtrack.
    function findTag(text, id) {
        const idRe = new RegExp("\\bid\\s*=\\s*[\"']?" + id + "[\"']?(?![\\w-])", "i");
        let pos = 0, gt = -1;
        while ((pos = text.indexOf("<script", pos)) !== -1) {
            if (gt < pos) gt = text.indexOf(">", pos); // reuse the last ">" so a long run of tags is scanned once
            if (gt === -1) return null;
            const after = text.charAt(pos + 7);
            if (/[\s>/]/.test(after) && idRe.test(text.slice(pos + 7, gt))) return { end: gt + 1 };
            pos += 7;
        }
        return null;
    }

    function parseHtml(text) {
        function block(id) {
            const tag = findTag(text, id);
            if (!tag) return null;
            const start = tag.end;
            const close = /<\/script/i.exec(text.slice(start));
            return { text: close ? text.slice(start, start + close.index) : null };
        }
        const d = block("ccav-data"), m = block("ccav-mesh");
        if (!d && !m) fail("not-assembly");
        if (!d || !m || d.text === null || m.text === null) fail("damaged");
        let data;
        try { data = JSON.parse(d.text); } catch (_) { fail("damaged"); }
        if (!obj(data) || data.kind !== "curve-cut-assembly") fail("not-assembly");
        if (!Number.isInteger(data.format) || data.format < 1) fail("damaged");
        if (data.format > 1) fail("newer");
        const expected = validate(data);
        let packed;
        try {
            const binary = atob(m.text.replace(/\s/g, ""));
            packed = Uint8Array.from(binary, c => c.charCodeAt(0));
        } catch (_) { fail("damaged"); }
        if (!packed.length) fail("damaged");
        const bytes = inflateBounded(packed, expected);
        if (bytes.length !== expected) fail("damaged");
        for (const part of data.parts) {
            const mesh = part.mesh;
            if (!mesh) continue;
            const start = mesh.offset + pad4(mesh.verts * 6);
            const copied = bytes.slice(start, start + mesh.tris * 3 * (mesh.wide ? 4 : 2));
            const indices = mesh.wide ? new Uint32Array(copied.buffer) : new Uint16Array(copied.buffer);
            for (const index of indices) if (index >= mesh.verts) fail("damaged");
        }
        return { data, bytes };
    }

    async function readAssembly(blob) {
        try {
            const read = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
            const decoder = new TextDecoder("utf-8", { fatal: false });
            const first = await read(0, 4);
            const zip = first.length === 4 && first[0] === 0x50 && first[1] === 0x4b &&
                ((first[2] === 3 && first[3] === 4) || (first[2] === 5 && first[3] === 6));
            if (!zip) {
                const head = decoder.decode(await read(0, LIMITS.HEAD_BYTES));
                if (!findTag(head, "ccav-data")) fail("not-assembly");
                if (blob.size > LIMITS.HTML_MAX_BYTES) fail("too-big");
                return parseHtml(decoder.decode(await read(0, blob.size)));
            }
            const tailStart = Math.max(0, blob.size - LIMITS.ZIP_TAIL_BYTES);
            const tail = await read(tailStart, blob.size);
            const tv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
            let eocd = -1;
            for (let i = tail.length - 22; i >= 0; i--) {
                if (tv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
            }
            if (eocd < 0) fail("damaged");
            const count = tv.getUint16(eocd + 10, true), dirSize = tv.getUint32(eocd + 12, true), dirOffset = tv.getUint32(eocd + 16, true);
            if (tv.getUint16(eocd + 4, true) === 0xffff || tv.getUint16(eocd + 6, true) === 0xffff ||
                count === 0xffff || tv.getUint16(eocd + 8, true) === 0xffff ||
                dirSize === 0xffffffff || dirOffset === 0xffffffff) fail("zip-unsupported");
            if (dirSize > LIMITS.ZIP_DIR_MAX_BYTES || dirOffset + dirSize > blob.size) fail("damaged");
            const dir = await read(dirOffset, dirOffset + dirSize);
            if (dir.length !== dirSize) fail("damaged");
            const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
            let pos = 0, chosen = null;
            for (let i = 0; i < count; i++) {
                if (pos + 46 > dir.length || dv.getUint32(pos, true) !== 0x02014b50) fail("damaged");
                const nameLen = dv.getUint16(pos + 28, true), extraLen = dv.getUint16(pos + 30, true), commentLen = dv.getUint16(pos + 32, true);
                const next = pos + 46 + nameLen + extraLen + commentLen;
                if (next > dir.length) fail("damaged");
                const name = decoder.decode(dir.subarray(pos + 46, pos + 46 + nameLen));
                if (/^(?:.*\/)?assembly\.html$/i.test(name) && (!chosen || name.length < chosen.name.length)) {
                    chosen = { name, flags: dv.getUint16(pos + 8, true), method: dv.getUint16(pos + 10, true), disk: dv.getUint16(pos + 34, true),
                        compressed: dv.getUint32(pos + 20, true), size: dv.getUint32(pos + 24, true), offset: dv.getUint32(pos + 42, true) };
                }
                pos = next;
            }
            if (!chosen) fail("zip-no-assembly");
            if (chosen.disk === 0xffff || chosen.compressed === 0xffffffff || chosen.size === 0xffffffff || chosen.offset === 0xffffffff ||
                (chosen.flags & 1) || (chosen.method !== 0 && chosen.method !== 8)) fail("zip-unsupported");
            if (chosen.compressed > LIMITS.HTML_MAX_BYTES || chosen.size > LIMITS.HTML_MAX_BYTES) fail("too-big");
            const local = await read(chosen.offset, chosen.offset + 30);
            if (local.length !== 30) fail("damaged");
            const lv = new DataView(local.buffer, local.byteOffset, local.byteLength);
            if (lv.getUint32(0, true) !== 0x04034b50) fail("damaged");
            const start = chosen.offset + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
            if (start + chosen.compressed > blob.size) fail("damaged");
            const compressed = await read(start, start + chosen.compressed);
            if (compressed.length !== chosen.compressed) fail("damaged");
            const html = chosen.method === 0 ? compressed : inflateBounded(compressed, chosen.size);
            if (html.length !== chosen.size) fail("damaged");
            return parseHtml(decoder.decode(html));
        } catch (e) { if (e instanceof OpenError) throw e; fail("read-failed"); }
    }
    window.AssemblyOpenCore = { LIMITS, OpenError, messageFor, validate, inflateBounded, parseHtml, readAssembly };
})();
