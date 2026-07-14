/* Curve Cut — pen tool (v1.1 UX overhaul)
   Click = auto-smooth point (Catmull-Rom handles, no kinks out of the box).
   Drag empty space while placing = shape the handles yourself.
   Drag the LINE = move the whole spline. Alt+click the line = insert a point
   without changing the shape. Double-click an anchor = toggle sharp corner.
   Hovering shows handles and grows targets. Zoom/pan stay live while drawing.

   Anchors live in WORLD SPACE on a plane locked at draw start; the SVG overlay
   is a projection, so the curve stays glued to the model. Math: js/pen-core.js. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const { camera, controls, canvas } = CC;
    const Pen = window.PenCore;

    const svg = document.getElementById("draw-layer");
    const pathEl = document.getElementById("spline-path");
    const skeletonEl = document.getElementById("spline-skeleton");
    const handlesEl = document.getElementById("spline-handles");
    const anchorsEl = document.getElementById("spline-anchors");
    const actionDock = document.getElementById("action-dock");
    const drawDock = document.getElementById("draw-dock");
    const drawHint = document.getElementById("draw-hint");
    const viewDock = document.getElementById("view-dock");

    const raycaster = new THREE.Raycaster();
    const HIT_PX = 14;        // anchor/handle hit radius
    const CURVE_HIT_PX = 9;   // distance to count as "on the line"
    const DRAG_PX = 4;        // movement before a click becomes a drag
    const CURVE_SAMPLES = 16; // per-segment samples for line hit-testing

    let active = false;
    let plane = null;
    let lockNormal = null;
    let points = [];          // see js/pen-core.js for the point shape
    let selected = -1;
    let hovered = null;       // {type:"anchor"|"curve", idx|segIdx}
    let drag = null;          // {type, idx, sx, sy, moved, last}

    // ------------------------------------------------------------ projection

    function screenToPlane(px, py) {
        const ndc = new THREE.Vector2(
            (px / window.innerWidth) * 2 - 1,
            -(py / window.innerHeight) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        const out = new THREE.Vector3();
        return raycaster.ray.intersectPlane(plane, out) ? out : null;
    }

    function toScreen(v) {
        const p = v.clone().project(camera);
        return {
            x: (p.x + 1) / 2 * window.innerWidth,
            y: (1 - p.y) / 2 * window.innerHeight,
        };
    }

    // --------------------------------------------------------- enter / exit

    function enter() {
        if (!CC.getModel() || active) return;
        active = true;
        CC.drawActive = true;
        points = [];
        selected = -1;
        hovered = null;
        CC.spline = null;
        window.dispatchEvent(new CustomEvent("curvecut:spline-cleared"));

        lockNormal = camera.getWorldDirection(new THREE.Vector3()).negate();
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(lockNormal, CC.getModelCenter());

        controls.enableRotate = false;   // zoom + pan stay live
        svg.classList.add("active");
        svg.style.cursor = "crosshair";

        gsap.to([viewDock, actionDock], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        gsap.fromTo([drawDock, drawHint], { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
        redraw();
    }

    function exit(keepSpline, restoreDocks = true) {
        if (!active) return;
        active = false;
        CC.drawActive = false;
        controls.enableRotate = true;
        svg.classList.remove("active");
        drag = null;
        selected = -1;
        hovered = null;
        if (!keepSpline) points = [];

        gsap.to([drawDock, drawHint], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        // skip restore when switching cut modes or after a scene reset
        if (restoreDocks && CC.pieces.length) {
            gsap.fromTo([viewDock, actionDock], { y: 10 },
                { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
        }
        redraw();
    }

    function done() {
        if (points.length < 2) {
            CC.toast("Draw at least two points first.");
            return;
        }
        CC.spline = {
            points: points.map((p) => ({
                a: p.a.clone(),
                hIn: p.hIn ? p.hIn.clone() : null,
                hOut: p.hOut ? p.hOut.clone() : null,
            })),
            normal: lockNormal.clone(),
            planePoint: CC.getModelCenter(),
        };
        exit(false); // the 3D preview takes over from the SVG overlay
        window.dispatchEvent(new CustomEvent("curvecut:spline-ready"));
    }

    // -------------------------------------------------------------- drawing

    function redraw() {
        if (points.length < 2) {
            pathEl.setAttribute("d", "");
            skeletonEl.setAttribute("d", "");
        } else {
            const s0 = toScreen(points[0].a);
            let d = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)}`;
            let skel = `M ${s0.x.toFixed(1)} ${s0.y.toFixed(1)}`;
            for (let i = 1; i < points.length; i++) {
                const p0 = points[i - 1], p1 = points[i];
                const c1 = toScreen(p0.hOut || p0.a);
                const c2 = toScreen(p1.hIn || p1.a);
                const a1 = toScreen(p1.a);
                d += ` C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${a1.x.toFixed(1)} ${a1.y.toFixed(1)}`;
                skel += ` L ${a1.x.toFixed(1)} ${a1.y.toFixed(1)}`;
            }
            pathEl.setAttribute("d", d);
            skeletonEl.setAttribute("d", active ? skel : "");
        }

        if (!active) {
            anchorsEl.innerHTML = "";
            handlesEl.innerHTML = "";
            return;
        }

        anchorsEl.innerHTML = points.map((p, i) => {
            const s = toScreen(p.a);
            const isSel = i === selected;
            const isHov = hovered && hovered.type === "anchor" && hovered.idx === i;
            const r = isSel ? 6.5 : isHov ? 6 : 4.5;
            const cls = [isSel ? "selected" : "", p.corner ? "corner" : ""].join(" ").trim();
            return `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${r}"${cls ? ` class="${cls}"` : ""}/>`;
        }).join("");

        // handles for the selected AND the hovered anchor
        const shown = new Set();
        if (selected >= 0) shown.add(selected);
        if (hovered && hovered.type === "anchor") shown.add(hovered.idx);
        let h = "";
        for (const idx of shown) {
            const p = points[idx];
            if (!p) continue;
            const a = toScreen(p.a);
            for (const key of ["hIn", "hOut"]) {
                if (!p[key]) continue;
                const s = toScreen(p[key]);
                h += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${s.x.toFixed(1)}" y2="${s.y.toFixed(1)}"/>`;
                h += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="3.5"/>`;
            }
        }
        handlesEl.innerHTML = h;
    }

    // ------------------------------------------------------------- hit test

    function hitHandles(px, py) {
        const candidates = new Set();
        if (selected >= 0) candidates.add(selected);
        if (hovered && hovered.type === "anchor") candidates.add(hovered.idx);
        for (const idx of candidates) {
            const p = points[idx];
            if (!p) continue;
            for (const [key, type] of [["hIn", "in"], ["hOut", "out"]]) {
                if (!p[key]) continue;
                const s = toScreen(p[key]);
                if (Math.hypot(s.x - px, s.y - py) < HIT_PX) return { type, idx };
            }
        }
        return null;
    }

    function hitAnchor(px, py) {
        for (let i = points.length - 1; i >= 0; i--) {
            const s = toScreen(points[i].a);
            if (Math.hypot(s.x - px, s.y - py) < HIT_PX) return { type: "anchor", idx: i };
        }
        return null;
    }

    function hitCurve(px, py) {
        let best = null;
        for (let seg = 0; seg < points.length - 1; seg++) {
            const samples = Pen.sampleSegment(points[seg], points[seg + 1], CURVE_SAMPLES)
                .map(toScreen);
            for (let i = 0; i < samples.length - 1; i++) {
                const r = Pen.distToSegment2D(px, py,
                    samples[i].x, samples[i].y, samples[i + 1].x, samples[i + 1].y);
                if (r.dist < CURVE_HIT_PX && (!best || r.dist < best.dist)) {
                    best = { type: "curve", segIdx: seg, t: (i + r.t) / CURVE_SAMPLES, dist: r.dist };
                }
            }
        }
        return best;
    }

    // ------------------------------------------------------------- pointers

    svg.addEventListener("pointerdown", (e) => {
        if (!active) return;
        if (e.button !== 0) {
            canvas.dispatchEvent(new PointerEvent(e.type, e)); // pan passthrough
            return;
        }
        svg.setPointerCapture(e.pointerId);
        const base = { sx: e.clientX, sy: e.clientY, moved: false };

        const handle = hitHandles(e.clientX, e.clientY);
        if (handle) {
            selected = handle.idx;
            if (e.altKey) points[handle.idx].broken = true;
            drag = { ...handle, ...base };
            redraw();
            return;
        }

        const anchor = hitAnchor(e.clientX, e.clientY);
        if (anchor) {
            selected = anchor.idx;
            drag = { ...anchor, ...base };
            redraw();
            return;
        }

        const curve = points.length > 1 ? hitCurve(e.clientX, e.clientY) : null;
        if (curve) {
            if (e.altKey) {
                // insert a shape-preserving point and let the user drag it
                const fresh = Pen.insertPoint(points, curve.segIdx, curve.t);
                selected = points.indexOf(fresh);
                drag = { type: "anchor", idx: selected, ...base };
            } else {
                // drag the whole spline
                drag = { type: "curve", last: screenToPlane(e.clientX, e.clientY), ...base };
                svg.style.cursor = "grabbing";
            }
            redraw();
            return;
        }

        // empty space: add an auto-smooth point (drag to shape it manually)
        const w = screenToPlane(e.clientX, e.clientY);
        if (!w) return;
        points.push({ a: w, hIn: null, hOut: null, corner: false, custom: false, broken: false });
        Pen.refreshAutoHandles(points);
        selected = points.length - 1;
        drag = { type: "new", idx: selected, ...base };
        redraw();
    });

    svg.addEventListener("pointermove", (e) => {
        if (!active) return;

        if (!drag) { // hover feedback
            const over = hitHandles(e.clientX, e.clientY) || hitAnchor(e.clientX, e.clientY)
                || (points.length > 1 ? hitCurve(e.clientX, e.clientY) : null);
            const next = over && over.type === "anchor" ? { type: "anchor", idx: over.idx }
                : over && over.type === "curve" ? { type: "curve" } : null;
            svg.style.cursor = over
                ? (over.type === "curve" ? "grab" : "pointer")
                : "crosshair";
            const changed = JSON.stringify(next) !== JSON.stringify(hovered);
            hovered = next;
            if (changed) redraw();
            return;
        }

        if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < DRAG_PX) return;
        drag.moved = true;

        const w = screenToPlane(e.clientX, e.clientY);
        if (!w) return;

        if (drag.type === "curve") {
            if (drag.last) Pen.translateAll(points, w.clone().sub(drag.last));
            drag.last = w;
        } else if (drag.type === "new" || drag.type === "out") {
            const p = points[drag.idx];
            p.custom = true;
            p.corner = false;
            p.hOut = w;
            if (!p.broken) p.hIn = p.a.clone().multiplyScalar(2).sub(w);
        } else if (drag.type === "in") {
            const p = points[drag.idx];
            p.custom = true;
            p.corner = false;
            p.hIn = w;
            if (!p.broken) p.hOut = p.a.clone().multiplyScalar(2).sub(w);
        } else if (drag.type === "anchor") {
            const p = points[drag.idx];
            const delta = w.clone().sub(p.a);
            p.a.copy(w);
            if (p.hIn) p.hIn.add(delta);
            if (p.hOut) p.hOut.add(delta);
            Pen.refreshAutoHandles(points); // keep auto neighbors fair
        }
        redraw();
    });

    const endDrag = () => {
        if (drag && drag.type === "curve") svg.style.cursor = "grab";
        drag = null;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    // double-click an anchor toggles sharp corner <-> smooth
    svg.addEventListener("dblclick", (e) => {
        if (!active) return;
        const anchor = hitAnchor(e.clientX, e.clientY);
        if (!anchor) return;
        const p = points[anchor.idx];
        p.corner = !p.corner;
        p.custom = false;
        p.broken = false;
        Pen.refreshAutoHandles(points);
        selected = anchor.idx;
        redraw();
    });

    // wheel zoom passes through the overlay to OrbitControls
    svg.addEventListener("wheel", (e) => {
        if (active) canvas.dispatchEvent(new WheelEvent(e.type, e));
    }, { passive: true });
    svg.addEventListener("contextmenu", (e) => { if (active) e.preventDefault(); });

    // ------------------------------------------------------------- keyboard

    window.addEventListener("keydown", (e) => {
        if (!active) return;
        if (e.key === "Escape") { exit(false); return; }
        if (e.key === "Enter") { done(); return; }
        if (["d", "D", "Backspace", "Delete"].includes(e.key) && selected >= 0) {
            e.preventDefault();
            points.splice(selected, 1);
            selected = -1;
            hovered = null;
            Pen.refreshAutoHandles(points);
            redraw();
        }
    });

    // ----------------------------------------------------------------- wire

    CC.pen = { enter, exit, isActive: () => active }; // driven by js/cutmodes.js
    document.getElementById("draw-cancel").addEventListener("click", () => exit(false));
    document.getElementById("draw-done").addEventListener("click", done);
    document.getElementById("draw-clear").addEventListener("click", () => {
        points = [];
        selected = -1;
        hovered = null;
        redraw();
    });

    // keep the projection glued to the model on zoom/pan/orbit/resize
    controls.addEventListener("change", () => { if (points.length) redraw(); });
    window.addEventListener("resize", () => { if (points.length) redraw(); });

    // a reset or fresh model load while drawing exits draw mode cleanly
    window.addEventListener("curvecut:model-loaded", () => { if (active) exit(false); });
})();
