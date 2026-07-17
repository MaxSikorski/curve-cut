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
            wireBtn.addEventListener("click", () => {
                piece.material.wireframe = !piece.material.wireframe;
                wireBtn.classList.toggle("on", piece.material.wireframe);
            });

            const eyeBtn = document.createElement("button");
            eyeBtn.className = "piece-icon" + (piece.visible ? " on" : "");
            eyeBtn.innerHTML = EYE_SVG;
            eyeBtn.setAttribute("aria-label", "Toggle visibility");
            eyeBtn.addEventListener("click", () => {
                piece.visible = !piece.visible;
                eyeBtn.classList.toggle("on", piece.visible);
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

    function exportVisible() {
        const visible = CC.pieces.filter((p) => p.visible);
        if (!visible.length) {
            CC.toast("Every piece is hidden — nothing to export.");
            return;
        }

        const exporter = new THREE.STLExporter();
        const used = new Set();
        const files = visible.map((piece, i) => {
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
        });

        if (files.length >= 2) {
            // two or more parts belong together — one zip, not a download storm
            const entries = {};
            for (const f of files) {
                // 3MF is already deflated; storing it again would just burn CPU
                entries[f.name] = exportFmt === "3mf" ? [f.bytes, { level: 0 }] : f.bytes;
            }
            const zipped = fflate.zipSync(entries);
            download(new Blob([zipped], { type: "application/zip" }),
                `curve-cut-${files.length}-pieces.zip`);
            CC.toast(`Exporting ${files.length} pieces as one ${exportFmt.toUpperCase()} zip…`);
        } else {
            const f = files[0];
            download(new Blob([f.bytes], { type: f.type }), f.name);
            CC.toast(`Exporting 1 piece as ${exportFmt.toUpperCase()}…`);
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
