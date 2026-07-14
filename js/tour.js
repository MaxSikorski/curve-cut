/* Curve Cut — first-visit guided tour (v1.6, demo edition).
   A spotlight veil + draggable floating card walks new visitors through the
   flow — and actually DOES the things it describes: flies the camera, draws
   a real curve cut, applies it, then opens Big Print (Max, 2026-07-13).
   Every demo action goes through the same code paths a user would trigger,
   is best-effort (guarded), and is undone when the tour ends. Auto-opens on
   first visit (localStorage gate); relaunch any time from the "i" popup. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const STORE_KEY = "curvecut-tour"; // unset = never seen · "done" · "always"

    // what the demo changed, so end() can put the model back
    const demo = { previewOpen: false, cutApplied: false, bigPrintOpen: false };

    // ------------------------------------------------------- demo actions

    const click = (id) => {
        const el = document.getElementById(id);
        if (el && !el.disabled) el.click();
    };

    function flyFront() {
        const btn = document.querySelector('#view-dock .view-btn[data-view="front"]');
        if (btn) btn.click();
    }

    /* A real S-curve through the model, exactly the shape the pen tool would
       hand over: CC.spline + the spline-ready event -> live ribbon preview. */
    function demoSplinePreview() {
        const model = CC.getModel();
        if (!model || CC.spline || demo.cutApplied) return;
        model.geometry.computeBoundingBox();
        const bb = model.geometry.boundingBox;
        const size = new THREE.Vector3();
        bb.getSize(size);
        const cx = (bb.min.x + bb.max.x) / 2;
        const sway = Math.max(size.x * 0.12, 2);
        const V = (x, y, z) => new THREE.Vector3(x, y, z);
        CC.spline = {
            points: [
                { a: V(cx - sway / 2, bb.max.y + size.y * 0.25, 0),
                  hIn: null, hOut: V(cx + sway, bb.max.y * 0.6, 0) },
                { a: V(cx + sway / 2, bb.min.y - size.y * 0.25, 0),
                  hIn: V(cx - sway, bb.max.y * 0.4, 0), hOut: null },
            ],
            normal: V(0, 0, 1), // matches the Front view step
            planePoint: V(cx, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2),
        };
        window.dispatchEvent(new CustomEvent("curvecut:spline-ready"));
        demo.previewOpen = true;
    }

    function demoApplyCut() {
        if (!demo.previewOpen || !CC.cutFlow.isEngineReady()) return;
        click("cut-apply");
        demo.previewOpen = false;
        demo.cutApplied = true;
    }

    function demoBigPrint() {
        // put the model back together first — Big Print wants the whole model
        if (demo.cutApplied) {
            click("undo-btn");
            demo.cutApplied = false;
        }
        if (CC.bigPrint && !CC.bigPrint.isActive() && CC.pieces.length === 1) {
            CC.bigPrint.enter();
            demo.bigPrintOpen = true;
            // scale the demo past the selected bed so real cut planes appear
            const bedW = parseFloat(document.getElementById("bp-bed-w").value) || 256;
            const size = document.getElementById("bp-size");
            size.value = String(Math.round(bedW * 1.8));
            size.dispatchEvent(new Event("input"));
        }
    }

    function undoDemo() {
        try {
            if (demo.previewOpen) { click("cut-discard"); demo.previewOpen = false; }
            if (demo.bigPrintOpen) { CC.bigPrint.exit(); demo.bigPrintOpen = false; }
            if (demo.cutApplied) { click("undo-btn"); demo.cutApplied = false; }
        } catch (err) { console.warn("tour cleanup:", err); }
    }

    // --------------------------------------------------------------- steps

    const STEPS = [
        {
            title: "Welcome to Curve Cut",
            text: "Cut 3D prints along curves — right in your browser, nothing to "
                + "install. Drop an STL, OBJ, or 3MF anywhere (or click Open Model) "
                + "and the tour continues on its own.",
            waitFor: "curvecut:model-loaded",
        },
        {
            title: "Pick your side",
            text: "Drag to orbit, scroll to zoom. These buttons snap the camera to any "
                + "side (keys 1–6 too) — we just flew you to the Front, which is where "
                + "you'd usually draw a cut from.",
            target: "#view-dock",
            action: flyFront,
        },
        {
            title: "Three ways to cut",
            text: "Draw Cut opens the cutting tools: Curve draws a freehand line, "
                + "Planar makes a straight slice with a tilt-and-rotate gizmo, Dovetail "
                + "cuts a slide-lock joint. Watch — we'll draw a curve for you.",
            target: "#draw-btn",
        },
        {
            title: "A cut, drawn for you",
            text: "That red ribbon is a real cut preview, and the two tints are the "
                + "future pieces. With the pen you'd click to add points, drag the line "
                + "to move it, ⌥-click to insert, and double-click for a sharp corner.",
            action: demoSplinePreview,
        },
        {
            title: "Make it real",
            text: "Applied! The model is now two watertight, print-ready pieces. The "
                + "Gap field leaves clearance so printed parts actually fit together — "
                + "and ⌘Z undoes any cut.",
            action: demoApplyCut,
        },
        {
            title: "Your pieces",
            text: "Every piece lands in this panel — toggle visibility or wireframe, "
                + "then export the visible ones as STL or 3MF (3MF files are much "
                + "smaller).",
            target: "#pieces-panel",
        },
        {
            title: "Print BIG",
            text: "We undid the demo cut and opened Big Print at 3× — those planes are "
                + "where your model gets sliced to fit the printer you pick. Cut & "
                + "Export produces labeled parts, connectors, and an assembly map. "
                + "Have fun!",
            target: "#bigprint-panel",
            action: demoBigPrint,
            last: true,
        },
    ];

    // ------------------------------------------------------------- markup

    const veil = document.createElement("div");
    veil.id = "tour-veil";
    veil.innerHTML = `<div id="tour-spot"></div>`;
    const card = document.createElement("div");
    card.id = "tour-card";
    card.className = "glass";
    card.innerHTML = `
        <button id="tour-close" aria-label="Skip the tour">&times;</button>
        <div class="tour-label" id="tour-label"></div>
        <h3 id="tour-title"></h3>
        <p id="tour-text"></p>
        <label class="sc-check" id="tour-always-row">
            <input type="checkbox" id="tour-always"> Show this tour on every visit
        </label>
        <div class="tour-footer">
            <div class="tour-dots" id="tour-dots"></div>
            <div class="tour-nav">
                <button class="view-btn" id="tour-back">Back</button>
                <button class="view-btn view-btn-primary" id="tour-next">Next</button>
            </div>
        </div>`;
    document.body.append(veil, card);

    const spot = veil.querySelector("#tour-spot");
    const els = {
        label: card.querySelector("#tour-label"),
        title: card.querySelector("#tour-title"),
        text: card.querySelector("#tour-text"),
        dots: card.querySelector("#tour-dots"),
        back: card.querySelector("#tour-back"),
        next: card.querySelector("#tour-next"),
        close: card.querySelector("#tour-close"),
        alwaysRow: card.querySelector("#tour-always-row"),
        always: card.querySelector("#tour-always"),
    };

    let active = false;
    let step = -1;
    let waitListener = null;
    let dragged = false;      // user moved the card — respect it this step
    const actionsDone = new Set(); // demo actions run once, forward only

    // ------------------------------------------------- dragging (Max #1)

    let drag = null;
    card.addEventListener("pointerdown", (e) => {
        if (e.target.closest("button, input, label, a")) return;
        drag = { dx: e.clientX - card.offsetLeft, dy: e.clientY - card.offsetTop };
        card.setPointerCapture(e.pointerId);
        card.classList.add("dragging");
    });
    card.addEventListener("pointermove", (e) => {
        if (!drag) return;
        dragged = true;
        card.style.left = `${Math.min(Math.max(e.clientX - drag.dx, 8), window.innerWidth - card.offsetWidth - 8)}px`;
        card.style.top = `${Math.min(Math.max(e.clientY - drag.dy, 8), window.innerHeight - card.offsetHeight - 8)}px`;
    });
    const endDrag = () => { drag = null; card.classList.remove("dragging"); };
    card.addEventListener("pointerup", endDrag);
    card.addEventListener("pointercancel", endDrag);

    // ------------------------------------------------------------ placing

    // most anchors are position:fixed (offsetParent is null there) —
    // test computed style + a real on-screen box instead
    const visible = (el) => {
        if (!el) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden"
            || parseFloat(cs.opacity) < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    function place() {
        const s = STEPS[step];
        const target = s.target ? document.querySelector(s.target) : null;
        const spotOn = visible(target);

        if (spotOn) {
            const r = target.getBoundingClientRect();
            const pad = 10;
            spot.style.display = "block";
            spot.style.left = `${r.left - pad}px`;
            spot.style.top = `${r.top - pad}px`;
            spot.style.width = `${r.width + 2 * pad}px`;
            spot.style.height = `${r.height + 2 * pad}px`;
        } else {
            spot.style.display = "none";
        }
        if (dragged) return; // the user parked the card — leave it there

        if (spotOn) {
            const r = target.getBoundingClientRect();
            const ch = card.offsetHeight, cw = card.offsetWidth;
            let top = r.bottom + 28;
            if (top + ch > window.innerHeight - 16) top = r.top - ch - 28;
            let left = r.left + r.width / 2 - cw / 2;
            left = Math.min(Math.max(left, 16), window.innerWidth - cw - 16);
            top = Math.min(Math.max(top, 16), window.innerHeight - ch - 16);
            card.style.left = `${left}px`;
            card.style.top = `${top}px`;
        } else {
            // lower third, so the hero's Open Model button stays reachable
            card.style.left = `${Math.max((window.innerWidth - card.offsetWidth) / 2, 8)}px`;
            card.style.top = `${Math.max(window.innerHeight * 0.62 - card.offsetHeight / 2, 8)}px`;
        }
    }

    // ------------------------------------------------------------- engine

    function show(i) {
        const forward = i > step;
        step = Math.min(Math.max(i, 0), STEPS.length - 1);
        const s = STEPS[step];
        dragged = false;

        // demo actions fire once, only moving forward, always best-effort
        if (forward && s.action && !actionsDone.has(step)) {
            actionsDone.add(step);
            try { s.action(); } catch (err) { console.warn("tour demo:", err); }
        }

        els.label.textContent = `Step ${step + 1} of ${STEPS.length}`;
        els.title.textContent = s.title;
        els.text.textContent = s.text;
        els.back.style.visibility = step === 0 ? "hidden" : "visible";
        els.alwaysRow.style.display = s.last ? "flex" : "none"; // .sc-check is display:flex
        if (s.last) els.always.checked = localStorage.getItem(STORE_KEY) === "always";

        // waiting steps advance themselves; a loaded model turns them normal
        if (waitListener) {
            window.removeEventListener(waitListener.event, waitListener.fn);
            waitListener = null;
        }
        const waiting = s.waitFor && !CC.getModel();
        els.next.textContent = s.last ? "Done" : waiting ? "Waiting…" : "Next";
        els.next.disabled = !!waiting;
        if (waiting) {
            const fn = () => setTimeout(() => { if (active && STEPS[step] === s) show(step + 1); }, 700);
            window.addEventListener(s.waitFor, fn, { once: true });
            waitListener = { event: s.waitFor, fn };
        }

        els.dots.innerHTML = STEPS.map((_, d) =>
            `<span class="tour-dot${d === step ? " on" : ""}"></span>`).join("");
        place();
        // targets revealed by entrance tweens (or demo actions) aren't visible
        // on the first pass — place again once things have settled
        setTimeout(() => { if (active && STEPS[step] === s) place(); }, 700);
    }

    function start() {
        if (active) return;
        CC.about && CC.about.hide();
        active = true;
        actionsDone.clear();
        veil.style.display = "block";
        card.style.display = "block";
        gsap.fromTo([veil, card], { opacity: 0 },
            { opacity: 1, duration: 0.4, ease: "power2.out" });
        show(0);
    }

    function end() {
        if (!active) return;
        active = false;
        if (waitListener) {
            window.removeEventListener(waitListener.event, waitListener.fn);
            waitListener = null;
        }
        undoDemo(); // the tour leaves the model exactly as it found it
        localStorage.setItem(STORE_KEY, els.always.checked ? "always" : "done");
        gsap.to([veil, card], {
            opacity: 0, duration: 0.3, ease: "power2.out",
            onComplete: () => { veil.style.display = "none"; card.style.display = "none"; },
        });
    }

    els.next.addEventListener("click", () =>
        STEPS[step].last ? end() : show(step + 1));
    els.back.addEventListener("click", () => show(step - 1));
    els.close.addEventListener("click", end);
    window.addEventListener("resize", () => { if (active) place(); });
    window.addEventListener("keydown", (e) => {
        if (active && e.key === "Escape") { e.stopPropagation(); end(); }
    }, true);

    // relaunch from the "i" popup
    if (CC.about) {
        CC.about.tourBtn.hidden = false;
        CC.about.tourBtn.addEventListener("click", start);
    }

    // auto-open on first visit (or every visit if the visitor opted in)
    const seen = localStorage.getItem(STORE_KEY);
    if (!seen || seen === "always") {
        setTimeout(start, 1400); // let the hero entrance finish first
    }

    CC.tour = { start, end, isActive: () => active };
})();
