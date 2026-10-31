/* Curve Cut — operation-coordinator race/failure harness (v2.0.2)
   Runs ONLY when the page is opened as index.html#racetest (headless, via
   tools/check_race.py). Drives the real production UI path and reports:
   "RACE ok=<n> fail=<m>" (with failure names when needed). Inert normally. */

(() => {
    "use strict";

    // dev-only: never let the public site URL + #racetest run the race suite
    const isDev = location.protocol === "file:" ||
        location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (window.location.hash !== "#racetest" || !isDev) return;
    const CC = window.CurveCut;
    // Chromium ships the File System Access save picker (Brave hides it); the
    // scenarios assume no picker unless one injects its own.
    window.showSaveFilePicker = undefined;

    const TIMEOUT = 120000;
    const exportBtn = document.getElementById("bp-export");
    const newBtn = document.getElementById("new-btn");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function assert(condition, message) {
        if (!condition) throw new Error(message);
    }

    function waitFor(test, label, timeout = TIMEOUT) {
        return new Promise((resolve, reject) => {
            const started = performance.now();
            const poll = () => {
                let ready = false;
                try { ready = test(); } catch (err) { reject(err); return; }
                if (ready) { resolve(); return; }
                if (performance.now() - started >= timeout) {
                    reject(new Error(`timed out waiting for ${label}`));
                    return;
                }
                setTimeout(poll, 10);
            };
            poll();
        });
    }

    function once(name, predicate = () => true, timeout = TIMEOUT) {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer);
                window.removeEventListener(name, handler);
            };
            const handler = (event) => {
                if (!predicate(event)) return;
                cleanup();
                resolve(event);
            };
            const timer = setTimeout(() => {
                cleanup();
                reject(new Error(`timed out waiting for ${name}`));
            }, timeout);
            window.addEventListener(name, handler);
        });
    }

    const trisOf = (piece) => {
        const geometry = piece.geometry;
        return (geometry.getIndex()
            ? geometry.getIndex().count
            : geometry.getAttribute("position").count) / 3;
    };

    function volumeOf(piece) {
        const solid = CutCore.toManifold(piece.geometry);
        try {
            return solid.volume();
        } finally {
            solid.delete();
        }
    }

    async function resetState() {
        if (CC.ops.busy()) {
            await waitFor(() => !CC.ops.busy(), "the current operation to end");
        }
        if (CC.bigPrint.isActive()) CC.bigPrint.exit();
        newBtn.click();
        assert(CC.pieces.length === 0, "Start New did not clear the model");
    }

    function setSmallBigPrintGrid() {
        const set = (id, value) => {
            const input = document.getElementById(id);
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("bp-bed-w", 12);
        set("bp-bed-d", 30);
        set("bp-bed-h", 30);
        set("bp-margin", 1);
        document.getElementById("bp-connectors").checked = false;
        document.getElementById("bp-engrave").checked = false;
        document.getElementById("bp-format").value = "stl";
        assert(!exportBtn.disabled, "small Big Print grid is not exportable");
    }

    function setCappedBigPrintGrid(scale) {
        const set = (id, value) => {
            const input = document.getElementById(id);
            input.value = value;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        };
        set("bp-bed-w", 10);
        set("bp-bed-d", 10);
        set("bp-bed-h", 10);
        set("bp-margin", 4);
        set("bp-scale", scale);
        const size = 20 * scale;
        return BigPrintCore.computeGrid({
            size: { x: size, y: size, z: size },
            bed: { w: 10, d: 10, h: 10 },
            margin: 4,
            nudge: { x: 0, y: 0, z: 0 },
        });
    }

    async function cancelBigPrintExport() {
        CC.bigPrint._lastExport = null;
        exportBtn.click();
        // begin() runs synchronously inside the click, and the export's first
        // await (the 30ms pill paint) comes before any grid cell is cut — so
        // an immediate Escape ALWAYS cancels mid-run, never after completion
        assert(CC.ops.busyName() === "bigprint",
            "export did not take the op token synchronously");
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await once("curvecut:op-ended", (event) => event.detail.name === "bigprint");
        // cancellation must be DISTINGUISHABLE from completion (a completed
        // run publishes _lastExport and toasts "done"; a cancelled one
        // publishes nothing and toasts "Stopped") — without these two asserts
        // this scenario passes even with the Escape handler deleted
        assert(CC.bigPrint._lastExport === null,
            "cancelled export still published _lastExport — it ran to completion");
        assert(document.getElementById("toast-live").textContent.includes("Stopped"),
            "the cancellation toast never appeared");
        assert(!CC.ops.busy(), "Big Print token remained live after cancellation");
        assert(CC.bigPrint.isActive(), "Escape exited Big Print mode during export");
        assert(!exportBtn.disabled, "export button stayed disabled after cancellation");
    }

    const scenarios = [
        ["model-replacement-mid-cut", async () => {
            await resetState();
            await CutCore.init();
            const torus = new THREE.TorusKnotGeometry(30, 10, 250, 100).toNonIndexed();
            CC.loadGeometry(torus, "race-cut-torus.stl");
            const original = CC.pieces[0];
            assert(original && Math.round(trisOf(original)) === 50000,
                "the cut fixture did not load at 50k triangles");

            const center = CC.getModelCenter();
            const V = (x, y, z) => new THREE.Vector3(x, y, z);
            CC.spline = {
                points: [
                    { a: V(center.x, center.y + 500, center.z), hIn: null, hOut: null },
                    { a: V(center.x, center.y - 500, center.z), hIn: null, hOut: null },
                ],
                normal: V(0, 0, 1),
                planePoint: center,
            };
            window.dispatchEvent(new CustomEvent("curvecut:spline-ready"));
            document.getElementById("cut-apply").click();
            await waitFor(() => CC.ops.busyName() === "cut", "cut token");

            let modelLoads = 0;
            const sawLoad = () => { modelLoads++; };
            window.addEventListener("curvecut:model-loaded", sawLoad);
            try {
                CC.loadGeometry(new THREE.BoxGeometry(8, 8, 8).toNonIndexed(),
                    "must-be-refused.stl");
            } finally {
                window.removeEventListener("curvecut:model-loaded", sawLoad);
            }
            assert(modelLoads === 0, "replacement dispatched model-loaded");
            assert(CC.pieces.length === 1 && CC.pieces[0] === original,
                "replacement changed pieces before the cut committed");
            assert(document.getElementById("toast-live").textContent.includes("operation is still running"),
                "replacement refusal toast was not shown");

            const cutChanged = once("curvecut:pieces-changed");
            const cutEnded = once("curvecut:op-ended",
                (event) => event.detail.name === "cut");
            await Promise.all([cutChanged, cutEnded]);
            assert(CC.pieces.length === 2, `cut committed ${CC.pieces.length} pieces instead of 2`);
            assert(!CC.ops.busy(), "cut token remained live after commit");
        }],

        ["start-new-during-simplify", async () => {
            await resetState();
            const heavy = new THREE.TorusKnotGeometry(60, 20, 1500, 200).toNonIndexed();
            CC.loadGeometry(heavy, "race-simplify-torus.stl");
            const original = CC.pieces[0];
            const before = trisOf(original);
            assert(before > 500000, `simplify fixture has only ${before} triangles`);

            document.getElementById("simplify-go").click();
            await waitFor(() => CC.ops.busyName() === "simplify", "simplify token");
            newBtn.click();
            assert(CC.pieces.length === 1 && CC.pieces[0] === original,
                "Start New replaced the model during simplify");
            assert(document.getElementById("toast-live").textContent.includes("operation is still running"),
                "Start New refusal toast was not shown");

            const simplifyChanged = once("curvecut:pieces-changed");
            const simplifyEnded = once("curvecut:op-ended",
                (event) => event.detail.name === "simplify");
            await Promise.all([simplifyChanged, simplifyEnded]);
            assert(CC.pieces.length === 1, `simplify left ${CC.pieces.length} pieces`);
            assert(CC.pieces[0] !== original, "simplify did not commit a replacement mesh");
            assert(trisOf(CC.pieces[0]) < before, "simplify did not reduce triangles");
            assert(!CC.ops.busy(), "simplify token remained live after commit");
        }],

        ["escape-during-export", async () => {
            await resetState();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-cancel-cube.stl");
            assert(CC.pieces.length === 1, "Big Print cancellation fixture is not one piece");
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open");
            setSmallBigPrintGrid();

            await cancelBigPrintExport();

            // A cancelled run must not poison the next begin(). Start it, then
            // stop it too so the following fallback scenario gets clean state.
            exportBtn.click();
            await waitFor(() => CC.ops.busyName() === "bigprint", "second Big Print export");
            assert(exportBtn.disabled, "second export did not enter its running state");
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
            await once("curvecut:op-ended", (event) => event.detail.name === "bigprint");
            assert(CC.bigPrint.isActive() && !exportBtn.disabled,
                "second cancelled export did not return to the live mode");
        }],

        ["bigprint-cancel-restores", async () => {
            await resetState();
            await CutCore.init();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-restore-cube.stl");
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open for scale-only test");
            const scaleInput = document.getElementById("bp-scale");
            scaleInput.value = 3;
            scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
            assert(CC.pieces[0].scale.x === 3, "scale-only fixture did not reach 3x");
            CC.bigPrint.exit();
            assert(CC.pieces[0].scale.x === 1,
                `scale-only cancel left model scale at ${CC.pieces[0].scale.x}`);

            const beforeVolume = volumeOf(CC.pieces[0]);
            const beforeTris = trisOf(CC.pieces[0]);
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open for restore test");

            scaleInput.value = 3;
            scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
            const hollowOn = document.getElementById("bp-hollow-on");
            hollowOn.checked = true;
            hollowOn.dispatchEvent(new Event("change", { bubbles: true }));
            document.getElementById("bp-hollow-wall").value = 2;
            const hollowChanged = once("curvecut:pieces-changed",
                (event) => event.detail.source === "hollow");
            const hollowEnded = once("curvecut:op-ended",
                (event) => event.detail.name === "hollow");
            document.getElementById("bp-hollow-apply").click();
            await Promise.all([hollowChanged, hollowEnded]);
            assert(CC.pieces[0].userData.bigPrintHollow,
                "restore fixture was not hollowed");

            const hollowReverted = once("curvecut:pieces-changed",
                (event) => event.detail.source === "hollow-revert");
            CC.bigPrint.exit();
            await hollowReverted;
            const restored = CC.pieces[0];
            assert(restored.scale.x === 1, `cancel left model scale at ${restored.scale.x}`);
            assert(!restored.userData.bigPrintHollow,
                "cancel left bigPrintHollow metadata on the model");
            assert(trisOf(restored) === beforeTris,
                "cancel did not restore the pre-hollow triangle count");
            assert(Math.abs(volumeOf(restored) - beforeVolume) < 1e-6,
                "cancel did not restore the pre-hollow volume");
        }],

        ["save-picker-fallback", async () => {
            await resetState();
            assert(!window.showSaveFilePicker,
                "showSaveFilePicker unexpectedly exists in the headless file:// run");
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-fallback-cube.stl");
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open for fallback export");
            setSmallBigPrintGrid();
            CC.bigPrint._lastExport = null;

            // exercise the picker-FAILURE branch too (not just picker-absent):
            // a rejecting picker must fall through to blob zips, not abort
            window.showSaveFilePicker = () =>
                Promise.reject(new Error("race-injected picker failure"));
            try {
                exportBtn.click();
                await waitFor(() => CC.ops.busyName() === "bigprint", "fallback Big Print export");
                await once("curvecut:op-ended", (event) => event.detail.name === "bigprint");
            } finally {
                window.showSaveFilePicker = undefined;
            }
            const result = CC.bigPrint._lastExport;
            assert(result, "fallback export did not publish _lastExport");
            assert(result.parts >= 1, "fallback export produced no model parts");
            assert(Array.isArray(result.files) && result.files.length >= 1,
                "fallback export produced no blob zip files");
            assert(result.files.every((name) => name.endsWith(".zip")),
                "fallback export did not report blob zip names");
            assert(CC.bigPrint.isActive() && !exportBtn.disabled,
                "completed fallback export did not leave Big Print usable");
        }],

        ["grid-cap-refusal", async () => {
            await resetState();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-grid-cap-cube.stl");
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open for grid-cap test");

            const overCapGrid = setCappedBigPrintGrid(2);
            const overCapCount = BigPrintCore.cellCount(overCapGrid);
            assert(overCapCount > 4096,
                `over-cap fixture has only ${overCapCount} candidate cells`);
            exportBtn.click();
            assert(!CC.ops.busy(), "over-cap export began an operation");
            assert(document.getElementById("toast-live").textContent.includes("Big Print stops at 4,096"),
                "grid-cap refusal toast was not shown");
            assert(!exportBtn.disabled, "grid-cap refusal disabled the export button");

            const warningGrid = setCappedBigPrintGrid(1);
            const warningCount = BigPrintCore.cellCount(warningGrid);
            assert(warningCount > 512 && warningCount <= 4096,
                `warning fixture has ${warningCount} candidate cells`);
            exportBtn.click();
            assert(!CC.ops.busy(), "warning confirmation began an operation on its first click");
            assert(exportBtn.textContent.includes("Really export"),
                "warning confirmation label was not armed");
            await cancelBigPrintExport();
        }],

        ["supersede-mid-warm", async () => {
            await resetState();
            const heavy = new THREE.TorusKnotGeometry(8, 3, 1500, 200).toNonIndexed();
            CC.loadGeometry(heavy, "race-supersede-warm.stl");
            await sleep(500);
            await waitFor(() => !CC.ops.busy(), "load repair to end");
            // Headless Chromium has no idle periods, so the warm's idle callback
            // only fires at its 1 s timeout, after the 180 ms hollow teaser has
            // taken the op and primed the shared cache for it. Run idle callbacks
            // promptly, as an idle visible tab does, so the warm owns its op.
            const realIdle = window.requestIdleCallback;
            const realCancelIdle = window.cancelIdleCallback;
            window.requestIdleCallback = (callback) => setTimeout(() =>
                callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
            window.cancelIdleCallback = (handle) => clearTimeout(handle);
            try {
                CC.bigPrint.enter();
                assert(CC.bigPrint.isActive(), "Big Print mode did not open for warm supersede test");

                const scaleInput = document.getElementById("bp-scale");
                scaleInput.value = 1.1;
                scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
                setSmallBigPrintGrid();
                await waitFor(() => CC.ops.busyName() === "bigprint-warm", "Big Print warm token", 5000);

                const warmEnded = once("curvecut:op-ended",
                    (event) => event.detail.name === "bigprint-warm");
                assert(CC.bigPrint._testWarmPending(),
                    "superseded warm did not have a pending consumer before the event");
                const cancelSerial = CC.bigPrint._testWarmCancelSerial();
                window.dispatchEvent(new CustomEvent("curvecut:pieces-changed"));
                assert(CC.bigPrint._testWarmCancelSerial() === cancelSerial + 1,
                    "pieces-changed did not settle the warm synchronously");
                await warmEnded;
                await waitFor(() => !CC.ops.busy(), "superseded warm cleanup");

                const toastBefore = document.getElementById("toast-live").textContent;
                CC.bigPrint._lastExport = null;
                exportBtn.click();
                await waitFor(() => CC.ops.busyName() === "bigprint", "superseded-warm export token");
                await once("curvecut:op-ended", (event) => event.detail.name === "bigprint");
                const toastAfter = document.getElementById("toast-live").textContent;
                assert(CC.bigPrint._lastExport || toastAfter !== toastBefore,
                    "superseded-warm export ended without a completion or failure toast");
                assert(!CC.ops.busy(), "superseded-warm export token remained live");
            } finally {
                window.requestIdleCallback = realIdle;
                window.cancelIdleCallback = realCancelIdle;
            }
        }],

        ["warm-null-and-export-aborts", async () => {
            await resetState();
            await CutCore.init();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-null-cache-cube.stl");
            await waitFor(() => !CC.ops.busy(), "load repair to end");
            CC.bigPrint.enter();
            assert(CC.bigPrint.isActive(), "Big Print mode did not open for null-cache test");

            const ready = CC.compute.ready;
            let releaseHeldReady;
            let readyReleased = false;
            const heldReady = new Promise((resolve) => { releaseHeldReady = resolve; });
            const releaseReady = () => {
                if (readyReleased) return;
                readyReleased = true;
                releaseHeldReady(false);
            };
            CC.compute.ready = () => heldReady;
            try {
                const scaleInput = document.getElementById("bp-scale");
                scaleInput.value = 1.1;
                scaleInput.dispatchEvent(new Event("input", { bubbles: true }));
                setSmallBigPrintGrid();
                await waitFor(() => CC.bigPrint._testWarmPending(),
                    "worker warm promise without an event");
                const cancelSerial = CC.bigPrint._testWarmCancelSerial();
                releaseReady();
                await waitFor(() => CC.bigPrint._testWarmCancelSerial() > cancelSerial,
                    "null-cache warm cancellation", 5000);
                assert(!CC.bigPrint._testWarmPending(),
                    "null-cache continuation left its warm promise pending");
            } finally {
                releaseReady();
                CC.compute.ready = ready;
            }

            await resetState();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-picker-abort-cube.stl");
            CC.bigPrint.enter();
            setSmallBigPrintGrid();
            CC.bigPrint._lastExport = null;
            const hadPicker = Object.prototype.hasOwnProperty.call(window, "showSaveFilePicker");
            const oldPicker = window.showSaveFilePicker;
            window.showSaveFilePicker = () => {
                const error = new Error("race-injected picker abort");
                error.name = "AbortError";
                return Promise.reject(error);
            };
            try {
                const ended = once("curvecut:op-ended",
                    (event) => event.detail.name === "bigprint");
                exportBtn.click();
                await waitFor(() => CC.ops.busyName() === "bigprint",
                    "picker-abort export token");
                await ended;
                assert(CC.bigPrint._lastExport === null,
                    "picker abort published an export");
                assert(document.getElementById("toast-live").textContent.includes("Stopped"),
                    "picker AbortError did not show the stopped toast");
            } finally {
                if (hadPicker) window.showSaveFilePicker = oldPicker;
                else delete window.showSaveFilePicker;
            }

            await resetState();
            CC.loadGeometry(new THREE.BoxGeometry(20, 20, 20).toNonIndexed(),
                "race-revision-abort-cube.stl");
            CC.bigPrint.enter();
            setSmallBigPrintGrid();
            CC.bigPrint._lastExport = null;
            const ended = once("curvecut:op-ended",
                (event) => event.detail.name === "bigprint");
            exportBtn.click();
            await waitFor(() => CC.ops.busyName() === "bigprint",
                "revision-abort export token");
            window.dispatchEvent(new CustomEvent("curvecut:pieces-changed",
                { detail: { source: "race-export-revision" } }));
            await ended;
            assert(CC.bigPrint._lastExport === null,
                "revision-abort export published an export");
            assert(document.getElementById("toast-live").textContent.includes("Stopped"),
                "revision-abort did not show the stopped toast");
            assert(!CC.ops.busy(), "revision-abort export token remained live");
        }],

        ["model-load-op", async () => {
            await resetState();
            // a binary STL the real exporter wrote, so the file path parses it for real
            const cube = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20));
            const stlBytes = new THREE.STLExporter().parse(cube, { binary: true });

            const loaded = once("curvecut:pieces-changed", (event) => event.detail.source === "load");
            const loadEnded = once("curvecut:op-ended", (event) => event.detail.name === "load");
            const loading = CC.loadModelFile(new File([stlBytes], "race-load-cube.stl"));
            assert(CC.ops.busyName() === "load",
                `loadModelFile ran under op "${CC.ops.busyName()}", not "load"`);
            await Promise.all([loaded, loadEnded, loading]);
            assert(CC.pieces.length === 1, `load left ${CC.pieces.length} pieces instead of 1`);
            assert(!CC.ops.busy(), "load token remained live after the model loaded");

            // refused while another op runs, and refused BEFORE parsing
            const realParse = THREE.STLLoader.prototype.parse;
            let parses = 0;
            THREE.STLLoader.prototype.parse = function () {
                parses++;
                return realParse.apply(this, arguments);
            };
            const toastLive = document.getElementById("toast-live");
            toastLive.textContent = "";
            const held = CC.ops.begin("race-hold");
            try {
                assert(held, "could not hold an op for the refusal test");
                await CC.loadModelFile(new File([stlBytes], "must-not-parse.stl"));
                assert(parses === 0, `loadModelFile parsed ${parses} time(s) while an op was running`);
                assert(CC.ops.busyName() === "race-hold",
                    "refused load disturbed the op that was already running");
                assert(toastLive.textContent.includes("operation is still running"),
                    "load refusal toast was not shown");
            } finally {
                THREE.STLLoader.prototype.parse = realParse;
                if (held) CC.ops.end(held);
            }

            // a file that cannot be parsed must still free the op
            toastLive.textContent = "";
            await CC.loadModelFile(new File([new Uint8Array(10)], "junk.stl"));
            assert(!CC.ops.busy(), `junk file left op "${CC.ops.busyName()}" running — the load token leaked`);
            assert(toastLive.textContent.includes("could not be read"),
                "junk file did not show the could-not-be-read toast");
        }],

        ["progress-pill-under-load", async () => {
            await resetState();
            // Big Print's export pattern: each part blocks the main thread for
            // seconds, then yields one tick and updates the pill. gsap's lag
            // smoothing counts each block as ~33 ms, so a fade crawls ~10% per
            // part (Max saw it go solid only around part 8 of 20).
            const pill = document.getElementById("progress-pill");
            gsap.killTweensOf(pill);
            gsap.set(pill, { autoAlpha: 0 }); // idle: hidden, as before any real export
            const held = CC.ops.begin("race-hold");
            assert(held, "could not hold an op for the pill test");
            try {
                CC.progress.show("Preparing the model…");
                const opacityNow = () => parseFloat(getComputedStyle(pill).opacity);
                assert(opacityNow() >= 0.99,
                    `pill opacity ${opacityNow().toFixed(2)} right after show(), not solid`);
                for (let part = 1; part <= 2; part++) {
                    const until = performance.now() + 1500;
                    while (performance.now() < until) { /* a part's boolean work */ }
                    await new Promise((r) => setTimeout(r));
                    CC.progress.update(`Cutting part ${part}…`, part / 20);
                    assert(opacityNow() >= 0.99,
                        `pill opacity ${opacityNow().toFixed(2)} during part ${part}, not solid`);
                }
            } finally {
                CC.progress.hide();
                CC.ops.end(held);
            }
        }],
    ];

    (async () => {
        let ok = 0;
        const failures = [];
        for (const [name, run] of scenarios) {
            try {
                await run();
                ok++;
            } catch (err) {
                console.error(`RACE ${name}:`, err);
                failures.push(`${name}: ${err.message}`);
                if (CC.ops.busy()) {
                    CC.ops.cancel();
                    try { await waitFor(() => !CC.ops.busy(), `${name} cleanup`); } catch (_) {}
                }
            }
        }
        document.title = `RACE ok=${ok} fail=${failures.length}` +
            (failures.length ? ` failures=${failures.join("; ")}` : "");
    })();
})();
