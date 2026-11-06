/* Curve Cut — the visit donation popup (Max's request #14).
   Every visit, one playful question: free version or premium version?
   Both buttons are the same app — the "premium" one is a wink, the free one
   opens the donate link. Shows once per page load, never during the tour's
   first-visit run, and not at all when DONATE_URL is unset. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    if (!CC || !CC.about || !CC.about.donateUrl) return;

    // first visit belongs to the tour — one popup at a time
    let tourVisit = false;
    try { tourVisit = !localStorage.getItem("curvecut-tour"); } catch (_) {}
    if (tourVisit) return;

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "donate-overlay";
    const modal = document.createElement("div");
    modal.className = "modal about-modal";
    modal.id = "donate-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", "donate-title");
    modal.innerHTML = `
        <button class="close-modal" id="donate-close" aria-label="Close">&times;</button>
        <h2 class="modal-title" id="donate-title">Quick question</h2>
        <p class="modal-text">Which version of Curve Cut are you using?</p>
        <p class="modal-text">(They're the same app. One of them just comes with the warm
            glow of supporting a lot of late-night open-source work.)</p>
        <div class="about-actions">
            <a class="btn primary-btn" id="donate-free" target="_blank" rel="noopener">
                The free one — I'll chip in
            </a>
            <button class="btn secondary-btn" id="donate-premium">The premium one 😉</button>
        </div>`;
    document.body.append(overlay, modal);

    const freeBtn = modal.querySelector("#donate-free");
    freeBtn.href = CC.about.donateUrl;

    const trap = CC.a11y.makeFocusTrap(modal);
    let open = false;
    function show() {
        if (open) return;
        open = true;
        trap.activate();
        gsap.to(overlay, { autoAlpha: 1, duration: CC.a11y.dur(0.3), ease: "power2.out" });
        gsap.fromTo(modal, { scale: 0.95 },
            { autoAlpha: 1, scale: 1, duration: CC.a11y.dur(0.4), ease: "power4.out" });
    }
    function hide() {
        if (!open) return;
        open = false;
        trap.deactivate();
        gsap.to(overlay, { autoAlpha: 0, duration: CC.a11y.dur(0.3), ease: "power2.out" });
        gsap.to(modal, { autoAlpha: 0, scale: 0.95, duration: CC.a11y.dur(0.3), ease: "power2.out" });
    }

    freeBtn.addEventListener("click", () => { // the link opens itself; we just say thanks
        hide();
        CC.toast("Thank you — you keep Curve Cut free. 💛");
    });
    modal.querySelector("#donate-premium").addEventListener("click", () => {
        hide();
        CC.toast("Premium activated. (It was already on.) 😉");
    });
    modal.querySelector("#donate-close").addEventListener("click", hide);
    overlay.addEventListener("click", hide);
    window.addEventListener("keydown", (e) => {
        if (open && e.key === "Escape") { e.stopPropagation(); hide(); }
    }, true);

    // let the workspace settle first; skip if the tour got relaunched meanwhile
    setTimeout(() => { if (!(CC.tour && CC.tour.isActive())) show(); }, 2200);
})();
