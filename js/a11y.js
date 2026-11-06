/* Curve Cut — shared accessibility helpers (v2.0.2 roadmap item 3).
   One tiny module so about/donate/simplify/tour don't each reinvent a focus
   trap, and so GSAP-driven modules can ask "is reduced motion on?" without
   each wiring their own matchMedia listener. Loads right after app.js
   (before every dialog module) so CC.a11y exists by the time they need it. */

(() => {
    "use strict";

    const CC = window.CurveCut;

    const FOCUSABLE =
        'a[href], button:not([disabled]), input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function focusables(container) {
        return Array.from(container.querySelectorAll(FOCUSABLE)).filter((el) => {
            if (el.offsetParent === null && el !== document.activeElement) return false;
            // offsetParent stays non-null for visibility:hidden (only display:none
            // clears it) — the tour's Back button hides this way on step 1
            const cs = getComputedStyle(el);
            return cs.visibility !== "hidden";
        });
    }

    /* Wraps a dialog-like element. activate() remembers whatever had focus
       before the dialog opened, moves focus in (first focusable child, or
       the container itself as a fallback via tabindex="-1"), and traps
       Tab/Shift+Tab inside. deactivate() drops the trap and restores focus.
       Callers keep driving their own show/hide animations and Escape
       handling — this only manages focus. */
    function makeFocusTrap(container) {
        // fallback focus target if the dialog has no focusable children
        if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");

        let previouslyFocused = null;
        let onKeydown = null;
        let pendingFocus = 0;

        function activate() {
            previouslyFocused = document.activeElement;
            // dialogs animate in via gsap autoAlpha, so the container is
            // still visibility:hidden right now and focus() would silently
            // no-op — wait two frames for the first render to flip it
            cancelAnimationFrame(pendingFocus);
            pendingFocus = requestAnimationFrame(() => {
                pendingFocus = requestAnimationFrame(() => {
                    if (!onKeydown) return; // closed again before we got in
                    const list = focusables(container);
                    (list[0] || container).focus({ preventScroll: true });
                });
            });

            onKeydown = (e) => {
                if (e.key !== "Tab") return;
                const current = focusables(container);
                if (!current.length) { e.preventDefault(); return; }
                const first = current[0], last = current[current.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            };
            container.addEventListener("keydown", onKeydown);
        }

        function deactivate() {
            cancelAnimationFrame(pendingFocus);
            if (onKeydown) {
                container.removeEventListener("keydown", onKeydown);
                onKeydown = null;
            }
            if (previouslyFocused && document.body.contains(previouslyFocused)) {
                previouslyFocused.focus({ preventScroll: true });
            }
            previouslyFocused = null;
        }

        return { activate, deactivate };
    }

    // -------------------------------------------------------- reduced motion

    const reduceQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let motionOK = !reduceQuery.matches;
    reduceQuery.addEventListener("change", (e) => { motionOK = !e.matches; });

    /* Duration helper for GSAP tweens: pass the intended duration, get 0
       back when the visitor asked for reduced motion. The tween still runs
       (state still changes, onComplete still fires) — it's just instant. */
    function dur(d) { return motionOK ? d : 0; }

    CC.a11y = { makeFocusTrap, dur, motionOK: () => motionOK };
})();
