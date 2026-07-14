/* Curve Cut — the "i" popup (about, GitHub, donate, tour launcher).
   DONATE_URL stays null until Max sets up a real donation page — the
   button hides itself rather than link anywhere fake. */

(() => {
    "use strict";

    const REPO_URL = "https://github.com/MaxSikorski/curve-cut";
    const DONATE_URL = null; // Max fills this in when his donation page exists

    const overlay = document.getElementById("about-overlay");
    const modal = document.getElementById("about-modal");
    const github = document.getElementById("about-github");
    const donate = document.getElementById("about-donate");
    const tourBtn = document.getElementById("about-tour");

    github.href = REPO_URL;
    if (DONATE_URL) {
        donate.href = DONATE_URL;
        donate.style.display = "";
    } else {
        donate.style.display = "none"; // .btn's display beats the hidden attribute
    }

    let open = false;

    function show() {
        if (open) return;
        open = true;
        gsap.to(overlay, { autoAlpha: 1, duration: 0.3, ease: "power2.out" });
        gsap.fromTo(modal, { scale: 0.95 },
            { autoAlpha: 1, scale: 1, duration: 0.4, ease: "power4.out" });
    }

    function hide() {
        if (!open) return;
        open = false;
        gsap.to(overlay, { autoAlpha: 0, duration: 0.3, ease: "power2.out" });
        gsap.to(modal, { autoAlpha: 0, scale: 0.95, duration: 0.3, ease: "power2.out" });
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

    // the tour (js/tour.js) reveals this button when it registers itself
    window.CurveCut.about = { show, hide, tourBtn };
})();
