/* Curve Cut — viewer shell (MVP step 1)
   Scene, STL loading, orbit + snap views, theme, drag-and-drop.
   All libraries are vendored classic scripts (see vendor/) so this file
   runs from file:// with zero network access. */

(() => {
    "use strict";

    // ---------------------------------------------------------------- theme

    const THEME_BG = { dark: 0x000000, light: 0xf5f5f7 };
    const GRID_COLORS = {
        dark:  { center: 0x47474b, lines: 0x232326 },
        light: { center: 0xc2c2c8, lines: 0xdfdfe4 },
    };

    const themeBtn = document.getElementById("theme-toggle");
    const themeIcon = document.getElementById("theme-icon");
    const favicon = document.getElementById("favicon");

    const sunPath = "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z";
    const moonPath = "M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z";

    const faviconSvg = (stroke) =>
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cpath d='M10 70 C 35 20, 65 95, 90 35' fill='none' stroke='" +
        stroke + "' stroke-width='12' stroke-linecap='round'/%3E%3C/svg%3E";

    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
    // namespaced key ("theme" was too generic); storage can throw when blocked
    const THEME_KEY = "curvecut-theme";
    let savedTheme = null;
    try {
        savedTheme = localStorage.getItem(THEME_KEY) || localStorage.getItem("theme");
    } catch (_) { /* private mode / blocked storage — fall back to OS preference */ }
    let isDark = savedTheme ? savedTheme === "dark" : prefersDark.matches;

    let themeAnimTimer = null;

    const applyTheme = (dark, animate = true) => {
        // crossfade every UI surface for the duration of the switch (v1.6 polish)
        if (animate) {
            document.body.classList.add("theme-anim");
            clearTimeout(themeAnimTimer);
            themeAnimTimer = setTimeout(
                () => document.body.classList.remove("theme-anim"), 550);
        }
        document.body.setAttribute("data-theme", dark ? "dark" : "light");
        try { localStorage.setItem(THEME_KEY, dark ? "dark" : "light"); } catch (_) {}
        // "pressed" = dark mode on, matching the sun icon shown to switch to light
        themeBtn.setAttribute("aria-pressed", dark ? "true" : "false");

        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) metaTheme.content = dark ? "#000000" : "#f5f5f7";

        themeIcon.querySelector("path").setAttribute("d", dark ? sunPath : moonPath);
        favicon.href = faviconSvg(dark ? "white" : "black");

        if (scene) {
            const target = new THREE.Color(dark ? THEME_BG.dark : THEME_BG.light);
            if (animate && scene.background) {
                gsap.to(scene.background, {
                    r: target.r, g: target.g, b: target.b,
                    duration: 0.45, ease: "power2.out",
                });
                // the grid's colors are baked into vertex colors — dip it out,
                // rebuild in the new palette, ease it back
                if (grid) {
                    gsap.to(grid.material, {
                        opacity: 0, duration: 0.18, ease: "power2.out",
                        onComplete: () => {
                            rebuildGrid();
                            grid.material.opacity = 0;
                            gsap.to(grid.material,
                                { opacity: 0.9, duration: 0.3, ease: "power2.out" });
                        },
                    });
                } else {
                    rebuildGrid();
                }
            } else {
                scene.background = target;
                rebuildGrid();
            }
        }

        if (animate) {
            gsap.fromTo(themeIcon,
                { rotation: 0, scale: 0.8 },
                { rotation: 360, scale: 1, duration: window.CurveCut.a11y.dur(0.6), ease: "power2.out" });
        }
    };

    themeBtn.addEventListener("click", () => { isDark = !isDark; applyTheme(isDark); });
    prefersDark.addEventListener("change", (e) => { isDark = e.matches; applyTheme(isDark); });

    // ---------------------------------------------------------------- scene

    const canvas = document.getElementById("viewport");
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    } catch (err) { // no WebGL (blocked, headless, ancient GPU) — say so, don't white-screen
        console.error("WebGL unavailable:", err);
        document.body.insertAdjacentHTML("beforeend",
            '<div style="position:fixed;inset:0;display:grid;place-items:center;text-align:center;padding:24px;font:16px/1.5 sans-serif;">' +
            "<p>Curve Cut needs WebGL, which this browser has disabled or doesn't support.<br>" +
            "Try Chrome, Edge, Firefox, or Safari with hardware acceleration on.</p></div>");
        return;
    }
    // lighter framebuffer on low-memory machines (meetup laptops)
    const maxPixelRatio = navigator.deviceMemory && navigator.deviceMemory <= 4 ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
    renderer.setSize(window.innerWidth, window.innerHeight);

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 5000);
    camera.position.set(60, 45, 60);

    const controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 10, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3e, 1.0));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.7);
    keyLight.position.set(1, 2, 1.5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.25);
    fillLight.position.set(-1.5, 0.8, -1);
    scene.add(fillLight);

    let grid = null;
    let gridSpan = 100;

    function rebuildGrid() {
        if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
        const c = isDark ? GRID_COLORS.dark : GRID_COLORS.light;
        grid = new THREE.GridHelper(gridSpan, 20, c.center, c.lines);
        grid.material.transparent = true;
        grid.material.opacity = 0.9;
        scene.add(grid);
    }

    window.addEventListener("resize", () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    (function tick() {
        requestAnimationFrame(tick);
        if (document.hidden) return; // no rendering work in background tabs
        controls.update();
        renderer.render(scene, camera);
    })();

    // ---------------------------------------------------------------- model

    const meshMaterial = new THREE.MeshStandardMaterial({
        color: 0x9a9aa0, metalness: 0.05, roughness: 0.55,
        flatShading: true, // geometry is indexed with no normals (v1.2 memory win)
    });

    const pieces = [];      // THREE.Mesh list — starts as [whole STL], grows with cuts
    let fitDist = 120;      // camera distance that frames the model
    let modelCenter = new THREE.Vector3(0, 10, 0);
    let repairCacheSerial = 0;

    function clearPieces() {
        const materials = new Set();
        for (const p of pieces) {
            scene.remove(p);
            p.geometry.dispose();
            materials.add(p.material);
        }
        pieces.length = 0;
        // history clears on the model-loaded event just after this; leave its
        // shared materials for that sweep, and dispose each live-only one once
        for (const material of materials) {
            if (!window.CurveCut.history || !window.CurveCut.history.isMaterialReferenced ||
                !window.CurveCut.history.isMaterialReferenced(material)) material.dispose();
        }
    }

    /* OBJ/3MF loaders return a Group (possibly nested, possibly transformed
       build items) — flatten every mesh into one world-space triangle soup. */
    function mergeGroupGeometry(root) {
        root.updateMatrixWorld(true);
        const chunks = [];
        let total = 0;
        root.traverse((child) => {
            if (!child.isMesh || !child.geometry) return;
            let g = child.geometry.getIndex()
                ? child.geometry.toNonIndexed() : child.geometry.clone();
            g.applyMatrix4(child.matrixWorld);
            const pos = g.getAttribute("position").array;
            chunks.push(pos);
            total += pos.length;
            g.dispose();
        });
        if (!total) return null;
        const merged = new Float32Array(total);
        let o = 0;
        for (const c of chunks) { merged.set(c, o); o += c.length; }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(merged, 3));
        return geometry;
    }

    function loadModelFile(file) {
        const ext = (file.name.match(/\.(stl|obj|3mf)$/i) || [, "stl"])[1].toLowerCase();
        file.arrayBuffer().then((buffer) => {
            let geometry;
            try {
                if (ext === "obj") {
                    // OBJ is conventionally Y-up already — no rotation
                    const group = new THREE.OBJLoader().parse(new TextDecoder().decode(buffer));
                    geometry = mergeGroupGeometry(group);
                } else if (ext === "3mf") {
                    const group = new THREE.ThreeMFLoader().parse(buffer);
                    geometry = mergeGroupGeometry(group);
                    if (geometry) geometry.rotateX(-Math.PI / 2); // 3MF is Z-up
                } else {
                    geometry = new THREE.STLLoader().parse(buffer);
                    geometry.rotateX(-Math.PI / 2); // STL is Z-up
                }
            } catch (err) {
                console.error(`${ext.toUpperCase()} parse failed:`, err);
                toast(`That file could not be read as a ${ext.toUpperCase()}.`);
                return;
            }
            if (!geometry) {
                toast(`No printable mesh found in that ${ext.toUpperCase()}.`);
                return;
            }
            loadGeometry(geometry, file.name, { upAxis: ext === "obj" ? "y" : "z" });
        }).catch((err) => {
            // arrayBuffer() itself can reject (file moved/locked mid-read)
            console.error("file read failed:", err);
            toast("That file could not be read — try opening it again.");
        });
    }

    /* Shared entry for STL loads and test harnesses: takes a Y-up geometry,
       centers it on the floor, and makes it the scene's single piece. */
    function loadGeometry(geometry, name, options = {}) {
        // a cut/simplify/export in flight owns the piece set — replacing the
        // model under it would commit results onto a corpse
        if (window.CurveCut.ops && window.CurveCut.ops.busy()) {
            geometry.dispose();
            toast("An operation is still running — load the new model when it finishes.");
            return;
        }
        // reject junk BEFORE nuking the current scene: NaN/Inf coordinates
        // poison every boolean downstream, and an empty bbox means no mesh
        geometry.computeBoundingBox();
        const check = geometry.boundingBox;
        const finite = [check.min, check.max].every(
            (v) => isFinite(v.x) && isFinite(v.y) && isFinite(v.z));
        const sz = new THREE.Vector3();
        check.getSize(sz);
        if (!finite || (sz.x === 0 && sz.y === 0 && sz.z === 0)) {
            geometry.dispose();
            toast("That mesh has no usable geometry (empty or corrupt coordinates).");
            return;
        }

        clearPieces();
        window.dispatchEvent(new CustomEvent("curvecut:model-loaded"));

        // Weld the triangle soup into indexed geometry: ~1/3 the memory,
        // and the cut engine needs the welded form anyway.
        if (!geometry.getIndex()) {
            const { vertProperties, triVerts } = CutCore.weldGeometry(geometry);
            geometry.dispose();
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(vertProperties, 3));
            geometry.setIndex(new THREE.BufferAttribute(triVerts, 1));
        } else {
            geometry.deleteAttribute("normal");
        }

        const model = new THREE.Mesh(geometry, meshMaterial.clone());
        model.name = name.replace(/\.(stl|obj|3mf)$/i, "");
        model.userData.sourceName = name;
        scene.add(model);
        pieces.push(model);
        recenterAndRefresh(model);
        revealWorkspace();
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
            { detail: { source: "load" } }));
        if (window.CurveCut.units) window.CurveCut.units.modelLoaded(options);
        scheduleWatertightCheck(model);
    }

    function repairMessage(result) {
        if (result.method === "cap") {
            const holes = result.loops;
            return `Closed ${holes} open hole${holes === 1 ? "" : "s"} — the model is now watertight. (⌘Z to undo)`;
        }
        return `Small gaps repaired — vertices welded within ${result.tol} mm.`;
    }

    function swapRepair(model, result, computeCache = null) {
        let geometry = null;
        try {
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute("position", new THREE.BufferAttribute(result.vertProperties, 3));
            geometry.setIndex(new THREE.BufferAttribute(result.triVerts, 1));
            const next = new THREE.Mesh(geometry, model.material);
            next.name = model.name;
            next.visible = model.visible;
            next.userData = Object.assign({}, model.userData);
            // Big Print is the one flow allowed to leave mesh scale above 1×; preserve it across the swap.
            next.position.copy(model.position);
            next.rotation.copy(model.rotation);
            next.scale.copy(model.scale);
            if (result.method === "cap") {
                next.userData.capRepair = { loops: result.loops };
            } else {
                delete next.userData.capRepair;
            }

            const index = window.CurveCut.pieces.indexOf(model);
            if (index < 0) return false;
            window.CurveCut.history.capture();
            scene.remove(model);
            scene.add(next);
            window.CurveCut.pieces.splice(index, 1, next);
            geometry = null;
            const detail = { source: "repair" };
            if (computeCache) {
                detail.computeCache = Object.assign({}, computeCache, {
                    model: next, geometry: next.geometry,
                });
            }
            window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                { detail }));
            return true;
        } finally {
            if (geometry) geometry.dispose();
        }
    }

    function runRepair(model, automatic = false) {
        // a stale button or auto-check must not repair a replaced piece
        if (pieces[0] !== model) return;
        const ops = window.CurveCut.ops;
        // do not overlap an operation that owns the live piece set
        if (!ops || ops.busy()) {
            if (!automatic) toast("An operation is still running — repair when it finishes.");
            return;
        }

        const op = ops.begin("repair");
        if (!op) {
            if (!automatic) toast("Another operation is still running — one moment.");
            return;
        }
        const compute = window.CurveCut.compute;
        let directEngineStarting = false;
        const run = async () => {
            try {
                if (!op.alive() || pieces[0] !== model) return;

                let result;
                let computeCache = null;
                if (compute && !compute.degraded) {
                    progress.show("Checking the mesh…");
                    const payload = await compute.geometryPayloadAsync(model.geometry);
                    if (!op.alive() || pieces[0] !== model) return;
                    payload.checkWatertight = true;
                    const primeToken = `hollow-repair-${++repairCacheSerial}`;
                    payload.primeToken = primeToken;
                    result = await compute.run("repairGeometry", payload, {
                        transfer: [payload.vertProperties.buffer, payload.triVerts.buffer],
                        onProgress: (message) => {
                            progress.update("Checking the mesh…", message && message.fraction);
                        },
                    });
                    if (!op.alive() || pieces[0] !== model) {
                        if (!compute.degraded) {
                            try { compute.run("release", { token: primeToken }); } catch (_) {}
                        }
                        return;
                    }
                    if (result && result.watertight) {
                        window.dispatchEvent(new CustomEvent("curvecut:repair-cache", {
                            detail: {
                                model, geometry: model.geometry, scale: 1,
                                token: primeToken, worker: compute._worker,
                                primeReady: result.primeReady === true,
                            },
                        }));
                        if (!automatic) toast("Mesh is already watertight — nothing to repair.");
                        return;
                    }
                    computeCache = {
                        token: primeToken, worker: compute._worker, scale: 1,
                        primeReady: result && result.primeReady === true,
                    };
                } else {
                    directEngineStarting = true;
                    await CutCore.init();
                    directEngineStarting = false;
                    if (!op.alive() || pieces[0] !== model) return;
                    if (!automatic) {
                        progress.show("Checking the mesh…");
                        if (CutCore.isWatertight(model.geometry)) {
                            progress.hide();
                            toast("Mesh is already watertight — nothing to repair.");
                            return;
                        }
                    } else if (CutCore.isWatertight(model.geometry)) {
                        return;
                    }
                    result = CutCore.repairGeometry(model.geometry);
                }

                progress.show("This mesh has gaps — attempting a repair…");
                if (!op.alive() || pieces[0] !== model) return;
                if (!result) {
                    toast("This mesh has damage the repair tool can't fix yet — cutting will warn before proceeding.");
                    return;
                }

                if (!window.CurveCut.repair.swapIn(model, result, computeCache)) {
                    if (computeCache && compute && !compute.degraded) {
                        try { compute.run("release", { token: computeCache.token }); } catch (_) {}
                    }
                    return;
                }
                toast(window.CurveCut.repair.message(result));
            } catch (err) {
                console.error("Repair failed:", err);
                toast(directEngineStarting
                    ? "The cutting engine failed to start — the model was not changed."
                    : "Repair failed — the model was not changed.");
            } finally {
                ops.end(op);
                progress.hide();
            }
        };
        setTimeout(run, 60);
    }

    /* v1.6: OBJ/3MF (and sloppy STL) files often have hairline seams. Check
       once after load; the repair ladder reports whether it welded or capped
       the mesh, and leaves whatever it cannot fix for the cutting warning. */
    function scheduleWatertightCheck(model) {
        if (!window.CutCore) return;
        setTimeout(() => {
            if (pieces[0] !== model) return; // replaced in the meantime
            runRepair(model, true);
        }, 400);
    }

    function niceSpan(raw) {
        const steps = [10, 20, 50, 100, 200, 400, 800, 1600, 3200];
        return steps.find((s) => s >= raw) || Math.ceil(raw / 1000) * 1000;
    }

    /* Shared after-load/after-rescale path: floor-seat, then update every
       viewport measurement derived from the model's bounding box. */
    function recenterAndRefresh(model, options = {}) {
        const geometry = model.geometry;
        geometry.computeBoundingBox();
        let bb = geometry.boundingBox;
        if (options.recenter !== false) {
            geometry.translate(
                -(bb.min.x + bb.max.x) / 2,
                -bb.min.y,
                -(bb.min.z + bb.max.z) / 2
            );
            geometry.computeBoundingBox();
            bb = geometry.boundingBox;
        }
        const size = new THREE.Vector3();
        bb.getSize(size);
        gridSpan = niceSpan(Math.max(size.x, size.z) * 2.5);
        rebuildGrid();
        modelCenter = new THREE.Vector3(0, size.y / 2, 0);
        const radius = size.length() / 2;
        fitDist = radius / Math.tan((camera.fov * Math.PI / 180) / 2) * 1.35;
        camera.near = Math.max(fitDist / 1000, 0.01);
        camera.far = fitDist * 50;
        camera.updateProjectionMatrix();
        flyTo(new THREE.Vector3(1, 0.55, 1).normalize());
        const index = geometry.getIndex();
        const tris = (index ? index.count : geometry.attributes.position.count) / 3;
        showStats(model.userData.sourceName || model.name, tris, size);
        return size;
    }

    // ------------------------------------------------------------ snap views

    const VIEW_DIRS = {
        front:  new THREE.Vector3(0, 0, 1),
        back:   new THREE.Vector3(0, 0, -1),
        left:   new THREE.Vector3(-1, 0, 0),
        right:  new THREE.Vector3(1, 0, 0),
        top:    new THREE.Vector3(0, 1, 0.001).normalize(),
        bottom: new THREE.Vector3(0, -1, 0.001).normalize(),
    };

    function flyTo(dir) {
        const dest = modelCenter.clone().addScaledVector(dir, fitDist);
        gsap.to(camera.position, {
            x: dest.x, y: dest.y, z: dest.z,
            duration: 0.9, ease: "power4.out",
        });
        gsap.to(controls.target, {
            x: modelCenter.x, y: modelCenter.y, z: modelCenter.z,
            duration: 0.9, ease: "power4.out",
        });
    }

    const viewDock = document.getElementById("view-dock");
    viewDock.addEventListener("click", (e) => {
        const btn = e.target.closest(".view-btn");
        if (btn) flyTo(VIEW_DIRS[btn.dataset.view]);
    });

    const VIEW_KEYS = ["front", "back", "left", "right", "top", "bottom"];
    window.addEventListener("keydown", (e) => {
        if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey || e.altKey) return;
        if (window.CurveCut.drawActive) return;
        const i = parseInt(e.key, 10) - 1;
        if (pieces.length && i >= 0 && i < VIEW_KEYS.length) flyTo(VIEW_DIRS[VIEW_KEYS[i]]);
    });

    // ------------------------------------------------------------ file input

    const fileInput = document.getElementById("file-input");
    document.getElementById("open-file-btn").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) loadModelFile(fileInput.files[0]);
        fileInput.value = "";
    });

    const dropVeil = document.getElementById("drop-veil");
    let dragDepth = 0;

    window.addEventListener("dragenter", (e) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        dragDepth++;
        dropVeil.classList.add("active");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", () => {
        if (--dragDepth <= 0) { dragDepth = 0; dropVeil.classList.remove("active"); }
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        dropVeil.classList.remove("active");
        const file = [...e.dataTransfer.files].find((f) => /\.(stl|obj|3mf)$/i.test(f.name));
        if (file) loadModelFile(file);
        else if (e.dataTransfer.files.length) toast("Supported files: .stl, .obj, .3mf");
    });

    // ------------------------------------------------------------------- ui

    const heroOverlay = document.getElementById("hero-overlay");
    const statsChip = document.getElementById("stats-chip");
    const statsReset = document.getElementById("stats-reset");
    const statsRepair = document.getElementById("stats-repair");

    function updateStatsResetVisibility() {
        const single = pieces.length === 1;
        statsReset.hidden = !(single && pieces[0].userData.bakedScale);
        statsRepair.hidden = !single;
    }

    function showStats(name, tris, size) {
        document.getElementById("stats-name").textContent = name;
        let detail =
            `${Math.round(tris).toLocaleString()} triangles · ` +
            `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm`;
        const bakedScale = pieces[0] && pieces[0].userData.bakedScale;
        if (Math.abs(bakedScale - 1) > 1e-9) {
            detail += ` · ${window.BigPrintCore.bakedScaleLabel(bakedScale)}`;
        }
        const capRepair = pieces[0] && pieces[0].userData.capRepair;
        if (capRepair) detail += ` · ${capRepair.loops} hole${capRepair.loops === 1 ? "" : "s"} capped`;
        document.getElementById("stats-detail").textContent = detail;
        updateStatsResetVisibility();
    }

    function refreshStatsForModel(model) {
        model.geometry.computeBoundingBox();
        const size = new THREE.Vector3();
        model.geometry.boundingBox.getSize(size);
        const index = model.geometry.getIndex();
        const tris = (index ? index.count : model.geometry.attributes.position.count) / 3;
        showStats(model.userData.sourceName || model.name, tris, size);
    }

    window.addEventListener("curvecut:pieces-changed", () => {
        if (pieces.length === 1) refreshStatsForModel(pieces[0]);
        else updateStatsResetVisibility();
    });

    statsRepair.addEventListener("click", () => {
        if (pieces.length !== 1) return;
        runRepair(pieces[0]);
    });

    let workspaceRevealed = false;
    function revealWorkspace() {
        gsap.to(statsChip, { autoAlpha: 1, y: 0, duration: 0.8, ease: "power4.out" });
        if (workspaceRevealed) return;
        workspaceRevealed = true;
        gsap.to(heroOverlay, {
            autoAlpha: 0, duration: 0.5, ease: "power2.out",
            onComplete: () => heroOverlay.classList.add("hidden"),
        });
        gsap.fromTo(viewDock, { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.8, ease: "power4.out", delay: 0.15 });
        gsap.fromTo("#action-dock", { y: 16 },
            { autoAlpha: 1, y: 0, duration: 0.8, ease: "power4.out", delay: 0.25 });
    }

    /* Back to the empty state — new model, no page reload needed. */
    function startNew() {
        if (window.CurveCut.ops && window.CurveCut.ops.busy()) {
            toast("An operation is still running — one moment.");
            return;
        }
        clearPieces();
        window.dispatchEvent(new CustomEvent("curvecut:model-loaded"));   // clears spline/preview
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed")); // hides the panel

        gsap.to([viewDock, statsChip, "#action-dock"],
            { autoAlpha: 0, y: 10, duration: 0.4, ease: "power2.out" });
        workspaceRevealed = false;

        gsap.to(camera.position, { x: 60, y: 45, z: 60, duration: 0.9, ease: "power4.out" });
        gsap.to(controls.target, { x: 0, y: 10, z: 0, duration: 0.9, ease: "power4.out" });
        gridSpan = 100;
        rebuildGrid();

        heroOverlay.classList.remove("hidden");
        gsap.set(heroOverlay, { autoAlpha: 1 });
        gsap.set(".hero-title, .hero-subtitle, .hero-cta", { opacity: 0, y: 30 });
        tl.restart();
    }

    // persistent aria-live region: screen readers announce text changes here
    // reliably, unlike a freshly-inserted node carrying its own aria-live
    const toastLive = document.createElement("div");
    toastLive.id = "toast-live";
    toastLive.className = "sr-only";
    toastLive.setAttribute("role", "status");
    toastLive.setAttribute("aria-live", "polite");
    document.body.appendChild(toastLive);

    function toast(message) {
        toastLive.textContent = message;
        const el = document.createElement("div");
        el.className = "stats-chip toast glass";
        el.style.cssText = "left: 50%; transform: translateX(-50%); bottom: 84px; visibility: visible; z-index: 160;";
        el.innerHTML = `<span class="stats-name"></span>`;
        el.querySelector(".stats-name").textContent = message;
        document.body.appendChild(el);
        const d = window.CurveCut.a11y ? window.CurveCut.a11y.dur(0.5) : 0.5;
        gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: d, ease: "power4.out" });
        gsap.to(el, { opacity: 0, duration: d, delay: 3, onComplete: () => el.remove() });
    }

    document.getElementById("logo-refresh").addEventListener("click", (e) => {
        e.preventDefault();
        location.reload();
    });
    document.getElementById("new-btn").addEventListener("click", startNew);

    // ------------------------------------------------------------- progress

    const progressPill = document.getElementById("progress-pill");
    const progressLabel = document.getElementById("progress-label");
    const progressEta = document.getElementById("progress-eta");
    const progressTrack = progressPill.querySelector(".progress-track");
    const progressFill = document.getElementById("progress-fill");

    // Deliberately padded so real work tends to finish before the estimate.
    const PADDED_ETA_SECONDS = Object.freeze({
        repair: 30,
        "repair-prime": 45,
        "hollow-prep": 45,
        "bigprint-warm": 45,
        hollow: 120,
        "cut-preview": 45,
        cut: 45,
        simplify: 60,
        export: 45,
        bigprint: 120,
        units: 30,
        orientation: 30,
        calibration: 30,
    });

    let progressState = null;
    let progressEtaTimer = null;

    function motionDuration(seconds) {
        const a11y = window.CurveCut && window.CurveCut.a11y;
        return a11y ? a11y.dur(seconds) : seconds;
    }

    function currentOperation() {
        const ops = window.CurveCut && window.CurveCut.ops;
        return ops && typeof ops.busyName === "function" ? ops.busyName() : null;
    }

    function estimateFor(operation, label) {
        if (operation && PADDED_ETA_SECONDS[operation]) return PADDED_ETA_SECONDS[operation];
        const text = `${operation || ""} ${label || ""}`.toLowerCase();
        if (text.includes("hollow")) return PADDED_ETA_SECONDS.hollow;
        if (text.includes("repair")) return PADDED_ETA_SECONDS.repair;
        if (text.includes("cut")) return PADDED_ETA_SECONDS.cut;
        if (text.includes("simpl")) return PADDED_ETA_SECONDS.simplify;
        if (text.includes("export") || text.includes("zip")) return PADDED_ETA_SECONDS.export;
        return 30;
    }

    function formatEta(seconds) {
        if (seconds < 60) return `~${Math.max(1, Math.ceil(seconds))} sec left`;
        return `~${Math.ceil(seconds / 60)} min left`;
    }

    function motionAllowed() {
        const a11y = window.CurveCut && window.CurveCut.a11y;
        return !a11y || typeof a11y.motionOK !== "function" || a11y.motionOK();
    }

    function refreshEta() {
        if (!progressState) return;
        clearTimeout(progressEtaTimer);
        const elapsed = (performance.now() - progressState.startedAt) / 1000;
        const remaining = progressState.estimate - elapsed;
        progressEta.textContent = progressState.fraction === 1
            ? "Finishing…" : remaining > 0 ? formatEta(remaining) : "Still working…";
        if (!motionAllowed()) return;
        progressEtaTimer = setTimeout(refreshEta, 1000);
    }

    function stopEtaTimer() {
        clearTimeout(progressEtaTimer);
        progressEtaTimer = null;
    }

    function revealProgress() {
        gsap.killTweensOf(progressPill);
        progressPill.setAttribute("aria-hidden", "false");
        gsap.to(progressPill, {
            autoAlpha: 1, y: 0, duration: motionDuration(0.3), ease: "power2.out",
        });
    }

    function updateProgressState(label, frac) {
        const text = label || "Working…";
        const numeric = frac === null || frac === undefined ? null : Number(frac);
        const fraction = Number.isFinite(numeric)
            ? Math.max(0, Math.min(1, numeric)) : null;
        progressLabel.textContent = text;
        progressTrack.classList.toggle("indeterminate", fraction === null);
        if (fraction === null) {
            progressFill.style.width = "";
            progressTrack.removeAttribute("aria-valuenow");
            progressTrack.setAttribute("aria-valuetext", "Working");
        } else {
            const percent = Math.round(fraction * 100);
            progressFill.style.width = `${percent}%`;
            progressTrack.setAttribute("aria-valuenow", String(percent));
            progressTrack.setAttribute("aria-valuetext", `${percent}% complete`);
        }
        if (progressState) {
            progressState.fraction = fraction;
            refreshEta();
        }
    }

    /* frac: 0..1 for a real bar, null for indeterminate shimmer. */
    const progress = {
        show(label) {
            stopEtaTimer();
            const operation = currentOperation();
            progressState = {
                operation,
                estimate: estimateFor(operation, label),
                startedAt: performance.now(),
                fraction: null,
            };
            progressPill.setAttribute("aria-busy", "true");
            updateProgressState(label, null);
            revealProgress();
            refreshEta();
        },
        update(label, frac) {
            if (!progressState) {
                progress.show(label);
            }
            updateProgressState(label, frac);
            revealProgress();
        },
        hide() {
            stopEtaTimer();
            progressState = null;
            progressPill.setAttribute("aria-busy", "false");
            progressPill.setAttribute("aria-hidden", "true");
            gsap.killTweensOf(progressPill);
            gsap.to(progressPill, {
                autoAlpha: 0, duration: motionDuration(0.3), ease: "power2.out",
            });
        },
    };

    window.addEventListener("curvecut:op-ended", (event) => {
        if (!progressState) return;
        const ended = event.detail && event.detail.name;
        if (!ended || ended === progressState.operation) progress.hide();
    });

    // Shared surface for the other modules (pen tool, cut engine).
    window.CurveCut = {
        VERSION: "2.0.2b",
        scene, camera, controls, renderer, canvas,
        drawActive: false,
        spline: null,
        pieces,                       // live array — cut.js splices it on Apply
        getModel: () => pieces[0] || null,
        getModelCenter: () => modelCenter.clone(),
        getFitDist: () => fitDist,
        // the load-time framing ("home position") — the tour uses it on exit
        flyHome: () => flyTo(new THREE.Vector3(1, 0.55, 1).normalize()),
        baseMaterial: meshMaterial,
        toast,
        showStats,
        repair: { message: repairMessage, swapIn: swapRepair },
        loadGeometry,
        scheduleWatertightCheck,
        recenterAndRefresh,
        progress,
    };

    const PILL_OPERATION_LABELS = Object.freeze({
        repair: "Working on the mesh…",
        "repair-prime": "Preparing hollow…",
        hollow: "Hollowing the model…",
        "cut-preview": "Previewing the cut…",
        cut: "Cutting the model…",
        simplify: "Simplifying the model…",
        export: "Preparing the export…",
        bigprint: "Preparing Big Print…",
        "hollow-prep": "Preparing hollow…",
        "bigprint-warm": "Preparing Big Print…",
        units: "Updating units…",
        orientation: "Reorienting the model…",
        calibration: "Calibrating the model…",
    });

    function installOpsProgressHook() {
        const ops = window.CurveCut && window.CurveCut.ops;
        if (!ops || typeof ops.begin !== "function" || ops.begin.progressHooked) return;
        const begin = ops.begin;
        const hookedBegin = function (name) {
            const token = begin.apply(this, arguments);
            if (token && PILL_OPERATION_LABELS[name]) progress.show(PILL_OPERATION_LABELS[name]);
            return token;
        };
        hookedBegin.progressHooked = true;
        ops.begin = hookedBegin;
    }

    setTimeout(installOpsProgressHook, 0);
    window.addEventListener("load", installOpsProgressHook);

    // ------------------------------------------------------------- entrance

    applyTheme(isDark, false);
    rebuildGrid();

    const tl = gsap.timeline({ defaults: { ease: "power4.out", duration: 1.2 } });
    gsap.set(".header-nav", { opacity: 0, y: -12 });
    tl.to(".hero-title", { opacity: 1, y: 0, delay: 0.2 })
      .to(".hero-subtitle", { opacity: 1, y: 0 }, "-=0.9")
      .to(".hero-cta", { opacity: 1, y: 0 }, "-=0.9")
      .to(".header-nav", { opacity: 1, y: 0, duration: 0.8 }, "-=1.0");
})();
