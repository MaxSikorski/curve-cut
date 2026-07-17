/* Curve Cut — cut preview + apply (MVP step 3)
   Listens for the pen tool's finished spline, shows the extruded cutting
   ribbon in 3D, and on Apply runs the Manifold boolean split via CutCore. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const { scene, controls } = CC;

    const previewDock = document.getElementById("preview-dock");
    const applyBtn = document.getElementById("cut-apply");
    const discardBtn = document.getElementById("cut-discard");

    let ribbon = null;
    let cutPlaneMesh = null;
    let previewOpen = false;
    let tinted = []; // [{mesh, colorHex}] pieces carrying preview vertex tints

    // Polycarver-style preview colors (piece-color exception, HANDOFF §4 #10)
    const RIBBON_COLOR = 0xd47a72;   // soft red — the cutting surface
    const PLANE_COLOR = 0x6f95d4;    // soft blue — the locked camera plane
    const TINT_A = { r: 0.435, g: 0.584, b: 0.831 }; // soft blue half
    const TINT_B = { r: 0.839, g: 0.627, b: 0.431 }; // soft orange half

    // warm the WASM engine up front so Apply is instant later
    let engineFailed = false;
    CutCore.init().catch((err) => {
        engineFailed = true;
        console.error("Manifold init failed:", err);
        CC.toast("The cutting engine failed to start — check the console.");
    });

    // Max-sanctioned exception to the monochrome rule (2026-07-13): the UI stays
    // black/white, but once cutting starts each piece takes a soft, elegant color
    // so you can tell the cuts apart at a glance — light and dark variants of
    // blue, red, green, yellow, purple, teal, orange, pink.
    const PIECE_COLORS = [
        0x6f95d4, // blue
        0xd47a72, // red
        0x7db98a, // green
        0xd6bd6e, // yellow
        0xa584d1, // purple
        0x6fbcbc, // teal
        0xd6a06e, // orange
        0xc98bb4, // pink
        0x41639c, // dark blue
        0x9c4a42, // dark red
        0x4d8a5c, // dark green
        0x9e853e, // dark yellow
        0x6e4d9c, // dark purple
        0x3e8a8a, // dark teal
    ];
    let colorIdx = 0;
    const nextMaterial = () => {
        const m = CC.baseMaterial.clone();
        m.color.setHex(PIECE_COLORS[colorIdx++ % PIECE_COLORS.length]);
        return m;
    };

    function cutReach() {
        // how far the cutter must extend to fully clear every piece
        const box = new THREE.Box3();
        for (const p of CC.pieces) box.expandByObject(p);
        const sphere = new THREE.Sphere();
        box.getBoundingSphere(sphere);
        return Math.max(sphere.radius * 3, 10);
    }

    // ------------------------------------------------------------- preview

    function planeBasis(spline) {
        // must match CutCore.buildCutter's basis so tint sides == cut sides
        const n = spline.normal.clone().normalize();
        const up = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const e1 = new THREE.Vector3().crossVectors(up, n).normalize();
        const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
        return { n, e1, e2, origin: spline.planePoint };
    }

    function showPreview() {
        removePreviewMeshes();
        const reach = cutReach();
        const line = CutCore.sampleSpline(CC.spline, reach);
        if (line.length < 2) return;
        const { n, e1, e2, origin } = planeBasis(CC.spline);

        // red ribbon: the actual cutting surface
        const verts = new Float32Array(line.length * 2 * 3);
        for (let i = 0; i < line.length; i++) {
            const lo = line[i].clone().addScaledVector(n, -reach);
            const hi = line[i].clone().addScaledVector(n, reach);
            verts.set([lo.x, lo.y, lo.z, hi.x, hi.y, hi.z], i * 6);
        }
        const idx = [];
        for (let i = 0; i < line.length - 1; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
            idx.push(a, c, b, b, c, d);
        }
        const ribbonGeo = new THREE.BufferGeometry();
        ribbonGeo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
        ribbonGeo.setIndex(idx);
        ribbon = new THREE.Mesh(ribbonGeo, new THREE.MeshBasicMaterial({
            color: RIBBON_COLOR, transparent: true, opacity: 0.3,
            side: THREE.DoubleSide, depthWrite: false,
        }));
        scene.add(ribbon);

        // blue plane: the locked camera plane the curve was drawn on
        const span = cutReach() * 1.1;
        const planeGeo = new THREE.PlaneGeometry(span * 2, span * 2);
        cutPlaneMesh = new THREE.Mesh(planeGeo, new THREE.MeshBasicMaterial({
            color: PLANE_COLOR, transparent: true, opacity: 0.08,
            side: THREE.DoubleSide, depthWrite: false,
        }));
        cutPlaneMesh.matrixAutoUpdate = false;
        cutPlaneMesh.matrix.makeBasis(e1, e2, n).setPosition(origin);
        scene.add(cutPlaneMesh);

        tintBySide(curveClassifier(line, { n, e1, e2, origin }));

        previewOpen = true;
        gsap.fromTo(previewDock, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out" });
    }

    /* Tint every visible piece's vertices blue/orange by a caller-supplied
       side test — the Polycarver-style "what you'll get" preview, computed
       on the CPU so it works on any GPU. classifier(x,y,z) -> true = side A. */
    function tintBySide(classifier) {
        untintPieces();
        for (const mesh of CC.pieces) {
            if (!mesh.visible) continue;
            const pos = mesh.geometry.getAttribute("position");
            const colors = new Float32Array(pos.count * 3);
            for (let v = 0; v < pos.count; v++) {
                const t = classifier(pos.getX(v), pos.getY(v), pos.getZ(v)) ? TINT_A : TINT_B;
                colors[v * 3] = t.r; colors[v * 3 + 1] = t.g; colors[v * 3 + 2] = t.b;
            }
            mesh.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
            tinted.push({ mesh, colorHex: mesh.material.color.getHex() });
            mesh.material.vertexColors = true;
            mesh.material.color.setHex(0xffffff);
            mesh.material.needsUpdate = true;
        }
    }

    /* Side test for the drawn curve: nearest-segment sign in cut-plane 2D. */
    function curveClassifier(line, basis) {
        const step = Math.max(1, Math.floor(line.length / 48));
        const curve = [];
        for (let i = 0; i < line.length; i += step) {
            const d = line[i].clone().sub(basis.origin);
            curve.push([d.dot(basis.e1), d.dot(basis.e2)]);
        }
        return (x, y, z) => {
            const dx = x - basis.origin.x, dy = y - basis.origin.y, dz = z - basis.origin.z;
            const px = dx * basis.e1.x + dy * basis.e1.y + dz * basis.e1.z;
            const py = dx * basis.e2.x + dy * basis.e2.y + dz * basis.e2.z;
            let bestD = Infinity, side = 1;
            for (let s = 0; s < curve.length - 1; s++) {
                const ax = curve[s][0], ay = curve[s][1];
                const bx = curve[s + 1][0], by = curve[s + 1][1];
                const r = PenCore.distToSegment2D(px, py, ax, ay, bx, by);
                if (r.dist < bestD) {
                    bestD = r.dist;
                    side = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) >= 0 ? 1 : -1;
                }
            }
            return side > 0;
        };
    }

    function untintPieces() {
        for (const { mesh, colorHex } of tinted) {
            mesh.geometry.deleteAttribute("color");
            mesh.material.vertexColors = false;
            mesh.material.color.setHex(colorHex);
            mesh.material.needsUpdate = true;
        }
        tinted = [];
    }

    function removePreviewMeshes() {
        untintPieces();
        for (const m of [ribbon, cutPlaneMesh]) {
            if (!m) continue;
            scene.remove(m);
            m.geometry.dispose();
            m.material.dispose();
        }
        ribbon = null;
        cutPlaneMesh = null;
    }

    function closePreview() {
        removePreviewMeshes();
        if (!previewOpen) return;
        previewOpen = false;
        gsap.to(previewDock, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
    }

    function discard() {
        CC.spline = null;
        closePreview();
    }

    // --------------------------------------------------------------- apply

    // resolve after the browser has actually painted (double rAF)
    const framePainted = () => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)));

    function apply() {
        if (!CC.spline || !previewOpen) return;
        if (!CutCore.isReady()) {
            CC.toast(engineFailed
                ? "The cutting engine failed to start — reload the page."
                : "The cutting engine is still warming up — one moment.");
            return;
        }
        applyBtn.disabled = true;
        applyBtn.textContent = "Cutting…";

        runCut().catch((err) => {
            if (err.message === "not-watertight") {
                CC.toast("This model isn't watertight, so it can't be cut cleanly. A repair tool is planned.");
            } else {
                console.error(err);
                CC.toast("The cut failed — see the console for details.");
            }
        }).finally(() => {
            CC.progress.hide();
            applyBtn.disabled = false;
            applyBtn.textContent = "Apply Cut";
        });
    }

    /* The shared apply pipeline: progress, per-piece boolean, undo capture,
       piece replacement + coloring. Used by curve cuts here and by the
       planar/dovetail modes (js/cutmodes.js).
       makeCutter() -> Manifold solid; keep = {inside, outside} booleans;
       makeConnectors() (optional) -> {pegs, sockets, maleSide} solids that
       this flow deletes after cutting. */
    async function applyCutterFlow(makeCutter, keep = { inside: true, outside: true }, makeConnectors = null) {
        untintPieces(); // never let preview tints leak into undo snapshots
        const visible = CC.pieces.filter((p) => p.visible);
        if (!visible.length) {
            CC.toast("Every piece is hidden — nothing to cut.");
            return false;
        }

        CC.progress.show("Preparing the cut…");
        await framePainted();
        // makeCutter returns one Manifold, or {inside, outside} when the two
        // pieces need different cutters (dovetail tolerance clearance)
        const made = makeCutter();
        const cutterIn = made.inside || made;
        const cutterOut = made.outside || made;
        const connectors = makeConnectors ? makeConnectors() : null;
        const results = [];
        try {
            for (let i = 0; i < visible.length; i++) {
                CC.progress.update(
                    visible.length === 1 ? "Cutting…" : `Cutting piece ${i + 1} of ${visible.length}…`,
                    visible.length === 1 ? null : i / visible.length);
                await framePainted();
                results.push(CutCore.cutWithCutter(visible[i].geometry, cutterIn, cutterOut, connectors));
            }
        } catch (err) {
            // a mid-loop failure leaves finished halves nobody will ever commit
            for (const r of results) {
                if (r.inside) r.inside.dispose();
                if (r.outside) r.outside.dispose();
            }
            throw err;
        } finally {
            cutterIn.delete();
            if (cutterOut !== cutterIn) cutterOut.delete();
            if (connectors) {
                for (const s of connectors.pegs.concat(connectors.sockets)) s.delete();
            }
        }
        CC.progress.update("Finishing…", 1);
        await framePainted();

        CC.history.capture(); // the outgoing piece set becomes the undo step

        let counter = CC.pieces.length;
        for (let i = 0; i < visible.length; i++) {
            const src = visible[i];
            const r = results[i];
            if (!r.inside || !r.outside) {
                // cut missed this piece — keep it, but a one-sided miss still
                // allocated the other half; free it or it leaks
                if (r.inside) r.inside.dispose();
                if (r.outside) r.outside.dispose();
                continue;
            }

            CC.pieces.splice(CC.pieces.indexOf(src), 1);
            scene.remove(src); // geometry lives on in the undo stack — no dispose

            for (const [g, keepIt] of [[r.inside, keep.inside], [r.outside, keep.outside]]) {
                if (!keepIt) { g.dispose(); continue; }
                const mesh = new THREE.Mesh(g, nextMaterial());
                mesh.name = `${src.name} · ${++counter}`;
                scene.add(mesh);
                CC.pieces.push(mesh);
            }
        }

        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed"));
        CC.toast(`Cut complete — ${CC.pieces.length} piece${CC.pieces.length === 1 ? "" : "s"}.`);
        return true;
    }

    async function runCut() {
        const reach = cutReach();
        const spline = CC.spline;
        const gap = Math.min(Math.max(
            parseFloat(document.getElementById("cut-clearance").value) || 0, 0), 0.5);
        const done = await applyCutterFlow(() => {
            const exact = CutCore.buildCutter(spline, reach, reach);
            if (!gap) return exact;
            // outside piece is cut with a grown cutter -> assembled gap = `gap`
            return { inside: exact, outside: CutCore.buildCutter(spline, reach, reach, gap) };
        });
        if (done) {
            CC.spline = null;
            closePreview();
        }
    }

    // ----------------------------------------------------------------- wire

    applyBtn.addEventListener("click", apply);
    discardBtn.addEventListener("click", discard);
    window.addEventListener("curvecut:spline-ready", showPreview);
    window.addEventListener("curvecut:spline-cleared", closePreview);
    window.addEventListener("curvecut:model-loaded", () => {
        discard();
        colorIdx = 0; // a fresh model restarts the piece-color cycle
    });
    window.addEventListener("keydown", (e) => {
        if (previewOpen && e.key === "Escape") discard();
    });

    // shared surface for the planar/dovetail modes (js/cutmodes.js)
    CC.cutFlow = {
        applyCutterFlow, tintBySide, untint: untintPieces, cutReach,
        isEngineReady: () => CutCore.isReady(),
        RIBBON_COLOR,
    };
})();
