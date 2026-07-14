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
        gsap.to(overlay, { autoAlpha: 1, duration: 0.4, ease: "power2.out" });
        gsap.fromTo(modal, { autoAlpha: 0, scale: 0.95 },
            { autoAlpha: 1, scale: 1, duration: 0.5, ease: "power4.out" });
    }

    function hide() {
        open = false;
        gsap.to(overlay, { autoAlpha: 0, duration: 0.4, ease: "power2.out" });
        gsap.to(modal, { autoAlpha: 0, scale: 0.95, duration: 0.35, ease: "power2.out" });
    }

    function simplify() {
        const piece = CC.pieces[0];
        if (!piece) { hide(); return; }
        goBtn.disabled = true;
        goBtn.textContent = "Simplifying…";
        CC.progress.show("Simplifying the model…");

        CutCore.init().then(() => setTimeout(() => {
            try {
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
                CC.progress.hide();
                goBtn.disabled = false;
                goBtn.textContent = "Simplify";
                hide();
            }
        }, 40));
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
