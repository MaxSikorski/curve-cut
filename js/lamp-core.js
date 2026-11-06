/* Curve Cut — printable lamp filament glow swatch. */
(() => {
    "use strict";

    const SWATCH_STEPS = [1.2, 1.6, 2.4, 3.2, 4.0, 6.0];

    function buildGlowSwatch(font, opts = {}) {
        const steps = opts.steps || SWATCH_STEPS;
        const length = steps.length * 30 + (steps.length - 1) * 8 + 16;
        const core = window.CutCore;
        let solid = null;

        function add(part) {
            if (!solid) { solid = part; return; }
            try {
                const joined = solid.add(part);
                solid.delete();
                solid = joined;
            } finally {
                part.delete();
            }
        }

        function box(x, y, z, cx, cy, cz) {
            const geometry = new THREE.BoxGeometry(x, y, z);
            try {
                geometry.translate(cx, cy, cz);
                return core.toManifold(geometry);
            } finally {
                geometry.dispose();
            }
        }

        function label(text, height, x, z) {
            const result = core.buildTextSolid(font, text, {
                height, depth: 0.8,
                pos: new THREE.Vector3(x, 4.75, z),
                e1: new THREE.Vector3(1, 0, 0),
                e2: new THREE.Vector3(0, 0, -1),
                outward: new THREE.Vector3(0, 1, 0),
            });
            if (!result) throw new Error("Could not build swatch label");
            add(result.solid);
        }

        try {
            add(box(length, 4, 60, 0, 2, 0));
            steps.forEach((step, i) => {
                const x = -length / 2 + 23 + i * 38;
                add(box(30, 30.01, step, x, 18.995, 0)); // 0.01 mm into the plate: a real overlap, not touching faces
                label(step.toFixed(1), 7, x, 15 + step / 2);
            });
            label("GLOW", 5, -length / 2 + 13, 26);
            label("mm", 5, length / 2 - 9, 26);
            return core.toGeometry(solid);
        } finally {
            if (solid) solid.delete();
        }
    }

    window.LampCore = { SWATCH_STEPS, buildGlowSwatch };
})();
