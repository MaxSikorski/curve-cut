/* Curve Cut — pen tool math (v1.1)
   DOM-free helpers behind js/pen.js: auto-smooth handle computation
   (Catmull-Rom style), shape-preserving point insertion (de Casteljau),
   rigid spline translation, and curve sampling/hit math.
   Tested headlessly by tests/pen-test.html via tools/check_pen.py.

   Point shape: { a, hIn, hOut: THREE.Vector3|null,
                  corner: bool   — user forced a sharp point (no handles)
                  custom: bool   — user shaped handles manually; never auto-recompute } */

(() => {
    "use strict";

    /* Catmull-Rom-flavored handles for point i from its neighbors, so a plain
       click lands on a fair curve instead of a kink. */
    function autoHandles(points, i) {
        const p = points[i];
        const prev = points[i - 1] || null;
        const next = points[i + 1] || null;

        if (!prev && !next) { p.hIn = null; p.hOut = null; return; }

        // tangent direction: through-neighbor chord (or the single neighbor)
        const from = prev ? prev.a : p.a;
        const to = next ? next.a : p.a;
        const tangent = to.clone().sub(from);
        if (tangent.lengthSq() < 1e-12) { p.hIn = null; p.hOut = null; return; }
        tangent.normalize();

        const lenIn = prev ? p.a.distanceTo(prev.a) / 3 : 0;
        const lenOut = next ? p.a.distanceTo(next.a) / 3 : 0;
        p.hIn = prev ? p.a.clone().addScaledVector(tangent, -lenIn) : null;
        p.hOut = next ? p.a.clone().addScaledVector(tangent, lenOut) : null;
    }

    /* Recompute handles for every point the user hasn't shaped or sharpened.
       Call after any add/move/delete so the curve stays fair as it changes. */
    function refreshAutoHandles(points) {
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (p.corner) { p.hIn = null; p.hOut = null; continue; }
            if (p.custom) continue;
            autoHandles(points, i);
        }
    }

    // cubic bezier point for segment (p0 -> p1) at t
    function bezierAt(p0, p1, t) {
        const a0 = p0.a, c1 = p0.hOut || p0.a, c2 = p1.hIn || p1.a, a1 = p1.a;
        const u = 1 - t;
        return new THREE.Vector3(
            u * u * u * a0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * a1.x,
            u * u * u * a0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * a1.y,
            u * u * u * a0.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * a1.z
        );
    }

    /* Insert a point on segment segIdx at parameter t WITHOUT changing the
       curve's shape (de Casteljau subdivision). Neighbors' handles become
       custom so the auto-smoother never undoes the exact split. */
    function insertPoint(points, segIdx, t) {
        const p0 = points[segIdx], p1 = points[segIdx + 1];
        const P0 = p0.a, P1 = p0.hOut || p0.a, P2 = p1.hIn || p1.a, P3 = p1.a;

        const lerp = (a, b) => a.clone().lerp(b, t);
        const Q0 = lerp(P0, P1), Q1 = lerp(P1, P2), Q2 = lerp(P2, P3);
        const R0 = lerp(Q0, Q1), R1 = lerp(Q1, Q2);
        const S = lerp(R0, R1); // the point on the curve

        p0.hOut = Q0; p0.custom = true;
        p1.hIn = Q2; p1.custom = true;
        const fresh = { a: S, hIn: R0, hOut: R1, corner: false, custom: true };
        points.splice(segIdx + 1, 0, fresh);
        return fresh;
    }

    /* Move the whole spline rigidly by a world-space delta (drag the line). */
    function translateAll(points, delta) {
        for (const p of points) {
            p.a.add(delta);
            if (p.hIn) p.hIn.add(delta);
            if (p.hOut) p.hOut.add(delta);
        }
    }

    // sample one segment into n+1 points (t = 0..1 inclusive)
    function sampleSegment(p0, p1, n) {
        const out = [];
        for (let s = 0; s <= n; s++) out.push(bezierAt(p0, p1, s / n));
        return out;
    }

    /* Distance from a 2D point to a 2D segment, plus the projection parameter. */
    function distToSegment2D(px, py, ax, ay, bx, by) {
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        let t = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
        t = Math.max(0, Math.min(1, t));
        const cx = ax + t * dx, cy = ay + t * dy;
        return { dist: Math.hypot(px - cx, py - cy), t };
    }

    window.PenCore = {
        autoHandles, refreshAutoHandles, bezierAt,
        insertPoint, translateAll, sampleSegment, distToSegment2D,
    };
})();
