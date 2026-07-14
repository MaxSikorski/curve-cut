/* Curve Cut — cut mode picker: Curve / Planar / Dovetail (roadmap v1.3)
   Curve = the pen tool (js/pen.js). Planar and Dovetail follow Orca Slicer:

   Planar — a cut plane moved by dragging its double-headed arrow (1:1 with
   the cursor), tilted with the rotation ring, or set numerically; Level
   resets. Dovetail — ONE trapezoid tongue (Depth/Width, flap-angle flare,
   groove-angle slide direction) with Orca-style X/Z arrows that move the
   tooth across the model, plus Depth/Width tolerances that shrink the
   tongue so printed pieces mate with clearance instead of binding. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const { scene, camera, canvas } = CC;

    const drawBtn = document.getElementById("draw-btn");
    const modeDock = document.getElementById("mode-dock");
    const panel = document.getElementById("simplecut-panel");
    const viewDock = document.getElementById("view-dock");
    const actionDock = document.getElementById("action-dock");
    const applyBtn = document.getElementById("sc-apply");
    const statusEl = document.getElementById("sc-status");
    const keepUpperBox = document.getElementById("sc-keep-upper");
    const keepLowerBox = document.getElementById("sc-keep-lower");
    const depthTolInput = document.getElementById("sc-depth-tol");
    const widthTolInput = document.getElementById("sc-width-tol");

    const FIELDS = ["height", "clearance", "depth", "width", "flap", "groove"];
    const inputs = {};
    for (const f of FIELDS) {
        inputs[f] = {
            num: document.getElementById(`sc-${f}`),
            slider: document.getElementById(`sc-${f}-slider`),
        };
    }

    // gizmo palette (piece-color exception): axis arrows + rotation handles
    const AXIS_COLORS = { x: 0x7db98a, y: 0xd47a72, z: 0x6f95d4 };

    const connPanel = document.getElementById("connector-panel");
    const connBtn = document.getElementById("sc-connectors");

    let mode = null;          // null | "curve" | "planar" | "dovetail"
    let params = { height: 0, depth: 10, width: 20, flap: 65, groove: 0 };
    let connMode = false;     // placing connectors on the planar cut face
    let connFlipped = false;  // pegs on the upper piece instead of the lower
    let connectors = [];      // Vector3 positions on the cut plane
    let connParams = { shape: "circle", depth: 3, size: 6, rot: 0 };
    let markerGroup = null;   // preview meshes for placed connectors
    let bounds = null;        // THREE.Box3 of visible pieces at mode entry
    let planePoint = new THREE.Vector3();
    let planeQuat = new THREE.Quaternion(); // plane orientation (identity = level)
    let toothCenter = new THREE.Vector3(); // dovetail tongue position (x/z used)
    let surface = null;       // the red preview sheet
    let gizmo = null;         // {group, handles: [{mesh hit, axis|ring}], ring}
    let invalid = false;

    // ------------------------------------------------------------- helpers

    function visibleBounds() {
        const box = new THREE.Box3();
        for (const p of CC.pieces) if (p.visible) box.expandByObject(p);
        return box;
    }

    function setField(f, value, min, max, step) {
        const { num, slider } = inputs[f];
        if (min !== undefined) {
            num.min = slider.min = min;
            num.max = slider.max = max;
            slider.step = step;
        }
        params[f] = value;
        num.value = slider.value = Math.round(value * 10) / 10;
    }

    function flare() {
        const flapRad = THREE.MathUtils.degToRad(Math.min(Math.max(params.flap, 30), 89));
        return params.depth / Math.tan(flapRad);
    }

    function planeBasis() {
        return {
            n: new THREE.Vector3(0, 1, 0).applyQuaternion(planeQuat),
            e1: new THREE.Vector3(1, 0, 0).applyQuaternion(planeQuat),
            e2: new THREE.Vector3(0, 0, 1).applyQuaternion(planeQuat),
        };
    }

    function gizmoAnchor() {
        return mode === "planar"
            ? planePoint.clone()
            : new THREE.Vector3(toothCenter.x, params.height, toothCenter.z);
    }

    function toScreen(v) {
        const p = v.clone().project(camera);
        return { x: (p.x + 1) / 2 * window.innerWidth, y: (1 - p.y) / 2 * window.innerHeight };
    }

    // ------------------------------------------------------------ 3D gizmo

    /* Orca-style double-headed arrow along `axis`: thin shaft, cone tips,
       and a fat invisible cylinder as the grab target. */
    function makeArrow(axis, color, length, s) {
        const group = new THREE.Group();
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });

        const shaft = new THREE.Mesh(
            new THREE.CylinderGeometry(s * 0.006, s * 0.006, length, 8), mat);
        group.add(shaft);
        for (const end of [1, -1]) {
            const cone = new THREE.Mesh(new THREE.ConeGeometry(s * 0.02, s * 0.055, 14), mat);
            cone.position.y = end * length / 2;
            cone.rotation.x = end === 1 ? 0 : Math.PI;
            group.add(cone);
        }
        const hit = new THREE.Mesh(
            new THREE.CylinderGeometry(s * 0.035, s * 0.035, length + s * 0.12, 8),
            new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
        hit.userData.gizmo = { kind: "axis", axis: axis.clone() };
        group.add(hit);

        group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
        group.renderOrder = 10;
        return { group, hit };
    }

    function buildGizmo() {
        removeGizmo();
        const size = new THREE.Vector3();
        bounds.getSize(size);
        const s = size.length();

        const group = new THREE.Group();
        const handles = [];

        if (mode === "planar") {
            const arrow = makeArrow(new THREE.Vector3(0, 1, 0), AXIS_COLORS.y, s * 0.7, s);
            group.add(arrow.group);
            handles.push(arrow);

            arrow.hit.userData.gizmo.label = "Move cut";

            /* Rotation handles: curved arrows (the universal "rotate" shape)
               interlocked at the rod's top — green rotates about world X,
               blue about world Z. Protractor + snapping while dragging. */
            const rotHandles = [];
            for (const [axis, color, label] of [
                [new THREE.Vector3(1, 0, 0), AXIS_COLORS.x, "Rotate X"],
                [new THREE.Vector3(0, 0, 1), AXIS_COLORS.z, "Rotate Z"],
            ]) {
                const h = new THREE.Group();
                const mat = new THREE.MeshBasicMaterial({ color, depthTest: false });
                const r = s * 0.085, tube = s * 0.008, arc = 1.7;

                const band = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 8, 32, arc), mat);
                h.add(band);
                for (const [angle, sign] of [[0, -1], [arc, 1]]) {
                    const cone = new THREE.Mesh(new THREE.ConeGeometry(s * 0.016, s * 0.04, 12), mat);
                    cone.position.set(Math.cos(angle) * r, Math.sin(angle) * r, 0);
                    const tangent = new THREE.Vector3(-Math.sin(angle), Math.cos(angle), 0).multiplyScalar(sign);
                    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
                    h.add(cone);
                }
                const hit = new THREE.Mesh(
                    new THREE.TorusGeometry(r, s * 0.03, 6, 24, arc),
                    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false, depthWrite: false }));
                hit.userData.gizmo = { kind: "rot", axis: axis.clone(), label: label.slice(-1), tip: label };
                h.add(hit);

                // torus lies in XY; face it perpendicular to the rotation
                // axis, arc centered at the top
                h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
                h.rotateZ(Math.PI / 2 - arc / 2);
                h.renderOrder = 11;
                group.add(h);
                rotHandles.push({ group: h, hit, axis: axis.clone() });
            }
            gizmo = { group, handles, arrowY: arrow, rotHandles, scale: s };
        } else {
            const ax = makeArrow(new THREE.Vector3(1, 0, 0), AXIS_COLORS.x, s * 0.45, s);
            const ay = makeArrow(new THREE.Vector3(0, 1, 0), AXIS_COLORS.y, s * 0.55, s);
            const az = makeArrow(new THREE.Vector3(0, 0, 1), AXIS_COLORS.z, s * 0.45, s);
            ax.hit.userData.gizmo.label = "Move tooth";
            ay.hit.userData.gizmo.label = "Cut height";
            az.hit.userData.gizmo.label = "Move tooth";
            group.add(ax.group, ay.group, az.group);
            handles.push(ax, ay, az);
            gizmo = { group, handles, rotHandles: null, scale: s };
        }

        scene.add(group);
        updateGizmo();
    }

    function updateGizmo() {
        if (!gizmo) return;
        gizmo.group.position.copy(gizmoAnchor());
        if (mode === "planar") {
            const { n } = planeBasis();
            gizmo.arrowY.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
            gizmo.arrowY.hit.userData.gizmo.axis.copy(n);
            // rotation arcs interlock at the top of the rod
            const top = n.clone().multiplyScalar(gizmo.scale * 0.32);
            gizmo.rotHandles[0].group.position.copy(top);
            gizmo.rotHandles[1].group.position.copy(top);
        }
    }

    function removeGizmo() {
        if (!gizmo) return;
        scene.remove(gizmo.group);
        gizmo.group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        gizmo = null;
        hovered = null;
        angleChip.style.display = "none";
        canvas.style.cursor = "";
    }

    // ----------------------------------------------------------- connectors

    const connInputs = {
        depth: { num: document.getElementById("conn-depth"), slider: document.getElementById("conn-depth-slider") },
        size: { num: document.getElementById("conn-size"), slider: document.getElementById("conn-size-slider") },
        rot: { num: document.getElementById("conn-rot"), slider: document.getElementById("conn-rot-slider") },
    };
    const connDepthTol = document.getElementById("conn-depth-tol");
    const connSizeTol = document.getElementById("conn-size-tol");

    function connDir() {
        const n = planeBasis().n;
        return connFlipped ? n.negate() : n;
    }

    function updateConnBtn() {
        connBtn.textContent = connectors.length ? `Connectors (${connectors.length})` : "Connectors";
    }

    function setConnField(f, value, min, max, step) {
        const { num, slider } = connInputs[f];
        if (min !== undefined) {
            num.min = slider.min = min;
            num.max = slider.max = max;
            slider.step = step;
        }
        connParams[f] = value;
        num.value = slider.value = Math.round(value * 10) / 10;
    }

    /* Orca hides the female piece so you see the cut face as a SOLID half.
       We do it for real: a temporary boolean cut of every visible piece,
       showing only the male side (properly capped), originals hidden. */
    const MALE_COLORS = { inside: 0x6f95d4, outside: 0xd6a06e }; // blue lower / orange upper
    let connPreviewMeshes = [];
    let connHiddenPieces = [];

    function buildConnPreview() {
        disposeConnPreview();
        const cutter = CutCore.buildPlanarCutter(planePoint, planeBasis().n, bounds);
        try {
            for (const piece of CC.pieces) {
                if (!piece.visible) continue;
                const r = CutCore.cutWithCutter(piece.geometry, cutter);
                const male = connFlipped ? r.outside : r.inside;
                const other = connFlipped ? r.inside : r.outside;
                if (other) other.dispose();
                if (male) {
                    const mat = CC.baseMaterial.clone();
                    mat.color.setHex(MALE_COLORS[connFlipped ? "outside" : "inside"]);
                    const mesh = new THREE.Mesh(male, mat);
                    scene.add(mesh);
                    connPreviewMeshes.push(mesh);
                }
                piece.visible = false;
                connHiddenPieces.push(piece);
            }
        } finally {
            cutter.delete();
        }
    }

    function disposeConnPreview() {
        for (const mesh of connPreviewMeshes) {
            scene.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        connPreviewMeshes = [];
        for (const piece of connHiddenPieces) piece.visible = true;
        connHiddenPieces = [];
    }

    function rebuildMarkers() {
        if (markerGroup) {
            scene.remove(markerGroup);
            markerGroup.traverse((o) => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) o.material.dispose();
            });
            markerGroup = null;
        }
        if (!connectors.length) { updateConnBtn(); return; }

        markerGroup = new THREE.Group();
        const dir = connDir();
        const sides = connParams.shape === "hexagon" ? 6 : 32;
        const r = connParams.size / 2;
        for (let i = 0; i < connectors.length; i++) {
            const geo = new THREE.CylinderGeometry(r, r, connParams.depth, sides);
            geo.rotateY(THREE.MathUtils.degToRad(connParams.rot));
            const marker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: 0xd6bd6e, transparent: true, opacity: 0.9,
            }));
            marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            marker.position.copy(connectors[i]).addScaledVector(dir, connParams.depth / 2);
            marker.userData.connectorIndex = i;
            markerGroup.add(marker);
        }
        markerGroup.renderOrder = 9;
        scene.add(markerGroup);
        updateConnBtn();
    }

    function clearConnectors(toastWhy) {
        if (!connectors.length) { updateConnBtn(); return; }
        connectors = [];
        rebuildMarkers();
        if (toastWhy) CC.toast(toastWhy);
    }

    const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)));

    async function enterConnectors() {
        if (!CC.cutFlow.isEngineReady()) {
            CC.toast("The cutting engine is still warming up — one moment.");
            return;
        }
        connMode = true;
        removeGizmo();
        CC.progress.show("Preparing the cut preview…");
        await nextFrame();
        try {
            buildConnPreview();
        } catch (err) {
            console.error(err);
            CC.toast("Couldn't preview the cut — is the model watertight?");
            connMode = false;
            buildGizmo();
            CC.progress.hide();
            return;
        }
        CC.progress.hide();
        gsap.to(panel, { autoAlpha: 0, y: 10, duration: 0.3, ease: "power2.out" });
        gsap.fromTo(connPanel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.6, ease: "power4.out", delay: 0.1 });
    }

    function exitConnectors() {
        connMode = false;
        connDrag = null;
        disposeConnPreview();
        buildGizmo();
        rebuildPreview(); // restore the plane sheet + half tints
        gsap.to(connPanel, { autoAlpha: 0, y: 10, duration: 0.3, ease: "power2.out" });
        gsap.fromTo(panel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.6, ease: "power4.out", delay: 0.1 });
    }

    /* Pointer language on the cut face: click empty = add · drag a marker =
       move it · quick click a marker = remove it · Delete = remove newest. */
    let connClick = null;
    let connDrag = null; // {index, sx, sy, moved}

    function connPlanePoint(e) {
        const ray = pointerRay(e);
        const { n } = planeBasis();
        const cutPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, planePoint);
        const pos = new THREE.Vector3();
        if (!ray.intersectPlane(cutPlane, pos)) return null;
        const pad = 2;
        pos.x = Math.min(Math.max(pos.x, bounds.min.x - pad), bounds.max.x + pad);
        pos.z = Math.min(Math.max(pos.z, bounds.min.z - pad), bounds.max.z + pad);
        return pos;
    }

    function onConnPointerDown(e) {
        if (e.target !== canvas || e.button !== 0) return;
        if (markerGroup) {
            pointerRay(e);
            const hit = raycaster.intersectObjects(markerGroup.children, false)[0];
            if (hit) {
                // grab a placed connector to fine-tune (or quick-click to remove)
                connDrag = { index: hit.object.userData.connectorIndex, sx: e.clientX, sy: e.clientY, moved: false };
                e.stopPropagation();
                e.preventDefault();
                canvas.style.cursor = "grabbing";
                return;
            }
        }
        connClick = { x: e.clientX, y: e.clientY };
    }

    function onConnPointerMove(e) {
        if (!connDrag) return;
        e.stopPropagation();
        if (!connDrag.moved &&
            Math.hypot(e.clientX - connDrag.sx, e.clientY - connDrag.sy) < 5) return;
        connDrag.moved = true;
        const pos = connPlanePoint(e);
        if (!pos) return;
        connectors[connDrag.index].copy(pos);
        const marker = markerGroup.children[connDrag.index];
        marker.position.copy(pos).addScaledVector(connDir(), connParams.depth / 2);
    }

    function onConnPointerUp(e) {
        if (connDrag) {
            e.stopPropagation();
            canvas.style.cursor = "";
            if (!connDrag.moved) { // quick click = remove
                connectors.splice(connDrag.index, 1);
                rebuildMarkers();
            }
            connDrag = null;
            return;
        }
        if (!connClick) return;
        const moved = Math.hypot(e.clientX - connClick.x, e.clientY - connClick.y);
        connClick = null;
        if (moved > 5 || e.target !== canvas) return; // it was an orbit drag

        const pos = connPlanePoint(e);
        if (!pos) return;
        connectors.push(pos);
        rebuildMarkers();
    }

    // ------------------------------------------------- gizmo drag handling

    const raycaster = new THREE.Raycaster();
    let drag = null;

    function pointerRay(e) {
        const ndc = new THREE.Vector2(
            (e.clientX / window.innerWidth) * 2 - 1,
            -(e.clientY / window.innerHeight) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        return raycaster.ray;
    }

    const angleChip = document.getElementById("angle-chip");
    let protractor = null;

    /* Protractor drawn while rotating: circle + 5°/45° ticks in the rotation
       plane, plus an indicator ray at the current (snapped) angle. */
    function buildProtractor(anchor, u0, v0, R) {
        removeProtractor();
        const group = new THREE.Group();
        const mat = new THREE.LineBasicMaterial({
            color: 0x9a9aa0, transparent: true, opacity: 0.8, depthTest: false });

        const circlePts = [];
        for (let d = 0; d <= 360; d += 3) {
            const t = THREE.MathUtils.degToRad(d);
            circlePts.push(anchor.clone()
                .addScaledVector(u0, Math.cos(t) * R)
                .addScaledVector(v0, Math.sin(t) * R));
        }
        group.add(new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(circlePts), mat));

        const tickPts = [];
        for (let d = 0; d < 360; d += 5) {
            const t = THREE.MathUtils.degToRad(d);
            const dir = u0.clone().multiplyScalar(Math.cos(t))
                .addScaledVector(v0, Math.sin(t));
            const len = d % 45 === 0 ? 0.14 : 0.05;
            tickPts.push(
                anchor.clone().addScaledVector(dir, R),
                anchor.clone().addScaledVector(dir, R * (1 + len)));
        }
        group.add(new THREE.LineSegments(
            new THREE.BufferGeometry().setFromPoints(tickPts), mat));

        const indGeo = new THREE.BufferGeometry().setFromPoints([anchor, anchor.clone().addScaledVector(u0, R)]);
        const indicator = new THREE.Line(indGeo, new THREE.LineBasicMaterial({
            color: 0xd6bd6e, depthTest: false }));
        group.add(indicator);

        group.renderOrder = 12;
        scene.add(group);
        protractor = { group, indicator, anchor, u0, v0, R };
    }

    function removeProtractor() {
        if (!protractor) return;
        scene.remove(protractor.group);
        protractor.group.traverse((o) => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) o.material.dispose();
        });
        protractor = null;
        angleChip.style.display = "none";
    }

    function onPointerDown(e) {
        if (connMode) { onConnPointerDown(e); return; }
        if (!gizmo || e.button !== 0 || (mode !== "planar" && mode !== "dovetail")) return;
        const ray = pointerRay(e);
        const targets = gizmo.handles.map((h) => h.hit);
        if (gizmo.rotHandles) for (const h of gizmo.rotHandles) targets.push(h.hit);
        const hit = raycaster.intersectObjects(targets, false)[0];
        if (!hit) return;
        e.stopPropagation();
        e.preventDefault();
        if (hovered) { hovered.parent.scale.setScalar(1); hovered = null; }
        angleChip.style.display = "none";

        const info = hit.object.userData.gizmo;
        if (info.kind === "rot") {
            /* rotate about a fixed world axis; 0° = where the plane is now */
            const axis = info.axis.clone();
            const anchor = gizmoAnchor();
            const { n } = planeBasis();
            const u0 = n.clone().addScaledVector(axis, -n.dot(axis));
            if (u0.lengthSq() < 1e-9) u0.set(0, 1, 0);
            u0.normalize();
            const v0 = new THREE.Vector3().crossVectors(axis, u0).normalize();
            const R = gizmo.scale * 0.28;

            // protractor's on-screen radius calibrates the snap tiers
            const s0 = toScreen(anchor);
            const s1 = toScreen(anchor.clone().addScaledVector(u0, R));
            const Rpx = Math.max(Math.hypot(s1.x - s0.x, s1.y - s0.y), 20);

            buildProtractor(anchor, u0, v0, R);
            drag = {
                kind: "rot", axis, label: info.label,
                anchor, u0, v0, Rpx,
                qStart: planeQuat.clone(),
                anchorPx: s0,
            };
        } else {
            /* 1:1 cursor-follow along the axis: precompute the axis' on-screen
               direction and mm-per-pixel so the handle tracks the pointer
               exactly — never inverted, never faster than the hand. */
            const anchor = gizmoAnchor();
            const s0 = toScreen(anchor);
            const s1 = toScreen(anchor.clone().add(info.axis));
            const dx = s1.x - s0.x, dy = s1.y - s0.y;
            const px = Math.hypot(dx, dy);
            if (px < 1e-3) return; // axis points straight at the camera
            drag = {
                kind: "axis",
                axis: info.axis.clone(),
                start: anchor,
                dirX: dx / px, dirY: dy / px,
                mmPerPx: 1 / px,
                sx: e.clientX, sy: e.clientY,
            };
        }
        canvas.style.cursor = "grabbing";
    }

    let hovered = null;

    /* Hovering a handle names it (chip near the cursor) and swells it a
       little, so nobody has to guess what an arrow or arc does. */
    function updateHover(e) {
        if (!gizmo || (mode !== "planar" && mode !== "dovetail")) return;
        pointerRay(e);
        const targets = gizmo.handles.map((h) => h.hit);
        if (gizmo.rotHandles) for (const h of gizmo.rotHandles) targets.push(h.hit);
        const hit = raycaster.intersectObjects(targets, false)[0];
        const next = hit ? hit.object : null;
        if (next === hovered) {
            if (hovered) {
                angleChip.style.left = `${e.clientX + 16}px`;
                angleChip.style.top = `${e.clientY - 34}px`;
            }
            return;
        }
        if (hovered) hovered.parent.scale.setScalar(1);
        hovered = next;
        if (hovered) {
            hovered.parent.scale.setScalar(1.18);
            const info = hovered.userData.gizmo;
            angleChip.textContent = info.tip || info.label || "";
            angleChip.style.display = "block";
            angleChip.style.left = `${e.clientX + 16}px`;
            angleChip.style.top = `${e.clientY - 34}px`;
            canvas.style.cursor = "grab";
        } else {
            angleChip.style.display = "none";
            canvas.style.cursor = "";
        }
    }

    function onPointerMove(e) {
        if (connMode) { onConnPointerMove(e); return; }
        if (!drag) { updateHover(e); return; }
        e.stopPropagation();

        if (drag.kind === "axis") {
            const alongPx = (e.clientX - drag.sx) * drag.dirX + (e.clientY - drag.sy) * drag.dirY;
            const dist = alongPx * drag.mmPerPx;
            const target = drag.start.clone().addScaledVector(drag.axis, dist);
            const pad = 2;

            if (mode === "planar") {
                planePoint.copy(target);
                planePoint.y = Math.min(Math.max(planePoint.y, bounds.min.y - pad), bounds.max.y + pad);
                setField("height", planePoint.y);
            } else if (Math.abs(drag.axis.y) > 0.5) {
                const h = Math.min(Math.max(target.y, bounds.min.y), bounds.max.y);
                setField("height", h);
            } else {
                toothCenter.x = Math.min(Math.max(target.x, bounds.min.x), bounds.max.x);
                toothCenter.z = Math.min(Math.max(target.z, bounds.min.z), bounds.max.z);
            }
        } else {
            /* rotation with Orca-style distance-based snapping:
               close to the gizmo = coarse 45° steps, further out = 5°,
               furthest = fine 1° steps. */
            const ray = pointerRay(e);
            const rotPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(drag.axis, drag.anchor);
            const hit = new THREE.Vector3();
            if (!ray.intersectPlane(rotPlane, hit)) return;
            const d = hit.sub(drag.anchor);
            const raw = THREE.MathUtils.radToDeg(
                Math.atan2(d.dot(drag.v0), d.dot(drag.u0)));

            const distPx = Math.hypot(e.clientX - drag.anchorPx.x, e.clientY - drag.anchorPx.y);
            const step = distPx < drag.Rpx * 1.4 ? 45 : distPx < drag.Rpx * 2.5 ? 5 : 1;
            const snapped = Math.round(raw / step) * step;

            const q = new THREE.Quaternion().setFromAxisAngle(
                drag.axis, THREE.MathUtils.degToRad(snapped));
            planeQuat.copy(q.multiply(drag.qStart));

            // indicator ray + floating readout
            if (protractor) {
                const t = THREE.MathUtils.degToRad(snapped);
                const tip = protractor.anchor.clone()
                    .addScaledVector(protractor.u0, Math.cos(t) * protractor.R)
                    .addScaledVector(protractor.v0, Math.sin(t) * protractor.R);
                protractor.indicator.geometry.setFromPoints([protractor.anchor, tip]);
            }
            angleChip.style.display = "block";
            angleChip.style.left = `${e.clientX + 16}px`;
            angleChip.style.top = `${e.clientY - 34}px`;
            angleChip.textContent = `${drag.label}: ${snapped.toFixed(1)}°  ·  ${step}° steps`;
        }
        updateGizmo();
        rebuildPreview();
    }

    function onPointerUp(e) {
        if (connMode) { onConnPointerUp(e); return; }
        if (!drag) return;
        e.stopPropagation();
        drag = null;
        removeProtractor();
        canvas.style.cursor = "";
        if (mode === "planar") clearConnectors("Connectors cleared — the cut plane moved.");
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);

    // --------------------------------------------------------- 3D preview

    function removeSurface() {
        if (!surface) return;
        scene.remove(surface);
        surface.geometry.dispose();
        surface.material.dispose();
        surface = null;
    }

    /* Red sheet showing the parting surface: a rotatable plane for planar,
       the single-tooth profile (approximated, no overhang) for dovetail. */
    function rebuildPreview() {
        removeSurface();
        if (mode !== "planar" && mode !== "dovetail") return;

        const size = new THREE.Vector3();
        bounds.getSize(size);

        let geometry;
        if (mode === "planar") {
            const span = size.length() * 0.75 + 5;
            geometry = new THREE.PlaneGeometry(span * 2, span * 2);
            const { n, e1, e2 } = planeBasis();
            geometry.applyMatrix4(new THREE.Matrix4().makeBasis(e1, e2, n).setPosition(planePoint));
        } else {
            const mx = size.x * 0.65 + 5, mz = size.z * 0.65 + 5;
            const cols = 240;
            const verts = new Float32Array(cols * 2 * 3);
            const cosG = Math.cos(THREE.MathUtils.degToRad(params.groove));
            const sinG = Math.sin(THREE.MathUtils.degToRad(params.groove));
            for (let i = 0; i < cols; i++) {
                const u = -mx + (2 * mx) * (i / (cols - 1));
                const y = CutCore.dovetailEdgeY(toothCenter.x + u, toothCenter.x,
                    params.height, params.depth, params.width, flare());
                for (const [j, w] of [[0, -mz], [1, mz]]) {
                    const x = toothCenter.x + u * cosG - w * sinG;
                    const z = toothCenter.z + u * sinG + w * cosG;
                    verts.set([x, y, z], (i * 2 + j) * 3);
                }
            }
            const idx = [];
            for (let i = 0; i < cols - 1; i++) {
                const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
                idx.push(a, c, b, b, c, d);
            }
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(verts, 3));
            geometry.setIndex(idx);
        }

        surface = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
            color: CC.cutFlow.RIBBON_COLOR, transparent: true, opacity: 0.3,
            side: THREE.DoubleSide, depthWrite: false,
        }));
        scene.add(surface);

        validate();
        retint();
    }

    function classifier() {
        if (mode === "planar") {
            const p = planePoint.clone(), n = planeBasis().n;
            return (x, y, z) =>
                (x - p.x) * n.x + (y - p.y) * n.y + (z - p.z) * n.z < 0;
        }
        const cx = toothCenter.x, cz = toothCenter.z;
        const cosG = Math.cos(THREE.MathUtils.degToRad(-params.groove));
        const sinG = Math.sin(THREE.MathUtils.degToRad(-params.groove));
        const { height, depth, width } = params;
        const fl = flare();
        return (x, y, z) => {
            const lx = cx + (x - cx) * cosG - (z - cz) * sinG;
            return y < CutCore.dovetailEdgeY(lx, cx, height, depth, width, fl);
        };
    }

    let retintQueued = false;
    function retint() {
        if (retintQueued) return; // coalesce drags to one pass per frame
        retintQueued = true;
        requestAnimationFrame(() => {
            retintQueued = false;
            if (mode === "planar" || mode === "dovetail") {
                CC.cutFlow.tintBySide(classifier());
            }
        });
    }

    /* Orca-style validity warning + tilt readout. */
    function validate() {
        invalid = false;
        let msg = "";
        if (mode === "dovetail") {
            const size = new THREE.Vector3();
            bounds.getSize(size);
            if (params.height - params.depth <= bounds.min.y + 0.2 ||
                params.height >= bounds.max.y - 0.2 ||
                params.height - params.depth / 2 <= bounds.min.y) {
                invalid = true;
                msg = "Warning: the tooth pokes outside the model — raise the cut or shrink the depth.";
            } else {
                const g = THREE.MathUtils.degToRad(params.groove);
                const extent = Math.abs(Math.cos(g)) * size.x + Math.abs(Math.sin(g)) * size.z;
                if (params.width + 2 * flare() >= extent) {
                    invalid = true;
                    msg = "Warning: the tooth is wider than the model — shrink the width or flap angle.";
                }
            }
        } else if (mode === "planar") {
            const tilt = THREE.MathUtils.radToDeg(
                planeBasis().n.angleTo(new THREE.Vector3(0, 1, 0)));
            msg = tilt > 0.5 ? `Tilt ${tilt.toFixed(0)}° — drag the ring to adjust, Level to reset.` : "";
        }
        statusEl.textContent = msg;
        statusEl.classList.toggle("warning", invalid);
        applyBtn.disabled = invalid;
    }

    // -------------------------------------------------------- mode control

    function enterFlow() {
        if (!CC.getModel()) return;
        gsap.fromTo(modeDock, { y: -12 },
            { autoAlpha: 1, y: 0, duration: 0.6, ease: "power4.out" });
        setMode("curve");
    }

    function exitFlow(restoreDocks) {
        cleanupSimpleMode();
        if (mode === "curve") CC.pen.exit(false, restoreDocks);
        mode = null;
        gsap.to(modeDock, { autoAlpha: 0, y: -12, duration: 0.4, ease: "power2.out" });
        if (restoreDocks) {
            gsap.fromTo([viewDock, actionDock], { y: 10 },
                { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1 });
        }
    }

    function cleanupSimpleMode() {
        if (mode !== "planar" && mode !== "dovetail") return;
        removeSurface();
        removeGizmo();
        removeProtractor();
        drag = null;
        disposeConnPreview();
        connectors = [];
        rebuildMarkers();
        connMode = false;
        connDrag = null;
        connFlipped = false;
        CC.cutFlow.untint();
        gsap.to([panel, connPanel], { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
    }

    function setMode(next) {
        if (next === mode) return;

        // leave the old mode without touching the main docks
        if (mode === "curve") CC.pen.exit(false, false);
        cleanupSimpleMode();
        mode = next;

        for (const btn of modeDock.querySelectorAll(".mode-btn")) {
            btn.classList.toggle("active", btn.dataset.mode === next);
        }

        if (next === "curve") {
            CC.pen.enter();
            return;
        }

        // planar / dovetail
        gsap.to(actionDock, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        bounds = visibleBounds();
        const size = new THREE.Vector3();
        const center = new THREE.Vector3();
        bounds.getSize(size);
        bounds.getCenter(center);
        planePoint.copy(center);
        planeQuat.identity();
        toothCenter.copy(center);

        setField("height", center.y, bounds.min.y, bounds.max.y, size.y / 200);
        setField("clearance", 0.15, 0, 0.5, 0.01); // printed-fit gap (planar)
        // Orca-flavored tooth defaults: one sturdy centered tongue
        setField("depth", Math.min(Math.max(size.y * 0.15, 1), 40), 0.5, size.y * 0.6, 0.1);
        setField("width", Math.min(Math.max(size.x * 0.3, 2), 80), 1, size.x * 0.9, 0.1);
        setField("flap", 65, 30, 85, 1);
        setField("groove", 0, -90, 90, 1);
        keepUpperBox.checked = true;
        keepLowerBox.checked = true;

        // connector defaults scale with the model
        connectors = [];
        connFlipped = false;
        updateConnBtn();
        const minXZ = Math.min(size.x, size.z);
        connParams.size = Math.min(Math.max(minXZ * 0.08, 2), 15);
        connParams.depth = Math.min(Math.max(connParams.size, 2), 15);
        connParams.rot = 0;
        setConnField("size", connParams.size, 1, Math.max(minXZ / 2, 4), 0.1);
        setConnField("depth", connParams.depth, 1, Math.max(size.y, 4), 0.1);
        setConnField("rot", 0, 0, 120, 1);

        panel.classList.toggle("planar-mode", next === "planar");
        gsap.fromTo(panel, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out" });
        buildGizmo();
        rebuildPreview();
    }

    // --------------------------------------------------------------- apply

    function applySimpleCut() {
        const keepUpper = keepUpperBox.checked;
        const keepLower = keepLowerBox.checked;
        if (invalid) return;
        if (!keepUpper && !keepLower) {
            CC.toast("Keep at least one side, or there's nothing left to cut for.");
            return;
        }
        if (!CC.cutFlow.isEngineReady()) {
            CC.toast("The cutting engine is still warming up — one moment.");
            return;
        }

        const modeAtApply = mode;
        const p = { ...params };
        const point = planePoint.clone();
        const normal = planeBasis().n;
        const tooth = toothCenter.clone();
        const box = bounds.clone();
        const dTol = parseFloat(depthTolInput.value) || 0;
        const wTol = parseFloat(widthTolInput.value) || 0;
        applyBtn.disabled = true;

        let makeConnectors = null;
        if (modeAtApply === "planar" && connectors.length) {
            const list = connectors.map((v) => v.clone());
            const cp = { ...connParams };
            const dir = connDir().clone();
            const male = connFlipped ? "outside" : "inside";
            const cdTol = parseFloat(connDepthTol.value) || 0;
            const csTol = parseFloat(connSizeTol.value) || 0;
            makeConnectors = () => ({
                pegs: list.map((pos) => CutCore.buildConnectorSolid(
                    { pos, normal: dir, shape: cp.shape, size: cp.size, depth: cp.depth, rotDeg: cp.rot })),
                sockets: list.map((pos) => CutCore.buildConnectorSolid(
                    { pos, normal: dir, shape: cp.shape, size: cp.size, depth: cp.depth, rotDeg: cp.rot },
                    { r: csTol / 2, d: cdTol })),
                maleSide: male,
            });
        }

        const makeCutter = () => {
            if (modeAtApply === "planar") {
                const exact = CutCore.buildPlanarCutter(point, normal, box);
                const gap = Math.min(Math.max(p.clearance || 0, 0), 0.5);
                if (!gap) return exact;
                // upper piece is cut `gap` higher -> assembled gap = `gap`
                return {
                    inside: exact,
                    outside: CutCore.buildPlanarCutter(
                        point.clone().addScaledVector(normal, gap), normal, box),
                };
            }
            const dt = {
                height: p.height, depth: p.depth, width: p.width,
                flapDeg: p.flap, grooveDeg: p.groove,
                cx: tooth.x, cz: tooth.z,
            };
            return {
                inside: CutCore.buildDovetailCutter(dt, box),                    // socket, full size
                outside: CutCore.buildDovetailCutter(dt, box, { w: wTol, d: dTol }), // tongue, shrunk
            };
        };

        // cutter's inside = below the surface = the LOWER piece
        CC.cutFlow.untint();
        CC.cutFlow.applyCutterFlow(makeCutter, { inside: keepLower, outside: keepUpper }, makeConnectors)
            .then((done) => { if (done) exitFlow(true); })
            .catch((err) => {
                if (err.message === "not-watertight") {
                    CC.toast("This model isn't watertight, so it can't be cut cleanly. A repair tool is planned.");
                } else {
                    console.error(err);
                    CC.toast("The cut failed — see the console for details.");
                }
            })
            .finally(() => {
                CC.progress.hide();
                applyBtn.disabled = false;
            });
    }

    // ----------------------------------------------------------------- wire

    drawBtn.addEventListener("click", enterFlow);
    modeDock.addEventListener("click", (e) => {
        const btn = e.target.closest(".mode-btn");
        if (btn) setMode(btn.dataset.mode);
    });

    for (const f of FIELDS) {
        const { num, slider } = inputs[f];
        const onChange = (src) => () => {
            const v = parseFloat(src.value);
            if (!Number.isFinite(v)) return;
            params[f] = v;
            (src === num ? slider : num).value = v;
            if (f === "height") {
                planePoint.y = v;
                if (mode === "planar") clearConnectors("Connectors cleared — the cut plane moved.");
            }
            updateGizmo();
            rebuildPreview();
        };
        num.addEventListener("input", onChange(num));
        slider.addEventListener("input", onChange(slider));
    }

    document.getElementById("sc-level").addEventListener("click", () => {
        planeQuat.identity();
        if (mode === "planar") clearConnectors("Connectors cleared — the cut plane moved.");
        updateGizmo();
        rebuildPreview();
    });

    // connector sub-panel wiring
    connBtn.addEventListener("click", () => { if (mode === "planar") enterConnectors(); });
    document.getElementById("conn-done").addEventListener("click", exitConnectors);
    document.getElementById("conn-flip").addEventListener("click", async () => {
        connFlipped = !connFlipped;
        CC.progress.show("Flipping the cut preview…");
        await nextFrame();
        try {
            buildConnPreview();
        } catch (err) {
            console.error(err);
        }
        CC.progress.hide();
        rebuildMarkers();
    });
    for (const btn of connPanel.querySelectorAll(".conn-shape")) {
        btn.addEventListener("click", () => {
            connParams.shape = btn.dataset.shape;
            for (const b of connPanel.querySelectorAll(".conn-shape")) {
                b.classList.toggle("active", b === btn);
            }
            rebuildMarkers();
        });
    }
    for (const f of Object.keys(connInputs)) {
        const { num, slider } = connInputs[f];
        const onChange = (src) => () => {
            const v = parseFloat(src.value);
            if (!Number.isFinite(v)) return;
            connParams[f] = v;
            (src === num ? slider : num).value = v;
            rebuildMarkers();
        };
        num.addEventListener("input", onChange(num));
        slider.addEventListener("input", onChange(slider));
    }

    document.getElementById("sc-cancel").addEventListener("click", () => exitFlow(true));
    applyBtn.addEventListener("click", applySimpleCut);

    // pen-side exits (Cancel / Done / Esc) also close the mode picker
    const closeDockOnly = () => {
        mode = null;
        gsap.to(modeDock, { autoAlpha: 0, y: -12, duration: 0.4, ease: "power2.out" });
    };
    window.addEventListener("curvecut:spline-ready", () => {
        if (mode === "curve") closeDockOnly();
    });
    document.getElementById("draw-cancel").addEventListener("click", () => {
        if (mode === "curve") closeDockOnly();
    });
    window.addEventListener("keydown", (e) => {
        // Delete/Backspace pops the most recently placed connector
        if (connMode && (e.key === "Delete" || e.key === "Backspace") &&
            e.target.tagName !== "INPUT") {
            e.preventDefault();
            if (connectors.length) {
                connectors.pop();
                rebuildMarkers();
            }
            return;
        }
        if (e.key !== "Escape") return;
        if (connMode) { exitConnectors(); return; } // back to the cut panel
        if (mode === "curve") closeDockOnly(); // pen.js already exited itself
        else if (mode === "planar" || mode === "dovetail") exitFlow(true);
    });

    window.addEventListener("curvecut:model-loaded", () => {
        if (!mode) return;
        cleanupSimpleMode();
        mode = null;
        gsap.to([modeDock, panel], { autoAlpha: 0, duration: 0.3, ease: "power2.out" });
    });
})();
