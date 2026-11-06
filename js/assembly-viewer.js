/* Curve Cut — the 3D assembly viewer itself.
   window.AssemblyViewer = { mount, loadSource }.
   Runs inside every exported assembly.html and (later) inside the app, so it
   never touches CC/CurveCut. mount() uses only what it is handed (THREE, with
   THREE.OrbitControls) plus AssemblyCore.unpackMesh, owns its own renderer,
   scene and camera, and works in any container. This file is inlined into
   assembly.html: no script-tag text or HTML comment openers in here. */

(() => {
    "use strict";

    const HOME_DIRECTION = [1, 0.55, 1];  // the app's flyHome direction
    const FOV = 40;
    const NARROW_PX = 720;
    const TAP_PX = 6;
    const TAP_MS = 500;
    const FADED = 0.15;
    const EMPTY_CARD = "Tap or click a part to see its ID.";
    const NO_WEBGL = "This page needs WebGL to show the 3D view. The part list is in manifest.txt.";
    const FOOTER = "Made with curve cut — AGPL-3.0, source at github.com/MaxSikorski/curve-cut · "
        + "three.js and fflate under MIT (see page source)";

    const CSS = `
.ccav{--ccav-bg:#f5f5f7;--ccav-fg:#000;--ccav-muted:rgba(0,0,0,.5);--ccav-line:rgba(0,0,0,.18);
 position:relative;width:100%;height:100%;display:flex;flex-direction:row;overflow:hidden;
 background:var(--ccav-bg);color:var(--ccav-fg);box-sizing:border-box;
 font:15px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){.ccav{--ccav-bg:#000;--ccav-fg:#fff;--ccav-muted:rgba(255,255,255,.5);--ccav-line:rgba(255,255,255,.25)}}
.ccav *{box-sizing:border-box}
.ccav-view{position:relative;flex:1 1 auto;min-width:0;min-height:0;overflow:hidden;user-select:none;-webkit-user-select:none}
.ccav-view canvas{display:block;width:100%;height:100%;touch-action:none}
.ccav-panel{flex:0 0 300px;overflow:auto;padding:16px;border-left:1px solid var(--ccav-line)}
.ccav-narrow{flex-direction:column}
.ccav-narrow .ccav-view{flex:0 0 50%}
.ccav-narrow .ccav-panel{flex:1 1 auto;border-left:0;border-top:1px solid var(--ccav-line)}
.ccav-title{margin:0 0 4px;font-size:20px;font-weight:700;overflow-wrap:anywhere}
.ccav-meta,.ccav-note,.ccav-foot{margin:0 0 8px;color:var(--ccav-muted);font-size:13px}
.ccav-foot{margin:16px 0 0;font-size:12px}
.ccav-card{margin:12px 0;padding:12px;border:1px solid var(--ccav-line);border-radius:12px;min-height:84px}
.ccav-card-id{font-size:24px;font-weight:700;margin-bottom:4px}
.ccav-card-empty{color:var(--ccav-muted)}
.ccav-row{display:block;margin:12px 0 4px;font-weight:600}
.ccav-slider{display:block;width:100%;height:44px;margin:0;background:transparent;-webkit-appearance:none;appearance:none}
.ccav-slider::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:var(--ccav-muted)}
.ccav-slider::-webkit-slider-thumb{-webkit-appearance:none;width:44px;height:44px;margin-top:-20px;border-radius:50%;background:var(--ccav-fg);border:0}
.ccav-slider::-moz-range-track{height:4px;border-radius:2px;background:var(--ccav-muted)}
.ccav-slider::-moz-range-thumb{width:44px;height:44px;border-radius:50%;background:var(--ccav-fg);border:0}
.ccav-btn{min-height:44px;min-width:44px;padding:0 16px;border:1px solid var(--ccav-line);border-radius:30px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.ccav-label{position:absolute;left:0;top:0;display:none;pointer-events:none;transform:translate(-50%,-50%);padding:2px 10px;border-radius:999px;background:var(--ccav-fg);color:var(--ccav-bg);font-size:13px;font-weight:700;white-space:nowrap}
.ccav-nogl{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;color:var(--ccav-muted)}
`;

    function injectStyle(doc) {
        if (doc.getElementById("ccav-style")) return;
        const style = doc.createElement("style");
        style.id = "ccav-style";
        style.textContent = CSS;
        doc.head.appendChild(style);
    }

    function el(doc, tag, className, text) {
        const node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function cardLines(data, part) {
        const counts = data.grid.counts;
        const rows = counts.z;
        const ri = part.cell.ri;
        const where = ri + 1 === rows && rows > 1 ? " (front)" : ri === 0 && rows > 1 ? " (back)" : "";
        const letters = (/^[A-Z]+/.exec(part.id) || [""])[0];
        const near = part.neighbours && part.neighbours.length
            ? `Touches ${part.neighbours.join(", ")}` : "Touches no other part";
        return [
            part.id,
            `Layer ${part.cell.li + 1} of ${counts.y} · row ${ri + 1} of ${rows}${where} · column ${letters}`,
            near,
            `File ${part.file}`,
        ];
    }

    function mount(container, deps) {
        const T = deps.THREE;
        const data = deps.data;
        const bytes = deps.bytes;
        const doc = container.ownerDocument;
        injectStyle(doc);

        const root = el(doc, "div", "ccav");
        const view = el(doc, "div", "ccav-view");
        const panel = el(doc, "div", "ccav-panel");
        root.append(view, panel);

        // ---- panel ----
        const size = data.size;
        const n = data.parts.length;
        const note = "Simplified shapes — the part files are full detail."
            + (data.detail && data.detail.halved ? " Half detail to stay under 6 MB." : "");
        const cardBox = el(doc, "div", "ccav-card");
        cardBox.setAttribute("aria-live", "polite");
        const slider = el(doc, "input", "ccav-slider");
        slider.type = "range";
        slider.min = "0"; slider.max = "1"; slider.step = "0.01"; slider.value = "0";
        slider.id = "ccav-explode-" + Math.random().toString(36).slice(2, 8);
        const sliderLabel = el(doc, "label", "ccav-row", "Pull apart");
        sliderLabel.htmlFor = slider.id;
        const resetBtn = el(doc, "button", "ccav-btn", "Reset view");
        resetBtn.type = "button";
        panel.append(
            el(doc, "h1", "ccav-title", data.name),
            el(doc, "p", "ccav-meta",
                `${n} parts · ×${data.scale} · ${Math.round(size.x)} × ${Math.round(size.z)} × ${Math.round(size.y)} mm (W×D×H)`),
            el(doc, "p", "ccav-note", note),
            cardBox, sliderLabel, slider, resetBtn,
            el(doc, "p", "ccav-foot", FOOTER));
        container.appendChild(root);

        let cardString = "";
        function showCard(part) {
            cardBox.textContent = "";
            if (!part) {
                cardBox.append(el(doc, "div", "ccav-card-empty", EMPTY_CARD));
                cardString = EMPTY_CARD;
                return;
            }
            const lines = cardLines(data, part);
            cardBox.append(el(doc, "div", "ccav-card-id", lines[0]));
            for (const line of lines.slice(1)) cardBox.append(el(doc, "div", "", line));
            cardString = lines.join("\n");
        }
        showCard(null);

        // ---- 3D ----
        let renderer = null;
        try {
            renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
        } catch (err) {
            renderer = null;
        }
        const partById = new Map(data.parts.map((p) => [p.id, p]));
        const origin = data.origin || { x: 0, y: size.y / 2, z: 0 };
        const scene = new T.Scene();
        const camera = new T.PerspectiveCamera(FOV, 1, 0.1, 1000);
        const meshes = [];
        const meshById = new Map();
        const owned = [];                  // geometries and materials to dispose
        const label = el(doc, "div", "ccav-label");
        let canvas = null;
        let sun = null;
        let controls = null;
        let sphereCentre = new T.Vector3();
        let radius = 100;
        let selectedId = null;
        let explodeK = 0;
        let disposed = false;
        let raf = 0;

        const whole = new T.Box3();
        for (const part of data.parts) {
            whole.expandByPoint(new T.Vector3(...part.box.min));
            whole.expandByPoint(new T.Vector3(...part.box.max));
        }
        if (whole.isEmpty()) whole.set(new T.Vector3(-1, -1, -1), new T.Vector3(1, 1, 1));
        const sphere = new T.Sphere();
        whole.getBoundingSphere(sphere);
        sphereCentre = sphere.center.clone();
        radius = Math.max(sphere.radius, 1);

        if (!renderer) {
            view.append(el(doc, "div", "ccav-nogl", NO_WEBGL));
        } else {
            renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            renderer.setClearColor(0x000000, 0);
            canvas = renderer.domElement;
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", `3D view of ${data.name}, ${n} parts`);
            view.append(canvas, label);

            scene.add(new T.HemisphereLight(0xffffff, 0x888888, 0.7));
            sun = new T.DirectionalLight(0xffffff, 0.9);
            scene.add(sun, sun.target);

            data.parts.forEach((part, i) => {
                const colour = new T.Color().setHSL((i * 0.137) % 1, 0.42, 0.62);
                let geometry;
                let material;
                let mesh;
                if (part.mesh) {
                    geometry = new T.BufferGeometry();
                    const unpacked = AssemblyCore.unpackMesh(part.mesh, bytes);
                    geometry.setAttribute("position", new T.BufferAttribute(unpacked.position, 3));
                    geometry.setIndex(new T.BufferAttribute(unpacked.index, 1));
                    material = new T.MeshStandardMaterial({ color: colour, flatShading: true });
                    mesh = new T.Mesh(geometry, material);
                } else {
                    // no shape stored: an outline box, still selectable through an invisible box
                    const b = part.box;
                    const dims = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
                    geometry = new T.BoxGeometry(dims[0], dims[1], dims[2]).translate(
                        (b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
                    material = new T.MeshBasicMaterial({ visible: false });
                    mesh = new T.Mesh(geometry, material);
                    const edges = new T.EdgesGeometry(geometry);
                    const lineMaterial = new T.LineBasicMaterial({ color: colour });
                    mesh.add(new T.LineSegments(edges, lineMaterial));
                    owned.push(edges, lineMaterial);
                }
                mesh.userData.id = part.id;
                owned.push(geometry, material);
                meshes.push(mesh);
                meshById.set(part.id, mesh);
                scene.add(mesh);
            });

            controls = new T.OrbitControls(camera, canvas);
            controls.enableDamping = false;
        }

        const raycaster = new T.Raycaster();
        const direction = new T.Vector3(...HOME_DIRECTION).normalize();

        function fitDistance() {
            const aspect = camera.aspect || 1;
            const vHalf = (FOV * Math.PI) / 360;
            const hHalf = Math.atan(Math.tan(vHalf) * aspect);
            return (radius / Math.sin(Math.min(vHalf, hHalf))) * 1.05;
        }

        function resetView() {
            const dist = fitDistance();
            camera.near = Math.max(radius * 0.02, 0.1);
            camera.far = dist + radius * 30;
            camera.position.copy(sphereCentre).addScaledVector(direction, dist);
            camera.updateProjectionMatrix();
            if (controls) {
                controls.target.copy(sphereCentre);
                controls.minDistance = radius * 0.3;
                controls.maxDistance = radius * 20;
                controls.update();
            } else {
                camera.lookAt(sphereCentre);
            }
            render();
        }

        function boxCentre(id) {
            const b = partById.get(id).box;
            const c = new T.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2,
                (b.min[2] + b.max[2]) / 2);
            const mesh = meshById.get(id);
            if (mesh) c.add(mesh.position);
            return c;
        }

        function updateLabel() {
            if (!canvas || selectedId === null) { label.style.display = "none"; return; }
            const p = boxCentre(selectedId).project(camera);
            if (p.z > 1 || p.z < -1) { label.style.display = "none"; return; }
            label.textContent = selectedId;
            label.style.display = "block";
            label.style.left = ((p.x + 1) / 2) * view.clientWidth + "px";
            label.style.top = ((1 - p.y) / 2) * view.clientHeight + "px";
        }

        function render() {
            if (disposed || !renderer) return;
            sun.position.copy(camera.position);
            sun.target.position.copy(controls ? controls.target : sphereCentre);
            renderer.render(scene, camera);
            updateLabel();
        }

        function requestRender() {
            if (raf || disposed) return;
            raf = requestAnimationFrame(() => { raf = 0; render(); });
        }
        if (controls) controls.addEventListener("change", requestRender);

        function applyLook() {
            for (const mesh of meshes) {
                const material = mesh.material;
                if (!material.emissive) continue;   // outline-only parts have no lit material
                const picked = selectedId !== null && mesh.userData.id === selectedId;
                const faded = selectedId !== null && !picked;
                material.emissive.setHex(picked ? 0x888888 : 0x000000);
                material.transparent = faded;
                material.opacity = faded ? FADED : 1;
                material.depthWrite = !faded;   // faded parts must not hide what is behind them
                material.needsUpdate = true;
            }
            showOutline();
        }

        // the picked part also gets a thin outline in the text colour
        let outline = null;
        function showOutline() {
            if (outline) {
                outline.parent.remove(outline);
                outline.geometry.dispose();
                outline.material.dispose();
                outline = null;
            }
            const mesh = selectedId === null ? null : meshById.get(selectedId);
            if (!mesh || !mesh.geometry.getAttribute("position") || mesh.material.visible === false) return;
            const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
            outline = new T.LineSegments(new T.EdgesGeometry(mesh.geometry, 35),
                new T.LineBasicMaterial({ color: dark ? 0xffffff : 0x000000 }));
            mesh.add(outline);
        }

        function select(id) {
            const next = id !== null && partById.has(id) ? id : null;
            selectedId = next;
            showCard(next === null ? null : partById.get(next));
            applyLook();
            render();
            if (deps.onSelect) deps.onSelect(next);
        }

        function setExplode(k) {
            explodeK = Math.min(Math.max(+k || 0, 0), 1);
            slider.value = String(explodeK);
            for (const part of data.parts) {
                const mesh = meshById.get(part.id);
                if (!mesh) continue;
                const o = AssemblyCore.explodedPosition(
                    { x: part.center[0], y: part.center[1], z: part.center[2] }, origin, explodeK);
                mesh.position.set(o.x, o.y, o.z);
            }
            render();
        }

        function screenPointOf(id) {
            const mesh = meshById.get(id);
            if (!mesh || !canvas) return null;
            scene.updateMatrixWorld(true);
            camera.updateMatrixWorld();
            const rect = canvas.getBoundingClientRect();
            const centre = boxCentre(id);
            const tries = [centre];
            const position = mesh.geometry.getAttribute("position");
            if (mesh.material.visible !== false) {
                const stride = Math.max(1, Math.floor(position.count / 12));
                for (let i = 0; i < position.count && tries.length < 13; i += stride) {
                    const v = new T.Vector3().fromBufferAttribute(position, i).add(mesh.position);
                    tries.push(v.lerp(centre, 0.1));
                }
            }
            for (const world of tries) {
                const p = world.clone().project(camera);
                if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z > 1) continue;
                raycaster.setFromCamera({ x: p.x, y: p.y }, camera);
                const hit = raycaster.intersectObjects(meshes, false)[0];
                if (hit && hit.object === mesh) {
                    return { x: rect.left + ((p.x + 1) / 2) * rect.width,
                        y: rect.top + ((1 - p.y) / 2) * rect.height };
                }
            }
            return null;
        }

        function pick(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            scene.updateMatrixWorld(true);
            camera.updateMatrixWorld();
            raycaster.setFromCamera({
                x: ((clientX - rect.left) / rect.width) * 2 - 1,
                y: -(((clientY - rect.top) / rect.height) * 2 - 1),
            }, camera);
            const hit = raycaster.intersectObjects(meshes, false)[0];
            select(hit ? hit.object.userData.id : null);
        }

        // a tap is a short press that barely moved; anything else was an orbit
        let press = null;
        const onDown = (e) => {
            if (press && press.id !== e.pointerId) { press.valid = false; return; }
            press = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(),
                far: 0, valid: true };
        };
        const onMove = (e) => {
            if (!press || press.id !== e.pointerId) return;
            press.far = Math.max(press.far, Math.hypot(e.clientX - press.x, e.clientY - press.y));
        };
        const onUp = (e) => {
            if (!press || press.id !== e.pointerId) return;
            onMove(e);                  // measure the release point before clearing the press
            const done = press;
            press = null;
            if (done.valid && done.far < TAP_PX && performance.now() - done.t < TAP_MS) {
                pick(e.clientX, e.clientY);
            }
        };
        const onCancel = () => { press = null; };
        if (canvas) {
            canvas.addEventListener("pointerdown", onDown);
            canvas.addEventListener("pointermove", onMove);
            canvas.addEventListener("pointerup", onUp);
            canvas.addEventListener("pointercancel", onCancel);
        }

        slider.addEventListener("input", () => setExplode(slider.value));
        resetBtn.addEventListener("click", resetView);

        function layout() {
            if (disposed) return;
            root.classList.toggle("ccav-narrow", container.clientWidth < NARROW_PX);
            if (!renderer) return;
            const w = Math.max(view.clientWidth, 1);
            const h = Math.max(view.clientHeight, 1);
            renderer.setSize(w, h, false);
            camera.aspect = w / h;
            camera.updateProjectionMatrix();
            render();
        }
        let observer = null;
        if (typeof ResizeObserver === "function") {
            observer = new ResizeObserver(layout);
            observer.observe(container);
        } else {
            window.addEventListener("resize", layout);
        }
        layout();
        resetView();

        function dispose() {
            if (disposed) return;
            disposed = true;
            if (raf) cancelAnimationFrame(raf);
            if (observer) observer.disconnect();
            else window.removeEventListener("resize", layout);
            if (canvas) {
                canvas.removeEventListener("pointerdown", onDown);
                canvas.removeEventListener("pointermove", onMove);
                canvas.removeEventListener("pointerup", onUp);
                canvas.removeEventListener("pointercancel", onCancel);
            }
            if (controls) controls.dispose();
            selectedId = null;
            showOutline();
            for (const item of owned) item.dispose();
            if (renderer) {
                renderer.dispose();
                renderer.forceContextLoss();
            }
            if (root.parentNode) root.parentNode.removeChild(root);
        }

        return {
            partCount: () => n,
            ids: () => data.parts.map((p) => p.id),
            select, selected: () => selectedId,
            setExplode, screenPointOf,
            cardText: () => cardString,
            meshOf: (id) => meshById.get(id) || null,
            dispose,
        };
    }

    // ---- lazy source: only people who export pay for the ~720 KB ----
    let sourcePromise = null;
    function loadSource() {
        if (sourcePromise) return sourcePromise;
        sourcePromise = new Promise((resolve, reject) => {
            if (window.CurveCutAssemblyViewerSource) {
                resolve(window.CurveCutAssemblyViewerSource);
                return;
            }
            const tag = document.createElement("script");
            const fail = (message) => {
                sourcePromise = null;   // a later export retries
                if (tag.parentNode) tag.parentNode.removeChild(tag);
                reject(new Error(message));
            };
            tag.src = "js/assembly-viewer-src.js";
            tag.onload = () => {
                if (window.CurveCutAssemblyViewerSource) resolve(window.CurveCutAssemblyViewerSource);
                else fail("assembly viewer source loaded but defined nothing");
            };
            tag.onerror = () => fail("could not load js/assembly-viewer-src.js");
            document.head.appendChild(tag);
        });
        return sourcePromise;
    }

    window.AssemblyViewer = { mount, loadSource };
})();
