/* Curve Cut — heavy-model simplify offer (MVP step 5)
   Over a triangle budget, offer one-click simplification (Manifold, within a
   tiny geometric tolerance) so booleans stay fast. User stays in control:
   "Keep original" always works. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const TRIANGLE_BUDGET = 500_000;
    const TARGET_TRIS = 375_000; // Max, 2026-07-13: keep plenty of detail, ~350-400k

    const overlay = document.getElementById("simplify-overlay");
    const modal = document.getElementById("simplify-modal");
    const text = document.getElementById("simplify-text");
    const keepBtn = document.getElementById("simplify-keep");
    const goBtn = document.getElementById("simplify-go");

    let open = false;
    const trap = CC.a11y.makeFocusTrap(modal);

    function triCount(piece) {
        const g = piece.geometry;
        return (g.getIndex() ? g.getIndex().count : g.getAttribute("position").count) / 3;
    }

    function show(piece) {
        const tris = Math.round(triCount(piece));
        text.textContent =
            `It has ${tris.toLocaleString()} triangles, so cutting could take a while ` +
            `or freeze the page briefly. I can gently simplify it to roughly ` +
            `${TARGET_TRIS.toLocaleString()} triangles — still plenty of detail for ` +
            `printing — so cuts stay fast. Your original file is never modified.`;
        open = true;
        trap.activate();
        gsap.to(overlay, { autoAlpha: 1, duration: CC.a11y.dur(0.4), ease: "power2.out" });
        gsap.fromTo(modal, { autoAlpha: 0, scale: 0.95 },
            { autoAlpha: 1, scale: 1, duration: CC.a11y.dur(0.5), ease: "power4.out" });
    }

    function hide() {
        open = false;
        trap.deactivate();
        gsap.to(overlay, { autoAlpha: 0, duration: CC.a11y.dur(0.4), ease: "power2.out" });
        gsap.to(modal, { autoAlpha: 0, scale: 0.95, duration: CC.a11y.dur(0.35), ease: "power2.out" });
    }

    function simplify() {
        const piece = CC.pieces[0];
        if (!piece) { hide(); return; }
        const op = CC.ops.begin("simplify");
        if (!op) {
            CC.toast("Another operation is still running — one moment.");
            return;
        }
        goBtn.disabled = true;
        goBtn.textContent = "Simplifying…";
        CC.progress.show("Simplifying the model…");

        CutCore.init().then(() => setTimeout(() => {
            try {
                // the piece set changed while the engine warmed up — the
                // captured piece may no longer be the live model
                if (!op.alive() || !CC.pieces.includes(piece)) {
                    CC.toast("The model changed — simplification was skipped.");
                    return;
                }
                const before = Math.round(triCount(piece));
                const slim = CutCore.simplifyToTarget(piece.geometry, TARGET_TRIS);

                // swap in a NEW mesh (never mutate — undo snapshots hold the old one)
                CC.history.capture();
                const fresh = new THREE.Mesh(slim, piece.material);
                fresh.name = piece.name;
                fresh.visible = piece.visible;
                Object.assign(fresh.userData, piece.userData);
                CC.scene.remove(piece);
                CC.scene.add(fresh);
                CC.pieces.splice(CC.pieces.indexOf(piece), 1, fresh);
                window.dispatchEvent(new CustomEvent("curvecut:pieces-changed"));
                if (CC.scheduleWatertightCheck) CC.scheduleWatertightCheck(CC.pieces[0]);

                const after = Math.round(triCount(fresh));
                slim.computeBoundingBox();
                const size = new THREE.Vector3();
                slim.boundingBox.getSize(size);
                CC.showStats(fresh.name, after, size);
                CC.toast(`Simplified: ${before.toLocaleString()} → ${after.toLocaleString()} triangles.`);
            } catch (err) {
                CC.toast(err.message === "not-watertight"
                    ? "This model isn't watertight, so it can't be simplified safely — keeping the original."
                    : "Simplification failed — keeping the original.");
                console.error(err);
            } finally {
                CC.ops.end(op);
                CC.progress.hide();
                goBtn.disabled = false;
                goBtn.textContent = "Simplify";
                hide();
            }
        }, 40)).catch((err) => {
            // engine never came up — release the coordinator or it wedges
            console.error(err);
            CC.ops.end(op);
            CC.progress.hide();
            goBtn.disabled = false;
            goBtn.textContent = "Simplify";
            hide();
            CC.toast("The cutting engine failed to start — keeping the original.");
        });
    }

    keepBtn.addEventListener("click", hide);
    goBtn.addEventListener("click", simplify);
    overlay.addEventListener("click", hide);
    window.addEventListener("keydown", (e) => { if (open && e.key === "Escape") hide(); });

    window.addEventListener("curvecut:pieces-changed", () => {
        const piece = CC.pieces[0];
        if (CC.pieces.length !== 1 || !piece) return;
        if (piece.userData.simplifyPrompted) return;
        piece.userData.simplifyPrompted = true;
        if (triCount(piece) > TRIANGLE_BUDGET) show(piece);
    });
})();
