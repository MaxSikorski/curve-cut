/* Curve Cut — the "i" popup (about, GitHub, donate, tour launcher).
   DONATE_URL is Max's Stripe payment link; set it null to hide the donate
   button (and the js/donate.js visit popup) rather than link anywhere fake. */

(() => {
    "use strict";

    const REPO_URL = "https://github.com/MaxSikorski/curve-cut";
    const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
    const DONATE_URL = "https://buy.stripe.com/7sY00i79Q1H50S9dZn0gw00"; // Max's Stripe payment link (2026-07-17)

    const overlay = document.getElementById("about-overlay");
    const modal = document.getElementById("about-modal");
    const github = document.getElementById("about-github");
    const license = document.getElementById("about-license");
    const source = document.getElementById("about-source");
    const donate = document.getElementById("about-donate");
    const tourBtn = document.getElementById("about-tour");

    github.href = REPO_URL;
    license.href = LICENSE_URL;
    source.href = REPO_URL;
    if (DONATE_URL) {
        donate.href = DONATE_URL;
        donate.style.display = "";
    } else {
        donate.style.display = "none"; // .btn's display beats the hidden attribute
    }

    const a11y = window.CurveCut.a11y;
    let open = false;
    let endedTour = false; // the tour trap moved focus away, so give it back on close
    const trap = a11y.makeFocusTrap(modal);

    function show() {
        if (open) return;
        const tour = window.CurveCut.tour;
        endedTour = !!(tour && tour.isActive());
        if (tour) tour.dismissForAbout();
        open = true;
        trap.activate();
        gsap.killTweensOf([overlay, modal]);
        gsap.to(overlay, { autoAlpha: 1, duration: a11y.dur(0.3), ease: "power2.out" });
        gsap.fromTo(modal, { scale: 0.95 },
            { autoAlpha: 1, scale: 1, duration: a11y.dur(0.4), ease: "power4.out" });
    }

    function hide(immediate) {
        if (!open) return;
        open = false;
        trap.deactivate();
        if (endedTour) { endedTour = false; document.getElementById("info-btn").focus({ preventScroll: true }); }
        gsap.killTweensOf([overlay, modal]);
        if (immediate === true) {
            gsap.set(overlay, { autoAlpha: 0 });
            gsap.set(modal, { autoAlpha: 0, scale: 0.95 });
            return;
        }
        gsap.to(overlay, { autoAlpha: 0, duration: a11y.dur(0.3), ease: "power2.out" });
        gsap.to(modal, { autoAlpha: 0, scale: 0.95, duration: a11y.dur(0.3), ease: "power2.out" });
    }

    document.getElementById("info-btn").addEventListener("click", show);
    document.getElementById("about-close").addEventListener("click", hide);
    overlay.addEventListener("click", hide);
    // capture phase so Esc closes the popup without also backing out of a mode
    window.addEventListener("keydown", (e) => {
        if (open && e.key === "Escape") {
            e.stopPropagation();
            hide();
        }
    }, true);

    // the tour (js/tour.js) reveals this button when it registers itself;
    // donateUrl feeds the visit popup (js/donate.js)
    window.CurveCut.about = { show, hide, isOpen: () => open, tourBtn, donateUrl: DONATE_URL };
})();
