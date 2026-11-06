/* Curve Cut — Hollow panel (lamp phase 1b).
   A non-modal bottom panel on the main page: set the wall (Lamp = 2.4 mm +
   open bottom), preview the REAL hollowed model from the worker, Confirm it
   as one undo step. The confirmed state is `mesh.userData.hollow` (the
   receipt); CC.hollow.confirmed() reads it for Big Print and later phases. */

(() => {
    "use strict";

    const CC = window.CurveCut;

    const panel = document.getElementById("hollow-panel");
    const panelCollapse = CC.makeCollapsible(panel);
    const actionDock = document.getElementById("action-dock");
    const openBtn = document.getElementById("hollow-btn");
    const wallInput = document.getElementById("hollow-wall");
    const wallHint = document.getElementById("hollow-wall-hint");
    const lampInput = document.getElementById("hollow-lamp");
    const bottomInput = document.getElementById("hollow-open-bottom");
    const statusEl = document.getElementById("hollow-status");
    const warningsEl = document.getElementById("hollow-warnings");
    const staleEl = document.getElementById("hollow-stale");
    const cancelBtn = document.getElementById("hollow-cancel");
    const previewBtn = document.getElementById("hollow-preview");
    const confirmBtn = document.getElementById("hollow-confirm");

    const STORAGE_KEY = "curvecut-hollow";
    const MIN_WALL_MM = 0.8;
    const DEFAULT_WALL_MM = 6;
    const LAMP_WALL_MM = 2.4;
    const GRID_CELL_LIMIT = 64e6; // same as MAX_GRID_VOXELS in hollow-core.js
    const BUSY_TOAST = "Another operation is still running — one moment.";
    const CHANGED_STATUS = "The model changed: preview again.";

    let isOpenNow = false;
    let running = false;
    let closeRequested = false;
    let resetAfterRun = false;
    let ownDispatch = false;
    let job = null;          // { id } of the compute job in flight
    let token = null;        // { token, geometry, worker }, one per panel session
    let preview = null;      // { mesh, source, geometry, key, stats, readyText }
    let serial = 0;

    // ---------------------------------------------------------- formatting

    const mm = (value) => String(Number(value.toFixed(2)));

    function describe(receipt) {
        const bottom = (receipt.openFaces || []).some((f) => f.label === "Bottom" && f.opened === true);
        return `hollow ${mm(receipt.wallMm)} mm${bottom ? ", open bottom" : ""}`;
    }

    function gridTooLargeMessage(wallMm, voxels) {
        const wall = mm(wallMm);
        const tail = "Thin lamp walls on big models come with the smooth-inside update.";
        if (!(voxels > 0)) {
            return `This model is too big to hollow at ${wall} mm walls yet. Try a thicker wall for now. ${tail}`;
        }
        // the throw measures at spacing = wall; voxels scale with 1/wall^3
        const suggested = mm(Math.ceil(wallMm * Math.cbrt(voxels / GRID_CELL_LIMIT) * 1.02 * 10) / 10);
        return `This model is too big to hollow at ${wall} mm walls yet: it would need `
            + `${Math.round(voxels / 1e6)} million grid cells and the limit is `
            + `${Math.round(GRID_CELL_LIMIT / 1e6)} million. Try about ${suggested} mm or thicker for now. ${tail}`;
    }

    // ------------------------------------------------------------ settings

    function wallValue() {
        return parseFloat(wallInput.value);
    }

    function updateWallHint() {
        const wall = wallValue();
        const count = Number.isFinite(wall) ? Math.round(wall / 0.4) : 0;
        wallHint.textContent = `≈ ${count} wall${count === 1 ? "" : "s"} @ 0.4 mm`;
    }

    function readSettings() {
        const settings = { wallMm: DEFAULT_WALL_MM, lamp: false, openBottom: false };
        let raw = null;
        try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (_) { return settings; }
        let data = null;
        try { data = JSON.parse(raw); } catch (_) { return settings; }
        if (!data || typeof data !== "object" || data.v !== 1) return settings;
        if (Number.isFinite(data.wallMm) && data.wallMm >= MIN_WALL_MM) settings.wallMm = data.wallMm;
        if (typeof data.lamp === "boolean") settings.lamp = data.lamp;
        if (typeof data.openBottom === "boolean") settings.openBottom = data.openBottom;
        return settings;
    }

    function saveSettings() {
        const wall = wallValue();
        if (!Number.isFinite(wall) || wall < MIN_WALL_MM) return;
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
                v: 1, wallMm: wall, lamp: lampInput.checked, openBottom: bottomInput.checked,
            }));
        } catch (_) { /* storage is a convenience; never block the panel */ }
    }

    function makeKey(source) {
        return {
            source,
            geometry: source.geometry,
            text: JSON.stringify({
                wallMm: Math.round(wallValue() * 1e6) / 1e6,
                openFaces: bottomInput.checked ? ["bottom"] : [],
                holes: [],
            }),
        };
    }

    function keyIsFresh() {
        if (!preview) return false;
        const now = makeKey(preview.source);
        return now.text === preview.key.text && now.geometry === preview.key.geometry
            && now.source === preview.key.source;
    }

    // --------------------------------------------------------------- state

    function gateMessage() {
        if (CC.pieces.length > 1) {
            return "Hollow before cutting: hollowing the pieces now would close every cut face with a wall. "
                + "Undo the cuts (⌘Z), hollow, then cut.";
        }
        const model = CC.pieces[0];
        const receipt = confirmed(model);
        if (receipt) {
            return `This model is already hollow (${describe(receipt).replace(/^hollow /, "")}). `
                + "Undo (⌘Z) to hollow it again with other settings.";
        }
        if (model && model.userData.bigPrintHollow) {
            return "This model was already hollowed in Big Print. Undo (⌘Z) or reload the model to hollow it here.";
        }
        return null;
    }

    function setStatus(text, warn = false) {
        statusEl.textContent = text;
        statusEl.classList.toggle("warning", warn);
    }

    function renderWarnings(stats) {
        warningsEl.textContent = "";
        const lines = [];
        if (stats) {
            const min = stats.wallStats && Number.isFinite(stats.wallStats.minMm)
                ? stats.wallStats.minMm.toFixed(1) : "?";
            for (const warning of stats.warnings || []) {
                if (warning.code === "thin-wall") {
                    lines.push({ text: `Some walls came out thinner than you asked (thinnest about ${min} mm).` });
                } else if (warning.code === "thin-wall-hard") {
                    lines.push({ text: `Some walls are under 1.6 mm (thinnest about ${min} mm): they may print weak and glow unevenly.`, hard: true });
                } else if (warning.code === "coarsened-grid") {
                    lines.push({ text: "This model is big for this wall, so the hollow used a coarser grid: the inside is rougher." });
                } else {
                    lines.push({ text: warning.detail });
                }
            }
            if (stats.fellBack) {
                lines.push({ text: "The precise engine couldn't handle this shape, so the grid engine was used." });
            }
        }
        for (const line of lines) {
            const li = document.createElement("li");
            li.textContent = line.text;
            if (line.hard) li.classList.add("hollow-warning-hard");
            warningsEl.appendChild(li);
        }
        warningsEl.hidden = lines.length === 0;
    }

    /* Brings every control in line with the state: gates, preview freshness,
       running. `keepStatus` leaves the status line to the caller. */
    function refresh(keepStatus = false) {
        const gate = isOpenNow ? gateMessage() : null;
        const fresh = !!preview && keyIsFresh();
        const locked = running || !!gate;
        for (const control of [wallInput, lampInput, bottomInput]) control.disabled = locked;
        previewBtn.disabled = locked;
        confirmBtn.disabled = !(fresh && !locked);
        staleEl.hidden = !(preview && !fresh) || !!gate;
        renderWarnings(preview && !gate ? preview.stats : null);
        if (keepStatus || running) return;
        if (gate) setStatus(gate, true);
        else if (preview) setStatus(fresh ? preview.readyText
            : "Settings changed since the preview: preview again before you confirm.", !fresh);
        else setStatus("Set the wall, then Preview hollowed.");
    }

    // ------------------------------------------------------ worker session

    function release(entry) {
        if (!entry) return;
        try {
            const promise = CC.compute.run("release", { token: entry.token });
            if (promise && promise.catch) promise.catch(() => {});
        } catch (_) { /* a busy or recycled worker already dropped it */ }
    }

    function forgetToken() {
        const entry = token;
        token = null;
        if (!running) release(entry);
    }

    async function ensureToken(source) {
        if (token && token.geometry === source.geometry && token.worker === CC.compute._worker) return;
        const old = token;
        token = null;
        release(old);
        const payload = await CC.compute.geometryPayloadAsync(source.geometry);
        const name = `hollow-panel-${++serial}`;
        // Scale is always 1 on the main page: the units panel bakes scale into
        // the geometry, and Big Print is not active (open() refused it).
        const primed = CC.compute.run("prime", { token: name, geometry: payload, scale: 1 },
            { transfer: [payload.vertProperties.buffer, payload.triVerts.buffer] });
        job = { id: primed.id };
        await primed;
        job = null;
        token = { token: name, geometry: source.geometry, worker: CC.compute._worker };
    }

    // ------------------------------------------------------------- preview

    function discardPreview() {
        if (!preview) return;
        const old = preview;
        preview = null;
        CC.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
    }

    function isCancel(error) {
        return !!error && (error.name === "HollowCancelled" || error.name === "ComputeCancelled"
            || (CC.compute && error instanceof CC.compute.ComputeCancelled));
    }

    function failureText(error, wall) {
        if (error && (error.name === "HollowGridTooLarge"
            || (CC.hollowCore && error instanceof CC.hollowCore.HollowGridTooLarge))) {
            let voxels = error.voxels;
            if (!(voxels > 0)) {
                const match = /needs (\d+) voxels/.exec(String(error.message));
                voxels = match ? Number(match[1]) : undefined;
            }
            return gridTooLargeMessage(wall, voxels);
        }
        console.error("Hollowing failed:", error);
        return "Hollowing failed — model unchanged. If the model has holes, click repair on the stats chip first, then try again.";
    }

    async function runPreview() {
        if (!isOpenNow || running || gateMessage()) return;
        const wall = wallValue();
        if (!Number.isFinite(wall) || wall < MIN_WALL_MM) {
            setStatus("Wall thickness must be at least 0.8 mm.", true);
            return;
        }
        const op = CC.ops.begin("hollow");
        if (!op) { CC.toast(BUSY_TOAST); return; }
        const source = CC.pieces[0];
        const bottom = bottomInput.checked;
        const lamp = lampInput.checked;
        const key = makeKey(source);
        running = true;
        refresh(true);
        setStatus("Hollowing… press Escape to stop.");
        CC.progress.show("Preparing hollow…");
        let failed = false;
        try {
            await ensureToken(source);
            if (!op.alive()) throw new CC.compute.ComputeCancelled();
            const promise = CC.compute.run("hollowApply", {
                token: token.token, wallMm: wall,
                opts: { openFaces: bottom ? ["bottom"] : [], holes: [] },
            }, {
                onProgress(p) {
                    CC.progress.update(`Hollowing — ${(p.stage || "compute").replace(/-/g, " ")}…`, p.fraction);
                },
            });
            job = { id: promise.id };
            const arrays = await promise;
            if (!op.alive()) throw new CC.compute.ComputeCancelled();

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(arrays.vertProperties, 3));
            geometry.setIndex(new THREE.BufferAttribute(arrays.triVerts, 1));
            const mesh = new THREE.Mesh(geometry, source.material);
            mesh.userData.hollowPreview = true;
            mesh.position.copy(source.position);
            mesh.quaternion.copy(source.quaternion);
            mesh.scale.copy(source.scale);
            discardPreview();
            source.visible = false;
            CC.scene.add(mesh);
            const stats = arrays.stats;
            const opened = (stats.openFaces || []).some((f) => f.opened === true);
            preview = {
                mesh, source, geometry: source.geometry, key, stats, lamp,
                readyText: `Preview ready · saves ${stats.savedPct.toFixed(1)}% of material`
                    + `${opened ? " · bottom open" : ""}. Look underneath (Bottom view, key 6), then Confirm.`,
            };
        } catch (error) {
            failed = true;
            if (error && error.message === "CC.compute is busy") {
                CC.toast(BUSY_TOAST);
            } else if (isCancel(error) || !op.alive()) {
                setStatus("Hollowing cancelled — model unchanged.");
            } else {
                setStatus(failureText(error, wall), true);
            }
            const entry = token;
            token = null; // a cancel can recycle the worker, which drops every cached source
            job = null;
            running = false;
            release(entry);
        } finally {
            job = null;
            running = false;
            CC.progress.hide();
            CC.ops.end(op);
        }
        if (closeRequested) { teardown(); return; }
        if (resetAfterRun) {
            resetAfterRun = false;
            resetPreview();
            return;
        }
        refresh(failed);
    }

    function cancelRun() {
        if (!running) return false;
        CC.ops.cancel();
        if (job) CC.compute.cancel(job.id);
        CC.toast("Stopping hollowing…");
        return true;
    }

    /* The model under the preview changed (undo, redo, another edit). */
    function resetPreview() {
        if (preview) preview.source.visible = true; // that mesh may live on in an undo snapshot
        discardPreview();
        const entry = token;
        token = null;
        release(entry);
        refresh(true);
        setStatus(gateMessage() || CHANGED_STATUS, !!gateMessage());
    }

    // ------------------------------------------------------ open and close

    function open() {
        if (isOpenNow) return;
        if (!CC.pieces.length) return;
        if (CC.ops.busy()) { CC.toast(BUSY_TOAST); return; }
        if (CC.bigPrintActive) { CC.toast("Hollow from the main page, before Big Print."); return; }
        const settings = readSettings();
        wallInput.value = String(settings.wallMm);
        lampInput.checked = settings.lamp;
        bottomInput.checked = settings.openBottom;
        updateWallHint();
        isOpenNow = true;
        gsap.set(panel, { visibility: "visible" }); // a hidden element cannot take focus
        closeRequested = false;
        resetAfterRun = false;
        refresh();
        gsap.to(actionDock, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        panelCollapse.reset();
        gsap.fromTo(panel, { y: 16 }, {
            autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out",
        });
        wallInput.focus();
    }

    function close() {
        if (!isOpenNow) return;
        if (running) {
            closeRequested = true;
            cancelRun();
            return;
        }
        teardown();
    }

    function teardown(promoted = false) {
        closeRequested = false;
        if (!promoted) {
            if (preview) preview.source.visible = true;
            discardPreview();
        } else {
            preview = null;
        }
        const entry = token;
        token = null;
        release(entry);
        isOpenNow = false;
        gsap.to(panel, { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        gsap.fromTo(actionDock, { y: 10 }, {
            autoAlpha: 1, y: 0, duration: 0.7, ease: "power4.out", delay: 0.1,
            onStart: () => openBtn.focus(),
        });
        refresh();
    }

    // ------------------------------------------------------------- confirm

    function confirm() {
        if (!preview || running) return;
        const source = preview.source;
        if (CC.pieces.length !== 1 || CC.pieces[0] !== source
            || source.geometry !== preview.geometry || !keyIsFresh()) {
            setStatus(CHANGED_STATUS, true);
            return;
        }
        const op = CC.ops.begin("hollow-confirm");
        if (!op) { CC.toast(BUSY_TOAST); return; }
        try {
            const stats = preview.stats;
            const receipt = {
                v: 1,
                wallMm: wallValue(),
                lamp: preview.lamp,
                openFaces: stats.openFaces,
                holes: stats.holes,
                savedPct: stats.savedPct,
                engineUsed: stats.engineUsed,
                fellBack: stats.fellBack,
                triangles: stats.triangles,
                warnings: stats.warnings,
                key: preview.key.text,
            };
            source.visible = true; // before the snapshot, or undo brings back an invisible mesh
            const next = preview.mesh;
            next.name = source.name;
            next.visible = true;
            next.userData = Object.assign({}, source.userData, { hollow: receipt });
            CC.history.capture();
            CC.scene.remove(source);
            CC.pieces[0] = next;
            ownDispatch = true;
            try {
                window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                    { detail: { source: "hollow" } }));
            } finally {
                ownDispatch = false;
            }
            teardown(true);
            const opened = describe(receipt).includes("open bottom");
            CC.toast(`Hollowed — wall ${mm(receipt.wallMm)} mm${opened ? ", bottom open" : ""}. ⌘Z undoes it.`);
        } finally {
            CC.ops.end(op);
        }
    }

    function confirmed(mesh = CC.pieces[0]) {
        return (mesh && mesh.userData.hollow) || null;
    }

    // -------------------------------------------------------------- events

    function onControlChange() {
        updateWallHint();
        saveSettings();
        refresh();
    }

    wallInput.addEventListener("input", onControlChange);
    bottomInput.addEventListener("change", onControlChange);
    lampInput.addEventListener("change", () => {
        wallInput.value = String(lampInput.checked ? LAMP_WALL_MM : DEFAULT_WALL_MM);
        bottomInput.checked = lampInput.checked;
        onControlChange();
    });

    openBtn.addEventListener("click", open);
    previewBtn.addEventListener("click", runPreview);
    confirmBtn.addEventListener("click", confirm);
    cancelBtn.addEventListener("click", () => { if (!cancelRun()) close(); });

    window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || !isOpenNow) return;
        if (!cancelRun()) close();
    });

    window.addEventListener("curvecut:model-loaded", () => { if (isOpenNow) close(); });

    window.addEventListener("curvecut:pieces-changed", () => {
        if (!isOpenNow || ownDispatch) return;
        if (running) {
            resetAfterRun = true;
            cancelRun();
            return;
        }
        if (preview) resetPreview();
        else refresh();
    });

    CC.hollow = {
        open, close, confirmed, describe,
        isOpen: () => isOpenNow,
        busy: () => running,
        _test: { gridTooLargeMessage },
    };
})();
