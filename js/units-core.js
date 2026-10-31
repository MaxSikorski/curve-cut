/* Curve Cut — DOM-free units/orientation math. */

((root) => {
    "use strict";

    const CC = root.CurveCut = root.CurveCut || {};
    const UNIT_TO_MM = Object.freeze({ mm: 1, in: 25.4, cm: 10 });

    function unitFactor(unit) {
        return Object.prototype.hasOwnProperty.call(UNIT_TO_MM, unit)
            ? UNIT_TO_MM[unit] : null;
    }

    function conversionScale(fromUnit, toUnit) {
        const from = unitFactor(fromUnit);
        const to = unitFactor(toUnit);
        return from && to ? to / from : null;
    }

    function calibrationScale(current, target) {
        current = Number(current);
        target = Number(target);
        return isFinite(current) && isFinite(target) && current > 0 && target > 0
            ? target / current : null;
    }

    function dimensionsArray(dimensions) {
        if (Array.isArray(dimensions)) return dimensions;
        if (!dimensions) return [];
        return [
            dimensions.width === undefined ? dimensions.x : dimensions.width,
            dimensions.depth === undefined ? dimensions.z : dimensions.depth,
            dimensions.height === undefined ? dimensions.y : dimensions.height,
        ];
    }

    function suspicion(dimensions) {
        const sides = dimensionsArray(dimensions).map(Number).filter(
            (n) => isFinite(n) && n >= 0);
        if (!sides.length) return null;
        const longest = Math.max(...sides);
        if (longest < 20) return { kind: "suspicious-inches", longest };
        if (longest > 3000) return { kind: "suspicious-large", longest };
        return null;
    }

    function rotateX(vector, angle) {
        const x = vector[0], y = vector[1], z = vector[2];
        const c = Math.cos(angle), s = Math.sin(angle);
        return [x, y * c - z * s, y * s + z * c];
    }

    function describeUpAxis(axis) {
        if (axis !== "y" && axis !== "z") return null;
        const rotationX = axis === "z" ? -Math.PI / 2 : 0;
        return {
            axis,
            rotationX,
            sourceUp: axis === "z" ? [0, 0, 1] : [0, 1, 0],
            mapVector(vector) { return rotateX(vector, rotationX); },
        };
    }

    function upAxisDelta(fromAxis, toAxis) {
        const from = describeUpAxis(fromAxis);
        const to = describeUpAxis(toAxis);
        return from && to ? to.rotationX - from.rotationX : null;
    }

    CC.UnitsCore = {
        UNIT_TO_MM,
        unitFactor,
        conversionScale,
        calibrationScale,
        suspicion,
        describeUpAxis,
        upAxisDelta,
    };
})(typeof window === "undefined" ? globalThis : window);
