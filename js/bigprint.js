/* Curve Cut — Big Print mode UI (v2.0)
   Scale panel (printer presets, margin, size ⇄ multiplier), live part
   estimate, translucent grid preview, and the streaming Cut & Export
   pipeline (per-cell cut → connectors → engraving → zip). */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const Core = window.BigPrintCore;

    const panel = document.getElementById("bigprint-panel");
    const actionDock = document.getElementById("action-dock");
    const viewDock = document.getElementById("view-dock");
    const printerSelect = document.getElementById("bp-printer");
    const bedW = document.getElementById("bp-bed-w");
    const bedD = document.getElementById("bp-bed-d");
    const bedH = document.getElementById("bp-bed-h");
    const marginInput = document.getElementById("bp-margin");
    const scaleSlider = document.getElementById("bp-scale-slider");
    const scaleInput = document.getElementById("bp-scale");
    const sizeInput = document.getElementById("bp-size");
    const nudgeX = document.getElementById("bp-nudge-x");
    const nudgeY = document.getElementById("bp-nudge-y");
    const nudgeZ = document.getElementById("bp-nudge-z");
    const status = document.getElementById("bp-status");
    const exportBtn = document.getElementById("bp-export");

    let active = false;
    let model = null;          // the single piece Big Print scales
    let baseSize = null;       // THREE.Vector3, unscaled model dimensions
    let savedCam = null;       // camera pose from before enter()'s fit flight
    let scale = 1;
    let gridGroup = null;      // THREE.Group of preview planes
    let grid = null;           // last computeGrid result

    // ------------------------------------------------------------ presets

    (function fillPresets() {
        const brands = new Map();
        Core.PRINTERS.forEach((p, i) => {
            if (!brands.has(p.brand)) {
                const og = document.createElement("optgroup");
                og.label = p.brand;
                printerSelect.appendChild(og);
                brands.set(p.brand, og);
            }
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = `${p.model} — ${p.w}×${p.d}×${p.h}`;
            brands.get(p.brand).appendChild(opt);
        });
        const custom = document.createElement("option");
        custom.value = "custom";
        custom.textContent = "Custom bed size…";
        printerSelect.appendChild(custom);
    })();

    function applyPreset() {
        const v = printerSelect.value;
        if (v !== "custom") {
            const p = Core.PRINTERS[parseInt(v, 10)];
            bedW.value = p.w; bedD.value = p.d; bedH.value = p.h;
        }
        refresh();
    }

    // Hand-editing the bed switches the dropdown to Custom.
    for (const el of [bedW, bedD, bedH]) {
        el.addEventListener("input", () => { printerSelect.value = "custom"; refresh(); });
    }
    printerSelect.addEventListener("change", applyPreset);

    // ------------------------------------------------------- scale linking

    function setScale(k, from) {
        scale = Math.min(Math.max(k || 1, 0.1), 100);
        if (from !== "scale") scaleInput.value = scale.toFixed(2).replace(/\.?0+$/, "");
        if (from !== "slider") scaleSlider.value = Math.min(scale, parseFloat(scaleSlider.max));
        if (from !== "size") {
            sizeInput.value = Core.targetForScale(longestSide(), scale).toFixed(0);
        }
        refitCamera();
        refresh();
    }

    /* The camera was framed for the 1× model — zoom out as the model grows
       so a 4× scale doesn't swallow the viewpoint. */
    function refitCamera() {
        const center = new THREE.Vector3(0, (baseSize.y * scale) / 2, 0);
        const radius = (baseSize.length() * scale) / 2;
        const dist = radius / Math.tan((CC.camera.fov * Math.PI / 180) / 2) * 1.35;
        CC.camera.far = Math.max(CC.camera.far, dist * 50);
        CC.camera.updateProjectionMatrix();
        const dir = CC.camera.position.clone().sub(CC.controls.target).normalize();
        const dest = center.clone().addScaledVector(dir, dist);
        gsap.to(CC.camera.position, { x: dest.x, y: dest.y, z: dest.z, duration: 0.5, ease: "power2.out" });
        gsap.to(CC.controls.target, { x: center.x, y: center.y, z: center.z, duration: 0.5, ease: "power2.out" });
    }

    const longestSide = () => Math.max(baseSize.x, baseSize.y, baseSize.z);

    scaleSlider.addEventListener("input", () => setScale(parseFloat(scaleSlider.value), "slider"));
    scaleInput.addEventListener("input", () => setScale(parseFloat(scaleInput.value), "scale"));
    sizeInput.addEventListener("input", () =>
        setScale(Core.scaleForTarget(longestSide(), parseFloat(sizeInput.value) || 0), "size"));

    for (const el of [marginInput, nudgeX, nudgeY, nudgeZ]) {
        el.addEventListener("input", refresh);
    }

    // ------------------------------------------------------- grid preview

    function removeGrid() {
        if (!gridGroup) return;
        CC.scene.remove(gridGroup);
        gridGroup.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        gridGroup = null;
    }

    function params() {
        return {
            size: { x: baseSize.x * scale, y: baseSize.y * scale, z: baseSize.z * scale },
            bed: {
                w: parseFloat(bedW.value) || 0,
                d: parseFloat(bedD.value) || 0,
                h: parseFloat(bedH.value) || 0,
            },
            margin: Math.max(parseFloat(marginInput.value) || 0, 0),
            nudge: {
                x: parseFloat(nudgeX.value) || 0,
                y: parseFloat(nudgeY.value) || 0,
                z: parseFloat(nudgeZ.value) || 0,
            },
        };
    }

    function refresh() {
        if (!active || explodeGroup) return; // frozen while exploded
        model.scale.setScalar(scale);
        const p = params();
        grid = Core.computeGrid(p);
        removeGrid();

        if (!grid) {
            status.textContent = "The margin eats the whole bed — shrink one of them.";
            exportBtn.disabled = true;
            return;
        }

        // Scaled model sits centered on X/Z, floor at Y=0 (loadGeometry seats it).
        const min = {
            x: -p.size.x / 2,
            y: 0,
            z: -p.size.z / 2,
        };
        gridGroup = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({
            color: CC.cutFlow.RIBBON_COLOR, transparent: true, opacity: 0.22,
            side: THREE.DoubleSide, depthWrite: false,
        });
        const over = 1.04; // slight overhang so planes read past the silhouette
        const addPlane = (w, h, place) => {
            const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w * over, h * over), mat);
            place(mesh);
            gridGroup.add(mesh);
        };
        for (const t of grid.cuts.x) addPlane(p.size.z, p.size.y, (m) => {
            m.rotation.y = Math.PI / 2;
            m.position.set(min.x + t, p.size.y / 2, 0);
        });
        for (const t of grid.cuts.y) addPlane(p.size.x, p.size.z, (m) => {
            m.rotation.x = -Math.PI / 2;
            m.position.set(0, t, 0);
        });
        for (const t of grid.cuts.z) addPlane(p.size.x, p.size.y, (m) => {
            m.position.set(0, p.size.y / 2, min.z + t);
        });
        CC.scene.add(gridGroup);

        const c = grid.counts;
        status.textContent =
            `Final ${p.size.x.toFixed(0)} × ${p.size.z.toFixed(0)} × ${p.size.y.toFixed(0)} mm` +
            ` · grid ${c.x}×${c.z}×${c.y}` +
            ` · up to ${grid.total} part${grid.total === 1 ? "" : "s"}`;
        exportBtn.disabled = false;

        // Nudge range follows the usable cell size.
        nudgeX.max = grid.usable.x; nudgeX.min = -grid.usable.x;
        nudgeY.max = grid.usable.y; nudgeY.min = -grid.usable.y;
        nudgeZ.max = grid.usable.z; nudgeZ.min = -grid.usable.z;
    }

    // ------------------------------------------------------------ mode flow

    function enter() {
        if (active) return;
        if (!CC.getModel()) return;
        if (CC.pieces.length !== 1) {
            CC.toast("Big Print slices the whole model — use it before other cuts.");
            return;
        }
        active = true;
        CC.bigPrintActive = true;
        savedCam = { pos: CC.camera.position.clone(), target: CC.controls.target.clone() };
        model = CC.pieces[0];
        model.geometry.computeBoundingBox();
        const bb = model.geometry.boundingBox;
        baseSize = new THREE.Vector3();
        bb.getSize(baseSize);

        printerSelect.value = "0";
        applyPreset();
        marginInput.value = 5;
        nudgeX.value = 0; nudgeY.value = 0; nudgeZ.value = 0;
        setScale(1);

        gsap.to([actionDock], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        gsap.fromTo(panel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out" });
        refresh();

        // dowel-ish connector default, proportional to the printable cell
        const u = grid ? Math.min(grid.usable.x, grid.usable.y, grid.usable.z) : 200;
        document.getElementById("bp-conn-size").value =
            Math.round(Math.min(Math.max(u * 0.05, 4), 12));
    }

    function exit() {
        if (!active) return;
        active = false;
        CC.bigPrintActive = false;
        disposeProxies();
        removeGrid();
        model.scale.setScalar(1);
        model = null;
        if (savedCam) { // the scale-to-fit flight shouldn't strand the camera
            gsap.to(CC.camera.position, { x: savedCam.pos.x, y: savedCam.pos.y, z: savedCam.pos.z, duration: 0.5, ease: "power2.out" });
            gsap.to(CC.controls.target, { x: savedCam.target.x, y: savedCam.target.y, z: savedCam.target.z, duration: 0.5, ease: "power2.out" });
            savedCam = null;
        }
        gsap.to(panel, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        gsap.fromTo([viewDock, actionDock], { y: 10 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
    }

    // ------------------------------------------------------- cut & export

    const gapInput = document.getElementById("bp-gap");
    const connBox = document.getElementById("bp-connectors");
    const connShape = document.getElementById("bp-conn-shape");
    const connSize = document.getElementById("bp-conn-size");
    const connTol = document.getElementById("bp-conn-tol");
    const engraveBox = document.getElementById("bp-engrave");
    const cancelBtn = document.getElementById("bp-cancel");

    let running = false;
    let cancelled = false;

    // ------------------------------------------------------- exploded view
    // Real part geometry streams away during export, so the viewer keeps
    // decimated stand-ins (~3k tris each) up to a hard triangle budget —
    // the ≤250 MB heap rule outranks completeness on 1,000-part jobs.

    const explodeBtn = document.getElementById("bp-explode");
    const explodeRow = document.getElementById("bp-explode-row");
    const explodeAmt = document.getElementById("bp-explode-amt");
    const explodeNote = document.getElementById("bp-explode-note");
    const PROXY_TRI_BUDGET = 1500000;
    const PROXY_TARGET = 3000;

    let proxies = [];         // { geometry, center, id, mesh? }
    let proxyTris = 0;
    let proxyTruncated = false;
    let explodeGroup = null;

    function collectProxy(geo, id) {
        if (proxyTruncated) return;
        const tris = geo.getIndex().count / 3;
        let g;
        try {
            g = tris > PROXY_TARGET ? CutCore.simplifyToTarget(geo, PROXY_TARGET) : geo.clone();
        } catch (err) { return; } // display-only — never fail the export over it
        const kept = g.getIndex() ? g.getIndex().count / 3 : 0;
        if (proxyTris + kept > PROXY_TRI_BUDGET) {
            g.dispose();
            proxyTruncated = true;
            return;
        }
        proxyTris += kept;
        g.computeBoundingBox();
        const center = new THREE.Vector3();
        g.boundingBox.getCenter(center);
        proxies.push({ geometry: g, center, id });
    }

    function disposeProxies() {
        exitExplode();
        for (const p of proxies) p.geometry.dispose();
        proxies = [];
        proxyTris = 0;
        proxyTruncated = false;
        explodeBtn.style.display = "none";
    }

    function updateExplode() {
        const k = parseFloat(explodeAmt.value) || 0;
        const origin = new THREE.Vector3(0, (baseSize.y * scale) / 2, 0);
        for (const p of proxies) {
            if (!p.mesh) continue;
            const o = Core.explodedPosition(p.center, origin, k);
            p.mesh.position.set(o.x, o.y, o.z);
        }
    }

    function enterExplode() {
        if (!proxies.length || explodeGroup) return;
        model.visible = false;
        removeGrid();
        explodeGroup = new THREE.Group();
        proxies.forEach((p, i) => {
            // piece-color exception (HANDOFF §4 #10): parts read at a glance
            const mat = CC.baseMaterial.clone();
            mat.color = new THREE.Color().setHSL((i * 0.137) % 1, 0.42, 0.62);
            p.mesh = new THREE.Mesh(p.geometry, mat);
            explodeGroup.add(p.mesh);
        });
        CC.scene.add(explodeGroup);
        updateExplode();
        explodeRow.style.display = "";
        explodeNote.textContent = proxyTruncated
            ? `showing the first ${proxies.length} parts (memory budget)` : `${proxies.length} parts`;
        explodeBtn.textContent = "Assembled view";
    }

    function exitExplode() {
        if (!explodeGroup) return;
        CC.scene.remove(explodeGroup);
        for (const p of proxies) {
            if (p.mesh) { p.mesh.material.dispose(); p.mesh = null; }
        }
        explodeGroup = null;
        if (model) model.visible = true;
        explodeRow.style.display = "none";
        explodeBtn.textContent = "Exploded view";
        refresh(); // grid preview comes back
    }

    explodeBtn.addEventListener("click", () => (explodeGroup ? exitExplode() : enterExplode()));
    explodeAmt.addEventListener("input", updateExplode);

    function download(blob, name) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 10000);
    }

    /* Zip sink #1 — universal: fflate chunks wrapped in Blobs immediately
       (Chromium pages big blobs to disk, so the JS heap stays flat). Over
       `cap` bytes the current zip downloads and a fresh one opens, so no
       single Blob outgrows what a tab can hand to a download. */
    function blobZipWriter(baseName, cap = 500 * 1024 * 1024) {
        let chunks = [], zip = null, size = 0, closed = 0;
        const names = [];
        const open = () => {
            chunks = []; size = 0;
            zip = new fflate.Zip((err, chunk) => {
                if (err) throw err;
                if (chunk && chunk.length) chunks.push(new Blob([chunk]));
            });
        };
        const flush = (multi) => {
            zip.end();
            const name = multi ? `${baseName}-part${closed + 1}.zip` : `${baseName}.zip`;
            download(new Blob(chunks, { type: "application/zip" }), name);
            names.push(name);
            closed++;
            chunks = [];
        };
        open();
        return {
            add(name, bytes) {
                const f = new fflate.ZipPassThrough(name);
                zip.add(f);
                f.push(bytes, true);
                size += bytes.length;
                if (size > cap) { flush(true); open(); }
            },
            async end() { flush(closed > 0); return names; },
            abort() { try { zip.end(); } catch (e) { /* already done */ } },
        };
    }

    /* Zip sink #2 — File System Access streaming (Chrome/Edge over https):
       one zip of any size written straight to the file Max picks. Absent on
       file:// and in Brave/Firefox/Safari (verified 2026-07-13), where the
       blob writer above takes over. */
    async function fsaZipWriter(baseName) {
        const handle = await window.showSaveFilePicker({
            suggestedName: `${baseName}.zip`,
            types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
        });
        const writable = await handle.createWritable();
        let chain = Promise.resolve();
        const zip = new fflate.Zip((err, chunk) => {
            if (err) throw err;
            if (chunk && chunk.length) {
                const copy = chunk.slice();
                chain = chain.then(() => writable.write(copy));
            }
        });
        return {
            add(name, bytes) {
                const f = new fflate.ZipPassThrough(name);
                zip.add(f);
                f.push(bytes, true);
            },
            async end() {
                zip.end();
                await chain;
                await writable.close();
                return [`${baseName}.zip (saved to disk)`];
            },
            abort() { try { zip.end(); } catch (e) { /* noop */ } chain.then(() => writable.abort()); },
        };
    }

    /* Assembly map: one top-view grid per layer, spreadsheet-style labels,
       print-friendly black-on-white. Returns PNG bytes. */
    async function renderAssemblyMap(g, occupied, s) {
        const cell = Math.max(26, Math.min(64, Math.floor(560 / Math.max(g.counts.x, g.counts.z))));
        const pad = 34, header = 26, footer = 74;
        const gw = g.counts.x * cell, gh = g.counts.z * cell;
        const canvas = document.createElement("canvas");
        canvas.width = gw + pad * 2;
        canvas.height = (header + gh + 18) * g.counts.y + footer + pad;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error(`assembly map canvas refused (${canvas.width}×${canvas.height} px — over the browser limit?)`);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.textAlign = "center"; ctx.textBaseline = "middle";

        let y = pad / 2;
        for (let li = 0; li < g.counts.y; li++) {
            ctx.fillStyle = "#000";
            ctx.font = "bold 15px Inter, sans-serif";
            ctx.textAlign = "left";
            ctx.fillText(g.counts.y > 1 ? `Layer ${li + 1}${li ? ` (-L${li + 1})` : ""}` : "Top view", pad, y + header / 2);
            ctx.textAlign = "center";
            y += header;
            for (let ri = 0; ri < g.counts.z; ri++) {
                for (let ci = 0; ci < g.counts.x; ci++) {
                    const x = pad + ci * cell, yy = y + ri * cell;
                    const id = Core.partId(ci, ri, li, g.counts.y);
                    const has = occupied.has(id);
                    ctx.fillStyle = has ? "#f2f2f2" : "#ffffff";
                    ctx.fillRect(x, yy, cell, cell);
                    ctx.strokeStyle = "#999";
                    ctx.strokeRect(x + 0.5, yy + 0.5, cell, cell);
                    if (has) {
                        ctx.fillStyle = "#000";
                        ctx.font = `${Math.max(10, cell * 0.3)}px Inter, sans-serif`;
                        ctx.fillText(id, x + cell / 2, yy + cell / 2);
                    }
                }
            }
            y += gh + 18;
        }
        ctx.fillStyle = "#000";
        ctx.textAlign = "left";
        ctx.font = "12px Inter, sans-serif";
        ctx.fillText(`${s.name} — ×${s.scale}  ·  ${s.size.x.toFixed(0)} × ${s.size.z.toFixed(0)} × ${s.size.y.toFixed(0)} mm  ·  ${occupied.size} parts`, pad, y + 14);
        ctx.fillText(`Columns = letters (left→right) · rows = numbers (back→front) · layers bottom-up`, pad, y + 32);
        ctx.fillText(`Printer ${s.printer}, margin ${s.margin} mm · gap ${s.gap} mm · connectors ${s.connectors}`, pad, y + 50);

        const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
        if (!blob) throw new Error("assembly map PNG encode returned null");
        return new Uint8Array(await blob.arrayBuffer());
    }

    async function cutAndExport() {
        if (running) return;
        if (!CC.cutFlow.isEngineReady()) {
            CC.toast("The cutting engine is still warming up — one moment.");
            return;
        }
        const p = params();
        const g = grid;
        if (!g) return;

        const baseName = (model.name || "model").replace(/[^\w.-]+/g, "-") + "-bigprint";
        running = true;
        cancelled = false;
        exportBtn.disabled = true;
        cancelBtn.textContent = "Stop";

        // FSA when the browser offers it (https Chrome/Edge); blobs otherwise.
        let writer;
        try {
            writer = window.showSaveFilePicker
                ? await fsaZipWriter(baseName)
                : blobZipWriter(baseName);
        } catch (err) {
            if (err && err.name === "AbortError") { // user dismissed the save dialog
                running = false;
                exportBtn.disabled = false;
                cancelBtn.textContent = "Cancel";
                return;
            }
            // the picker API itself failed — blob zips still work everywhere
            console.warn("save picker failed, using blob zips:", err);
            writer = blobZipWriter(baseName);
        }

        disposeProxies(); // fresh proxy set per export
        CC.progress.show("Preparing the model…");
        await new Promise((r) => setTimeout(r, 30)); // let the pill paint

        let solid = null;
        const rows = [];
        const occupied = new Set();
        let skippedEngravings = 0;
        try {
            const scaleM = new THREE.Matrix4().makeScale(scale, scale, scale);
            const base = CutCore.toManifold(model.geometry);
            solid = base.transform(scaleM.elements);
            base.delete();

            const min = { x: -p.size.x / 2, y: 0, z: -p.size.z / 2 };
            const cells = Core.gridCells(g, p.size, min);
            const fmt = document.getElementById("bp-format").value === "3mf" ? "3mf" : "stl";
            const gap = Math.min(Math.max(parseFloat(gapInput.value) || 0, 0), 0.5);
            const conn = connBox.checked ? {
                size: Math.max(parseFloat(connSize.value) || 4, 2),
                depth: Math.max((parseFloat(connSize.value) || 4) * 0.8, 2),
                shape: connShape.value,
                tolR: Math.max(parseFloat(connTol.value) || 0, 0),
                tolD: Math.max(parseFloat(connTol.value) || 0, 0),
            } : null;

            for (let i = 0; i < cells.length; i++) {
                if (cancelled) break;
                const cell = engraveBox.checked
                    ? { ...cells[i], engraveId: cells[i].id } : cells[i];
                CC.progress.update(
                    `Cutting part ${occupied.size + 1} (cell ${i + 1} of ${cells.length})…`,
                    i / cells.length);
                await new Promise((r) => setTimeout(r)); // keep the UI alive
                const geo = CutCore.cutGridCell(solid, cell, gap, conn);
                if (!geo) continue; // the model never enters this cell
                const bytes = fmt === "3mf" ? Core.serialize3MF(geo) : Core.serializeSTL(geo);
                const file = `Part_${cell.id}.${fmt}`;
                writer.add(file, bytes);
                rows.push({
                    id: cell.id, file,
                    tris: geo.getIndex().count / 3,
                    engraved: !!(geo.userData && geo.userData.engraved),
                });
                if (engraveBox.checked && !(geo.userData && geo.userData.engraved)) {
                    skippedEngravings++;
                }
                occupied.add(cell.id);
                collectProxy(geo, cell.id); // budgeted stand-in for the exploded view
                geo.dispose(); // streaming: only rows + proxies accumulate
            }

            if (cancelled) {
                writer.abort();
                CC.progress.hide();
                CC.toast("Stopped — nothing more was exported.");
                return;
            }

            const opt = printerSelect.selectedOptions[0];
            const settings = {
                name: model.name || "model",
                scale: +scale.toFixed(3),
                size: p.size, bed: p.bed, margin: p.margin, gap,
                printer: printerSelect.value === "custom" ? "custom bed" : opt.textContent,
                connectors: conn
                    ? `${conn.shape} ${conn.size} mm, tolerance ${conn.tolR} mm`
                    : "off",
            };
            CC.progress.update("Drawing the assembly map…", 1);
            try {
                writer.add("assembly-map.png", await renderAssemblyMap(g, occupied, settings));
            } catch (mapErr) { // the parts matter more than the map — ship without it
                console.warn("assembly map skipped:", mapErr);
                CC.toast("The assembly map couldn't be rendered — the zip ships without it.");
            }
            writer.add("manifest.txt",
                new TextEncoder().encode(Core.buildManifest(rows, settings)));
            const files = await writer.end();

            CC.bigPrint._lastExport = { parts: rows.length, files, skippedEngravings, rows,
                proxies: proxies.length, proxyTruncated };
            if (proxies.length) explodeBtn.style.display = "";
            CC.toast(`Big Print done — ${rows.length} part${rows.length === 1 ? "" : "s"} in `
                + `${files.length} zip${files.length === 1 ? "" : "s"}`
                + (skippedEngravings ? ` (${skippedEngravings} too small to engrave)` : "")
                + ".");
        } catch (err) {
            console.error("Big Print export failed:", err);
            CC.toast(err.message === "not-watertight"
                ? "This model isn't watertight, so it can't be grid-cut cleanly."
                : "The export failed — see the console for details.");
            writer.abort();
        } finally {
            if (solid) solid.delete();
            CC.progress.hide();
            running = false;
            exportBtn.disabled = false;
            cancelBtn.textContent = "Cancel";
        }
    }

    document.getElementById("bigprint-btn").addEventListener("click", enter);
    cancelBtn.addEventListener("click", () => {
        if (running) { cancelled = true; return; }
        exit();
    });
    exportBtn.addEventListener("click", cutAndExport);

    window.addEventListener("keydown", (e) => {
        if (active && e.key === "Escape") exit();
    });
    window.addEventListener("curvecut:model-loaded", () => { if (active) exit(); });

    CC.bigPrint = { enter, exit, isActive: () => active };
})();
