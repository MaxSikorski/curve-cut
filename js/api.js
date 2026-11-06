/* Curve Cut — the page API (CC.api), step A1: reading and seeing.
   One function per tool in js/ai-tools.js, all called through
   CC.api.invoke(tool, args), which returns a promise of a JSON-safe value
   (bytes come back as {"$bytes": base64}). Nothing here changes the model.
   Sizes are printer axes in millimetres: x width, y depth, z height. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const Analysis = CC.AnalysisCore;
    const PRINTERS = window.BigPrintCore.PRINTERS;
    const round = Analysis.round;
    const VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"];
    const VIEW_DIRS = {
        front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0],
        top: [0, 1, 0.001], bottom: [0, -1, 0.001], iso: [1, 0.55, 1],
    };
    const DEFAULT_LOOK = ["front", "right", "top", "iso"];

    // ------------------------------------------------------------ helpers

    let nextPid = 1;
    window.addEventListener("curvecut:model-loaded", () => { nextPid = 1; });
    const pidOf = (piece) => piece.userData.pid || (piece.userData.pid = "p" + nextPid++);

    function pieceById(id) {
        const found = CC.pieces.find((p) => pidOf(p) === id);
        if (!found) {
            throw new Error(`No piece "${id}". Pieces now: ${CC.pieces.map(pidOf).join(", ") || "none"}. Call list_pieces.`);
        }
        return found;
    }

    function chosen(id) {
        if (!id || id === "all") return CC.pieces.slice();
        return [pieceById(id)];
    }

    /* A piece's triangles as {positions, index} (welded if it is a soup). */
    function meshOf(piece) {
        const g = piece.geometry;
        if (g.getIndex()) return { positions: g.attributes.position.array, index: g.getIndex().array };
        const w = window.CutCore.weldGeometry(g);
        return { positions: w.vertProperties, index: w.triVerts };
    }

    function mergedMesh(pieces) {
        const parts = pieces.map(meshOf);
        const positions = new Float32Array(parts.reduce((n, m) => n + m.positions.length, 0));
        const index = new Uint32Array(parts.reduce((n, m) => n + m.index.length, 0));
        let pAt = 0, iAt = 0;
        for (const m of parts) {
            const base = pAt / 3;
            positions.set(m.positions, pAt);
            for (let i = 0; i < m.index.length; i++) index[iAt + i] = m.index[i] + base;
            pAt += m.positions.length;
            iAt += m.index.length;
        }
        return { positions, index };
    }

    function sizeOf(piece) {
        const g = piece.geometry;
        g.computeBoundingBox();
        const b = g.boundingBox;
        return [round(b.max.x - b.min.x), round(b.max.z - b.min.z), round(b.max.y - b.min.y)];
    }

    const colorOf = (piece) => "#" + piece.material.color.getHexString();

    function findPrinter(query) {
        const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
        const hits = PRINTERS.filter((p) => {
            const name = `${p.brand} ${p.model}`.toLowerCase();
            return words.every((w) => name.includes(w));
        });
        const exact = hits.filter((p) => `${p.brand} ${p.model}`.toLowerCase() === words.join(" ")
            || p.model.toLowerCase() === words.join(" "));
        const pick = exact.length === 1 ? exact : hits;
        if (pick.length !== 1) {
            throw new Error(pick.length
                ? `"${query}" matches several printers (${pick.map((p) => p.model).join(", ")}). Be more specific.`
                : `No printer preset matches "${query}". Call list_printers, or pass bed_mm.`);
        }
        return pick[0];
    }

    // -------------------------------------------------------------- tools

    function status() {
        const first = CC.pieces[0];
        let mode = null;
        if (CC.bigPrintActive) mode = "bigprint";
        else {
            const active = document.querySelector("#mode-dock .mode-btn.active");
            if (active) mode = active.dataset.mode;
        }
        return {
            api_version: api.version,
            app_version: CC.VERSION,
            where: navigator.webdriver ? "headless" : "tab",
            model: first ? (first.userData.sourceName || first.name) : null,
            pieces: CC.pieces.length,
            busy: CC.ops.busyName(),
            mode,
        };
    }

    function listPieces() {
        return CC.pieces.map((p) => ({
            id: pidOf(p),
            name: p.name,
            visible: p.visible,
            color: colorOf(p),
            size_mm: sizeOf(p),
            volume_cm3: round(window.CutCore.geometryVolume(p.geometry) / 1000),
        }));
    }

    function measure(args) {
        let bed = null, printer = null;
        if (args.printer) {
            const p = findPrinter(args.printer);
            printer = `${p.brand} ${p.model}`;
            bed = [p.w, p.d, p.h];
        } else if (args.bed_mm) bed = args.bed_mm;
        const out = chosen(args.piece).map((p) => {
            const m = Analysis.measure(meshOf(p));
            return {
                id: pidOf(p),
                name: p.name,
                size_mm: m.size_mm,
                volume_cm3: round(m.volume_mm3 / 1000),
                surface_area_mm2: round(m.surface_area_mm2, 1),
                triangles: m.triangles,
                watertight: m.watertight,
                shells: m.shells,
                open_edges: m.open_edges,
                overhang: m.overhang,
                best_orientation: m.best_orientation,
                fits_bed: bed ? m.size_mm.every((v, i) => v <= bed[i] + 0.01) : null,
            };
        });
        return { printer, bed_mm: bed, pieces: out };
    }

    function sectionProfile(args) {
        const visible = CC.pieces.filter((p) => p.visible);
        if (!visible.length) throw new Error("No visible pieces to slice. Load a model first.");
        const samples = args.samples || 40;
        return { axis: args.axis, slices: Analysis.sectionProfile(mergedMesh(visible), args.axis, samples) };
    }

    function diagnoseMesh(args) {
        return {
            pieces: chosen(args.piece).map((p) => {
                let loops = 0;
                try { loops = window.CutCore.findBoundaryLoops(p.geometry).loops.length; } catch (_) { /* counted as 0 */ }
                return Object.assign({ id: pidOf(p), name: p.name }, Analysis.diagnose(meshOf(p), loops));
            }),
        };
    }

    function listPrinters() {
        return PRINTERS.map((p) => ({ brand: p.brand, model: p.model, bed_mm: [p.w, p.d, p.h] }));
    }

    function setView(args) {
        if (!CC.pieces.length) throw new Error("No model loaded, so there is nothing to look at.");
        CC.flyToView(args.view);
        return { ok: true, view: args.view };
    }

    function bytesToBase64(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }

    const axisTag = (vec) => {
        // scene vector -> signed printer axis (scene z is printer y, scene y is printer z)
        const parts = [[Math.abs(vec.x), (vec.x < 0 ? "-" : "+") + "x"],
            [Math.abs(vec.z), (vec.z < 0 ? "-" : "+") + "y"],
            [Math.abs(vec.y), (vec.y < 0 ? "-" : "+") + "z"]];
        return parts.sort((a, b) => b[0] - a[0])[0][1];
    };

    function niceLength(maxMm) {
        let best = 1;
        for (const base of [1, 2, 5]) {
            for (let p = -2; p <= 4; p++) {
                const v = base * 10 ** p;
                if (v <= maxMm) best = Math.max(best, v);
            }
        }
        return best;
    }

    /* Draws every view into one canvas through a temporary scene and a render
       target on the app's own renderer: no extra WebGL context to leak and the
       person's camera, scene and panels stay as they were. */
    async function look(args) {
        const visible = CC.pieces.filter((p) => p.visible);
        if (!visible.length) throw new Error("No visible pieces to look at. Load a model first.");
        const views = args.views || DEFAULT_LOOK;
        const size = Math.min(2048, Math.max(64, args.size || 768));
        const cols = views.length <= 1 ? 1 : views.length <= 4 ? 2 : 3;
        const rows = Math.ceil(views.length / cols);
        const tile = Math.floor(size / cols);

        const box = new THREE.Box3();
        for (const p of visible) { p.geometry.computeBoundingBox(); box.union(p.geometry.boundingBox); }
        const center = box.getCenter(new THREE.Vector3());
        const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 1e-3);
        const half = radius * 1.2;
        const mmPerPx = (2 * half) / tile;

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0xf2f2f4);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a90, 1.0));
        const key = new THREE.DirectionalLight(0xffffff, 0.7);
        key.position.set(1, 2, 1.5);
        scene.add(key);
        const span = Math.max(10, Math.ceil(Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 2.5 / 10) * 10);
        const grid = new THREE.GridHelper(span, span / 10, 0x9a9aa2, 0xd0d0d6);
        scene.add(grid);
        const materials = [];
        for (const p of visible) {
            const material = new THREE.MeshStandardMaterial({
                color: p.material.color.getHex(), metalness: 0.05, roughness: 0.55, flatShading: true,
            });
            materials.push(material);
            scene.add(new THREE.Mesh(p.geometry, material));
        }

        const renderer = CC.renderer;
        const target = new THREE.WebGLRenderTarget(tile, tile, { samples: 4 });
        const canvas = document.createElement("canvas");
        canvas.width = tile * cols;
        canvas.height = tile * rows;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#f2f2f4";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const pixels = new Uint8Array(tile * tile * 4);
        const image = ctx.createImageData(tile, tile);
        const layout = [];
        const camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, radius * 10);
        try {
            views.forEach((view, i) => {
                const dir = new THREE.Vector3(...VIEW_DIRS[view]).normalize();
                camera.position.copy(center).addScaledVector(dir, radius * 4);
                if (view === "top") camera.up.set(0, 0, -1);
                else if (view === "bottom") camera.up.set(0, 0, 1);
                else camera.up.set(0, 1, 0);
                camera.lookAt(center);
                camera.updateMatrixWorld(true);
                renderer.setRenderTarget(target);
                renderer.render(scene, camera);
                renderer.readRenderTargetPixels(target, 0, 0, tile, tile, pixels);
                for (let y = 0; y < tile; y++) {
                    image.data.set(pixels.subarray((tile - 1 - y) * tile * 4, (tile - y) * tile * 4), y * tile * 4);
                }
                const col = i % cols, row = Math.floor(i / cols);
                const ox = col * tile, oy = row * tile;
                ctx.putImageData(image, ox, oy);
                ctx.strokeStyle = "#b8b8c0";
                ctx.strokeRect(ox + 0.5, oy + 0.5, tile - 1, tile - 1);

                const right = axisTag(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0));
                const up = axisTag(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1));
                const fontPx = Math.max(10, Math.round(tile / 28));
                ctx.fillStyle = "#1a1a1c";
                ctx.font = `bold ${fontPx}px sans-serif`;
                ctx.textBaseline = "top";
                ctx.textAlign = "left";
                ctx.fillText(view === "iso" ? "iso" : `${view}   right ${right}, up ${up}`, ox + 6, oy + 6);
                if (view !== "iso") {
                    const mm = niceLength(tile * 0.25 * mmPerPx);
                    const px = mm / mmPerPx;
                    const bx = ox + 8, by = oy + tile - 12;
                    ctx.fillRect(bx, by, px, 3);
                    ctx.fillRect(bx, by - 4, 1.5, 11);
                    ctx.fillRect(bx + px - 1.5, by - 4, 1.5, 11);
                    ctx.textBaseline = "bottom";
                    ctx.fillText(`${mm} mm`, bx, by - 6);
                }
                layout.push({ view, tile: [col, row], right, up });
            });
        } finally {
            renderer.setRenderTarget(null);
            target.dispose();
            materials.forEach((m) => m.dispose());
            grid.geometry.dispose();
            grid.material.dispose();
        }
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) throw new Error("Could not encode the picture.");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {
            png: { "$bytes": bytesToBase64(bytes) },
            mime: "image/png",
            width: canvas.width,
            height: canvas.height,
            views: layout,
            scale: round(mmPerPx, 4) + " mm per pixel in every non-iso tile",
            legend: visible.map((p) => ({ id: pidOf(p), name: p.name, color: colorOf(p) })),
            preview_included: false,
        };
    }

    // ---------------------------------------------- argument checking

    function check(schema, value, path) {
        const bad = (why) => { throw new Error(`${path}: ${why}`); };
        if (schema.type === "object") {
            if (value === null || typeof value !== "object" || Array.isArray(value)) bad("must be an object");
            for (const name of schema.required || []) {
                if (value[name] === undefined) bad(`"${name}" is required`);
            }
            for (const name of Object.keys(value)) {
                if (!schema.properties[name]) bad(`unknown argument "${name}" (allowed: ${Object.keys(schema.properties).join(", ") || "none"})`);
                check(schema.properties[name], value[name], `${path}.${name}`);
            }
        } else if (schema.type === "array") {
            if (!Array.isArray(value)) bad("must be a list");
            if (schema.minItems && value.length < schema.minItems) bad(`needs at least ${schema.minItems} items`);
            if (schema.maxItems && value.length > schema.maxItems) bad(`takes at most ${schema.maxItems} items`);
            value.forEach((v, i) => check(schema.items, v, `${path}[${i}]`));
        } else if (schema.type === "string") {
            if (typeof value !== "string") bad("must be text");
            if (schema.enum && !schema.enum.includes(value)) bad(`must be one of ${schema.enum.join(", ")}`);
        } else if (schema.type === "integer" || schema.type === "number") {
            if (typeof value !== "number" || !Number.isFinite(value)) bad("must be a number");
            if (schema.type === "integer" && !Number.isInteger(value)) bad("must be a whole number");
            if (schema.minimum !== undefined && value < schema.minimum) bad(`must be at least ${schema.minimum}`);
            if (schema.maximum !== undefined && value > schema.maximum) bad(`must be at most ${schema.maximum}`);
            if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) bad(`must be above ${schema.exclusiveMinimum}`);
        } else if (schema.type === "boolean" && typeof value !== "boolean") bad("must be true or false");
    }

    // ---------------------------------------------------------------- api

    const handlers = {
        status, list_pieces: listPieces, measure, section_profile: sectionProfile,
        diagnose_mesh: diagnoseMesh, look, set_view: setView, list_printers: listPrinters,
    };
    const tools = window.CurveCutTools.tools;
    let queue = Promise.resolve();

    const api = {
        version: window.CurveCutTools.version,
        tools,
        /* One call at a time, whoever sends it. */
        invoke(tool, args = {}) {
            const def = tools.find((t) => t.name === tool);
            if (!def || !handlers[tool]) {
                return Promise.reject(new Error(`Unknown tool "${tool}". Tools: ${tools.map((t) => t.name).join(", ")}.`));
            }
            const run = queue.then(() => {
                check(def.parameters, args, tool);
                return handlers[tool](args);
            });
            queue = run.catch(() => {});
            return run;
        },
    };
    CC.api = api;
})();
