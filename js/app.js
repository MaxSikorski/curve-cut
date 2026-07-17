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
                { rotation: 360, scale: 1, duration: 0.6, ease: "power2.out" });
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

    function clearPieces() {
        for (const p of pieces) {
            scene.remove(p);
            p.geometry.dispose();
        }
        pieces.length = 0;
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
            loadGeometry(geometry, file.name);
        }).catch((err) => {
            // arrayBuffer() itself can reject (file moved/locked mid-read)
            console.error("file read failed:", err);
            toast("That file could not be read — try opening it again.");
        });
    }

    /* Shared entry for STL loads and test harnesses: takes a Y-up geometry,
       centers it on the floor, and makes it the scene's single piece. */
    function loadGeometry(geometry, name) {
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

        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const size = new THREE.Vector3();
        bb.getSize(size);

        // Center on origin, seat the lowest point on the grid floor.
        geometry.translate(
            -(bb.min.x + bb.max.x) / 2,
            -bb.min.y,
            -(bb.min.z + bb.max.z) / 2
        );

        const model = new THREE.Mesh(geometry, meshMaterial.clone());
        model.name = name.replace(/\.(stl|obj|3mf)$/i, "");
        scene.add(model);
        pieces.push(model);

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
        showStats(name, tris, size);
        revealWorkspace();
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed"));
        if (tris <= 500000) scheduleWatertightCheck(model);
        // heavier meshes hit the simplify offer first; its own flow reports leaks
    }

    /* v1.6: OBJ/3MF (and sloppy STL) files often have hairline seams. Check
       once after load; when a coarser weld closes the mesh, swap it in and
       say so — when nothing helps, say that too (cuts will refuse it later). */
    function scheduleWatertightCheck(model) {
        if (!window.CutCore) return;
        CutCore.init().then(() => setTimeout(() => {
            if (pieces[0] !== model) return; // replaced in the meantime
            if (CutCore.isWatertight(model.geometry)) return;
            progress.show("This mesh has gaps — attempting a repair…");
            setTimeout(() => {
                const r = CutCore.repairGeometry(model.geometry);
                progress.hide();
                if (pieces[0] !== model) return;
                if (r) {
                    const g = new THREE.BufferGeometry();
                    g.setAttribute("position", new THREE.BufferAttribute(r.vertProperties, 3));
                    g.setIndex(new THREE.BufferAttribute(r.triVerts, 1));
                    model.geometry.dispose();
                    model.geometry = g;
                    toast(`Small gaps repaired — vertices welded within ${r.tol} mm.`);
                } else {
                    toast("This model isn't watertight and couldn't be auto-repaired — cutting will refuse it.");
                }
            }, 60);
        }, 400));
    }

    function niceSpan(raw) {
        const steps = [10, 20, 50, 100, 200, 400, 800, 1600, 3200];
        return steps.find((s) => s >= raw) || Math.ceil(raw / 1000) * 1000;
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

    function showStats(name, tris, size) {
        document.getElementById("stats-name").textContent = name;
        document.getElementById("stats-detail").textContent =
            `${Math.round(tris).toLocaleString()} triangles · ` +
            `${size.x.toFixed(1)} × ${size.z.toFixed(1)} × ${size.y.toFixed(1)} mm`;
    }

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

    function toast(message) {
        const el = document.createElement("div");
        el.className = "stats-chip glass";
        el.style.cssText = "left: 50%; transform: translateX(-50%); bottom: 84px; visibility: visible; z-index: 160;";
        el.innerHTML = `<span class="stats-name"></span>`;
        el.querySelector(".stats-name").textContent = message;
        document.body.appendChild(el);
        gsap.fromTo(el, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.5, ease: "power4.out" });
        gsap.to(el, { opacity: 0, duration: 0.5, delay: 3, onComplete: () => el.remove() });
    }

    document.getElementById("logo-refresh").addEventListener("click", (e) => {
        e.preventDefault();
        location.reload();
    });
    document.getElementById("new-btn").addEventListener("click", startNew);

    // ------------------------------------------------------------- progress

    const progressPill = document.getElementById("progress-pill");
    const progressLabel = document.getElementById("progress-label");
    const progressTrack = progressPill.querySelector(".progress-track");
    const progressFill = document.getElementById("progress-fill");

    /* frac: 0..1 for a real bar, null for indeterminate shimmer. */
    const progress = {
        show(label) {
            progress.update(label, null);
            gsap.to(progressPill, { autoAlpha: 1, y: 0, duration: 0.3, ease: "power2.out" });
        },
        update(label, frac) {
            progressLabel.textContent = label;
            const indeterminate = frac === null || frac === undefined;
            progressTrack.classList.toggle("indeterminate", indeterminate);
            if (!indeterminate) progressFill.style.width = `${Math.round(frac * 100)}%`;
        },
        hide() {
            gsap.to(progressPill, { autoAlpha: 0, duration: 0.3, ease: "power2.out" });
        },
    };

    // Shared surface for the other modules (pen tool, cut engine).
    window.CurveCut = {
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
        loadGeometry,
        progress,
    };

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
