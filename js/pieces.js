/* Curve Cut — pieces panel + STL export (MVP step 4)
   Lists every piece with visibility + wireframe toggles; exports each
   visible piece as its own binary STL (rotated back to printer Z-up). */

(() => {
    "use strict";

    const CC = window.CurveCut;

    const panel = document.getElementById("pieces-panel");
    const list = document.getElementById("pieces-list");
    const exportBtn = document.getElementById("export-btn");

    const EYE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    const WIRE_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 22 8.5v7L12 22 2 15.5v-7L12 2z"/><path d="M12 2v20M2 8.5l20 7M22 8.5l-20 7"/></svg>';

    let shown = false;

    function rebuild() {
        if (!CC.pieces.length) {
            gsap.to(panel, { autoAlpha: 0, duration: 0.3, ease: "power2.out" });
            shown = false;
            return;
        }

        list.innerHTML = "";
        CC.pieces.forEach((piece, i) => {
            const row = document.createElement("div");
            row.className = "piece-row" + (piece.visible ? "" : " piece-hidden");

            const dot = document.createElement("span");
            dot.className = "piece-dot";
            dot.style.background = "#" + piece.material.color.getHexString();

            const name = document.createElement("span");
            name.className = "piece-name";
            name.textContent = piece.name || `piece ${i + 1}`;
            name.title = name.textContent;

            const wireBtn = document.createElement("button");
            wireBtn.className = "piece-icon" + (piece.material.wireframe ? " on" : "");
            wireBtn.innerHTML = WIRE_SVG;
            wireBtn.setAttribute("aria-label", "Toggle wireframe");
            wireBtn.setAttribute("aria-pressed", piece.material.wireframe ? "true" : "false");
            wireBtn.addEventListener("click", () => {
                piece.material.wireframe = !piece.material.wireframe;
                wireBtn.classList.toggle("on", piece.material.wireframe);
                wireBtn.setAttribute("aria-pressed", piece.material.wireframe ? "true" : "false");
            });

            const eyeBtn = document.createElement("button");
            eyeBtn.className = "piece-icon" + (piece.visible ? " on" : "");
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.setAttribute("aria-label", "Toggle visibility");
            eyeBtn.setAttribute("aria-pressed", piece.visible ? "true" : "false");
            eyeBtn.addEventListener("click", () => {
                piece.visible = !piece.visible;
                eyeBtn.classList.toggle("on", piece.visible);
                eyeBtn.setAttribute("aria-pressed", piece.visible ? "true" : "false");
                row.classList.toggle("piece-hidden", !piece.visible);
            });

            row.append(dot, name, wireBtn, eyeBtn);
            list.appendChild(row);
        });

        if (!shown) {
            shown = true;
            gsap.fromTo(panel, { x: 16 },
                { autoAlpha: 1, x: 0, duration: 0.8, ease: "power4.out" });
        }
    }

    // ---------------------------------------------------------------- export

    // export format toggle (v1.6): STL for universality, 3MF for size
    const fmtToggle = document.getElementById("export-fmt");
    let exportFmt = "stl";
    fmtToggle.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-fmt]");
        if (!btn) return;
        exportFmt = btn.dataset.fmt;
        for (const b of fmtToggle.querySelectorAll("button")) {
            b.classList.toggle("on", b === btn);
        }
    });

    function blobZipWriter() {
        let chunks = [];
        const zip = new fflate.Zip((err, chunk) => {
            if (err) throw err;
            if (chunk && chunk.length) chunks.push(new Blob([chunk]));
        });
        return {
            add(name, bytes, format) {
                const file = format === "stl"
                    ? new fflate.ZipDeflate(name, { level: 6 })
                    : new fflate.ZipPassThrough(name);
                zip.add(file);
                file.push(bytes, true);
            },
            end() {
                zip.end();
                const blob = new Blob(chunks, { type: "application/zip" });
                chunks = [];
                return blob;
            },
            abort() {
                try { zip.end(); } catch (err) { /* already failed/closed */ }
                chunks = [];
            },
        };
    }

    async function exportVisible() {
        const visible = CC.pieces.filter((p) => p.visible);
        if (!visible.length) {
            CC.toast("Every piece is hidden — nothing to export.");
            return;
        }

        const op = CC.ops.begin("export");
        if (!op) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }

        let writer = null;
        try {
            const exporter = new THREE.STLExporter();
            const used = new Set();
            const serialize = (piece, i) => {
                const base = (piece.name || `piece-${i + 1}`)
                    .replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || `piece-${i + 1}`;
                let name = base;
                for (let n = 2; used.has(name); n++) name = `${base}-${n}`;
                used.add(name);
                if (exportFmt === "3mf") {
                    // serialize3MF handles the Y-up -> Z-up mapping itself
                    const bytes = window.BigPrintCore.serialize3MF(piece.geometry);
                    return { bytes, type: "model/3mf", name: `${name}.3mf` };
                }
                // scene is Y-up; STLs are printer Z-up — rotate back on the way out
                const temp = new THREE.Mesh(piece.geometry, piece.material);
                temp.rotation.x = Math.PI / 2;
                temp.updateMatrixWorld(true);
                const data = exporter.parse(temp, { binary: true });
                return { bytes: new Uint8Array(data.buffer || data), type: "model/stl", name: `${name}.stl` };
            };

            if (visible.length >= 2) {
                // Stream one entry at a time so serialized meshes never accumulate.
                writer = blobZipWriter();
                CC.progress.show(`Exporting piece 1 of ${visible.length}…`);
                for (let i = 0; i < visible.length; i++) {
                    CC.progress.update(`Exporting piece ${i + 1} of ${visible.length}…`,
                        i / visible.length);
                    await new Promise((resolve) => setTimeout(resolve));
                    const file = serialize(visible[i], i);
                    writer.add(file.name, file.bytes, exportFmt);
                }
                CC.progress.update("Finishing zip…", 1);
                const zipped = writer.end();
                writer = null;
                download(zipped, `curve-cut-${visible.length}-pieces.zip`);
                CC.toast(`Exporting ${visible.length} pieces as one ${exportFmt.toUpperCase()} zip…`);
            } else {
                const file = serialize(visible[0], 0);
                download(new Blob([file.bytes], { type: file.type }), file.name);
                CC.toast(`Exporting 1 piece as ${exportFmt.toUpperCase()}…`);
            }
        } catch (err) {
            if (writer) writer.abort();
            console.error("Piece export failed:", err);
            CC.toast("The export failed — see the console for details.");
        } finally {
            try { CC.progress.hide(); } finally { CC.ops.end(op); }
        }
    }

    function download(blob, name) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }

    exportBtn.addEventListener("click", exportVisible);
    window.addEventListener("curvecut:pieces-changed", rebuild);
})();
