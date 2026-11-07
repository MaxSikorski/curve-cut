/* Curve Cut — passive Units & Orientation panel. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const Core = CC.UnitsCore;
    const trigger = document.getElementById("units-trigger");
    const overlay = document.getElementById("units-overlay");
    const modal = document.getElementById("units-modal");
    const dimensions = document.getElementById("units-dimensions");
    const target = document.getElementById("units-target");
    const axisSelect = document.getElementById("units-cal-axis");
    const resetRow = document.getElementById("units-reset-row");
    const originalSize = document.getElementById("units-original-size");
    const trap = CC.a11y.makeFocusTrap(modal);
    let open = false;
    let nudged = false;

    function modelState() {
        const model = CC.pieces.length === 1 ? CC.pieces[0] : null;
        if (!model) return null;
        model.userData.units = model.userData.units || { fileUnit: "mm", upAxis: "y" };
        if (!model.userData.importSize) {
            const size = sizeOf(model);
            model.userData.importSize = { x: size.x, y: size.y, z: size.z };
        }
        return { model, state: model.userData.units };
    }

    function sizeOf(model) {
        model.geometry.computeBoundingBox();
        const size = new THREE.Vector3();
        model.geometry.boundingBox.getSize(size);
        return size;
    }

    function updatePanel() {
        const current = modelState();
        if (!current) return;
        const size = sizeOf(current.model);
        dimensions.textContent =
            `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm`;
        const imported = current.model.userData.importSize;
        const format = (value) => Number(value.toFixed(3)).toString();
        originalSize.textContent = `Original file: ${format(imported.x)} × ${format(imported.z)} × ${format(imported.y)}`;
        const baked = current.model.userData.bakedScale;
        resetRow.hidden = Math.abs((current.model.userData.unitsFactor || 1) - 1) <= 1e-9
            || (baked !== undefined && Math.abs(baked - 1) > 1e-9);
        for (const button of modal.querySelectorAll("[data-unit]")) {
            const on = button.dataset.unit === current.state.fileUnit;
            button.classList.toggle("on", on);
            button.setAttribute("aria-pressed", on ? "true" : "false");
        }
        for (const button of modal.querySelectorAll("[data-up-axis]")) {
            const on = button.dataset.upAxis === current.state.upAxis;
            button.classList.toggle("on", on);
            button.setAttribute("aria-pressed", on ? "true" : "false");
        }
    }

    function updateTrigger() {
        const loaded = CC.pieces.length > 0;
        const pristine = CC.pieces.length === 1;
        const hollow = pristine && !!CC.pieces[0].userData.hollow;
        trigger.disabled = !pristine || hollow;
        trigger.title = hollow ? "undo the hollow (⌘Z) to change units or size"
            : (loaded && !pristine ? "reload the model to change units" : "Units & Orientation");
        if (!pristine && open) hide();
    }

    function refuseBusy() {
        if (!CC.ops.busy()) return false;
        CC.toast("An operation is still running — check Units when it finishes.");
        return true;
    }

    function refuseHollow() {
        if (CC.hollow && CC.hollow.isOpen()) {
            CC.toast("Close the Hollow panel first.");
            return true;
        }
        if (!CC.pieces[0] || !CC.pieces[0].userData.hollow) return false;
        CC.toast("Units and size are locked on a hollow model: undo the hollow (⌘Z) to change them.");
        return true;
    }

    function show() {
        if (open) return;
        if (refuseBusy()) return;
        if (refuseHollow()) return;
        if (CC.pieces.length !== 1) {
            CC.toast("Reload the model to change units.");
            return;
        }
        updatePanel();
        trigger.classList.remove("units-nudge");
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
        gsap.to(modal, { autoAlpha: 0, scale: 0.95,
            duration: CC.a11y.dur(0.3), ease: "power2.out" });
    }

    function applyGeometryChange(name, mutate, nextState, scale) {
        if (refuseBusy()) return false;
        if (refuseHollow()) return false;
        const current = modelState();
        if (!current) {
            CC.toast("Reload the model to change units.");
            return false;
        }
        const op = CC.ops.begin(name);
        if (!op) {
            CC.toast("Another operation is still running — one moment.");
            return false;
        }
        let geometry = null;
        try {
            geometry = current.model.geometry.clone();
            mutate(geometry);
            if (!op.alive()) {
                geometry.dispose();
                geometry = null;
                return false;
            }
            const next = new THREE.Mesh(geometry, current.model.material);
            geometry = null;
            next.name = current.model.name;
            next.visible = current.model.visible;
            next.userData = Object.assign({}, current.model.userData, {
                units: Object.assign({}, current.state, nextState),
            });
            if (scale !== undefined) {
                next.userData.unitsFactor = (current.model.userData.unitsFactor || 1) * scale;
                if (name === "reset units") next.userData.unitsFactor = 1;
            }

            CC.history.capture();
            CC.scene.remove(current.model);
            CC.scene.add(next);
            CC.pieces[0] = next;
            CC.recenterAndRefresh(next);
            window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                { detail: { source: "units" } }));
            updatePanel();
            trigger.classList.remove("units-nudge");
            hide();
            CC.toast(`Changes applied — ${dimensions.textContent}`);
            return true;
        } catch (err) {
            if (geometry) geometry.dispose();
            console.error("Units change failed:", err);
            CC.toast("That units change could not be applied.");
            return false;
        } finally {
            CC.ops.end(op);
        }
    }

    modal.querySelector("[data-units-group]").addEventListener("click", (e) => {
        const button = e.target.closest("button[data-unit]");
        const current = modelState();
        if (!button || !current || button.dataset.unit === current.state.fileUnit) return;
        const unit = button.dataset.unit;
        const scale = Core.conversionScale(current.state.fileUnit, unit);
        applyGeometryChange("units", (geometry) => geometry.scale(scale, scale, scale),
            { fileUnit: unit }, scale);
    });

    modal.querySelector("[data-axis-group]").addEventListener("click", (e) => {
        const button = e.target.closest("button[data-up-axis]");
        const current = modelState();
        if (!button || !current || button.dataset.upAxis === current.state.upAxis) return;
        const upAxis = button.dataset.upAxis;
        const angle = Core.upAxisDelta(current.state.upAxis, upAxis);
        applyGeometryChange("orientation", (geometry) => geometry.rotateX(angle),
            { upAxis });
    });

    document.getElementById("units-apply-cal").addEventListener("click", () => {
        const current = modelState();
        if (!current) return;
        const size = sizeOf(current.model);
        const currentDimension = { W: size.x, D: size.z, H: size.y }[axisSelect.value];
        const scale = Core.calibrationScale(currentDimension, target.value);
        if (scale === null) {
            CC.toast("Enter a dimension greater than zero.");
            target.focus();
            return;
        }
        applyGeometryChange("calibration", (geometry) => geometry.scale(scale, scale, scale),
            {}, scale);
    });

    document.getElementById("units-reset").addEventListener("click", () => {
        const current = modelState();
        if (!current) return;
        const scale = 1 / (current.model.userData.unitsFactor || 1);
        applyGeometryChange("reset units", (geometry) => geometry.scale(scale, scale, scale),
            { fileUnit: "mm" }, scale);
    });

    target.addEventListener("keydown", (e) => {
        if (e.key === "Enter") document.getElementById("units-apply-cal").click();
    });

    trigger.addEventListener("click", show);
    document.getElementById("units-close").addEventListener("click", hide);
    overlay.addEventListener("click", hide);
    window.addEventListener("keydown", (e) => {
        if (open && e.key === "Escape") {
            e.stopPropagation();
            hide();
        }
    }, true);

    window.addEventListener("curvecut:model-loaded", () => {
        nudged = false;
        trigger.classList.remove("units-nudge");
        if (open) hide();
    });

    window.addEventListener("curvecut:pieces-changed", (e) => {
        updateTrigger();
        const current = modelState();
        if (current && !e.detail) {
            CC.recenterAndRefresh(current.model, { recenter: false });
        }
        if (open && current) updatePanel();
    });

    function modelLoaded(options) {
        const model = CC.pieces[0];
        if (!model || CC.pieces.length !== 1) return;
        model.userData.units = {
            fileUnit: "mm",
            upAxis: options && options.upAxis === "z" ? "z" : "y",
        };
        updateTrigger();
        updatePanel();
        const suspicious = Core.suspicion(sizeOf(model));
        if (!suspicious || nudged) return;
        nudged = true;
        trigger.classList.add("units-nudge");
        if (suspicious.kind === "suspicious-inches") {
            CC.toast(`Model's longest side is only ${suspicious.longest.toFixed(1)} mm — imported in inches? Check Units.`);
        } else {
            CC.toast(`Model is ${suspicious.longest.toFixed(1)} mm across — check Units.`);
        }
    }

    updateTrigger();
    CC.units = { show, hide, modelLoaded };
})();
