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
    const trap = CC.a11y.makeFocusTrap(modal);
    let open = false;
    let nudged = false;

    function modelState() {
        const model = CC.pieces.length === 1 ? CC.pieces[0] : null;
        if (!model) return null;
        model.userData.units = model.userData.units || { fileUnit: "mm", upAxis: "y" };
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
        trigger.disabled = !pristine;
        trigger.title = loaded && !pristine ? "reload the model to change units" : "Units & Orientation";
        if (!pristine && open) hide();
    }

    function refuseBusy() {
        if (!CC.ops.busy()) return false;
        CC.toast("An operation is still running — check Units when it finishes.");
        return true;
    }

    function show() {
        if (open) return;
        if (refuseBusy()) return;
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

    function applyGeometryChange(name, mutate, nextState) {
        if (refuseBusy()) return false;
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
            { fileUnit: unit });
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
            {});
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
