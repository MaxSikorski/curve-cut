/* Curve Cut — collapse/expand chevron for the bottom config panels (Max, 2026-07-17)
   Feature request #15: the config panels (Big Print / simple-cut / connector) can
   crowd out the 3D model. One shared helper wires a small glass chevron onto a
   panel's top edge: click slides the panel down (gsap y-tween) until only a slim
   strip with the chevron pokes above the screen's bottom edge, click again
   restores it. Purely visual/UI state — collapsing never touches cut/engine
   logic, and each mode's own show-tween force-expands via .reset(). */

(() => {
    "use strict";

    const CC = window.CurveCut;

    const STRIP = 34; // px of the panel left visible above the viewport bottom when collapsed

    CC.makeCollapsible = function makeCollapsible(panelEl) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "icon-btn glass panel-collapse-btn";
        btn.title = "Collapse panel";
        btn.setAttribute("aria-label", "Collapse panel");
        btn.setAttribute("aria-expanded", "true");
        btn.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
        panelEl.appendChild(btn);

        // gsap owns "transform" on this element from here on — bake the CSS
        // centering (left:50% + translateX(-50%)) into gsap's own state so a
        // later y-only tween doesn't clobber the horizontal centering.
        gsap.set(panelEl, { xPercent: -50 });

        let collapsed = false;

        function setState(next) {
            collapsed = next;
            btn.classList.toggle("collapsed", collapsed);
            btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
            const label = collapsed ? "Expand panel" : "Collapse panel";
            btn.setAttribute("aria-label", label);
            btn.title = label;
        }

        btn.addEventListener("click", () => {
            // overwrite:auto kills a still-running entry tween's competing y
            // writes — otherwise a click mid-entry desyncs state from visuals
            if (collapsed) {
                gsap.to(panelEl, { y: 0, duration: 0.4, ease: "power2.out", overwrite: "auto" });
            } else {
                // measure live — panels reflow (different rows/modes), so the
                // slide distance is computed fresh at collapse time
                const rect = panelEl.getBoundingClientRect();
                const dy = window.innerHeight - STRIP - rect.top;
                gsap.to(panelEl, { y: dy, duration: 0.4, ease: "power2.out", overwrite: "auto" });
            }
            setState(!collapsed);
        });

        return {
            // force back to expanded without a fight — the caller's own show
            // tween (fromTo y:16 -> 0) drives the visual slide; this just
            // resyncs the button state so a stale collapse doesn't linger
            reset() { setState(false); },
        };
    };
})();
