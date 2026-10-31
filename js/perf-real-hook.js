/* Curve Cut — real-model performance harness (v2.1p perf lane)
   Runs ONLY when the page is opened as index.html#perfreal (real-time CDP via
   tools/check_perf_real.py). Loads the local 512k statue through the file
   input, declines simplification, times auto-repair, measures hollow's two
   UI beats, applies a curve cut, and records the post-GC JS heap slice.

   Final document.title format, parsed strictly by the launcher:
   "PERFREAL load=<ms> repair=<ms> ltout=<ms> ltsan=<ms> hsave=<ms>"
   " hsettle=<ms> cut=<ms> heap=<MB>"
   `ltout` and `ltsan` are the worst long tasks outside and inside a recorded
   CC.ops interval; `heap` is performance.memory.usedJSHeapSize in MB.
   Inert for normal users. */

(() => {
    "use strict";

    // dev-only: never let the public site URL + #perfreal run a heavy benchmark
    const isDev = location.protocol === "file:" ||
        location.hostname === "localhost" || location.hostname === "127.0.0.1";
    if (window.location.hash !== "#perfreal" || !isDev) return;
    const CC = window.CurveCut;

    const FIXTURE = "test-assets/Jesus-modified-hollow.stl";
    const WAIT_MS = 300000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const once = (event) => new Promise((resolve) =>
        window.addEventListener(event, resolve, { once: true }));

    const opIntervals = [];
    const intervalByToken = new WeakMap();
    const originalBegin = CC.ops.begin;
    const originalEnd = CC.ops.end;
    CC.ops.begin = function (...args) {
        const token = originalBegin.apply(this, args);
        if (token) {
            const interval = { start: performance.now(), end: Infinity };
            opIntervals.push(interval);
            intervalByToken.set(token, interval);
        }
        return token;
    };
    CC.ops.end = function (token) {
        const interval = token && intervalByToken.get(token);
        if (interval && interval.end === Infinity) interval.end = performance.now();
        return originalEnd.apply(this, arguments);
    };

    let longOutside = 0;
    let longSanctioned = 0;
    const watchStarted = performance.now();
    let longTaskObserver = null;
    if (window.PerformanceObserver) {
        try {
            longTaskObserver = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    if (entry.startTime + entry.duration <= watchStarted) continue;
                    const sanctioned = opIntervals.some((interval) =>
                        entry.startTime < interval.end &&
                        entry.startTime + entry.duration > interval.start);
                    if (sanctioned) longSanctioned = Math.max(longSanctioned, entry.duration);
                    else longOutside = Math.max(longOutside, entry.duration);
                }
            });
            longTaskObserver.observe({ type: "longtask", buffered: true });
        } catch (_) {
            longOutside = -1;
            longSanctioned = -1;
            longTaskObserver = null;
        }
    } else {
        longOutside = -1;
        longSanctioned = -1;
    }

    const waitFor = async (condition, label, timeout = WAIT_MS) => {
        const deadline = performance.now() + timeout;
        while (performance.now() < deadline) {
            if (condition()) return;
            await sleep(100);
        }
        throw new Error(`timed out waiting for ${label}`);
    };

    const waitForEvent = (event, label, timeout = WAIT_MS) =>
        Promise.race([
            once(event),
            sleep(timeout).then(() => {
                throw new Error(`timed out waiting for ${label}`);
            }),
        ]);

    const fileInputLoad = async () => {
        const loaded = waitForEvent("curvecut:pieces-changed", "model load");
        const response = await fetch(new URL(FIXTURE, location.href).href);
        const buffer = await response.arrayBuffer();
        const file = new File([buffer], "Jesus-modified-hollow.stl");
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.getElementById("file-input");
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await loaded;
        await waitFor(() => CC.pieces.length === 1, "parsed model");
    };

    const capNoteVisible = () => {
        const detail = document.getElementById("stats-detail");
        return detail && /\bhole[s]? capped\b/i.test(detail.textContent);
    };

    const savingsVisible = () => {
        const status = document.getElementById("bp-hollow-status");
        return status && /(?:Hollowing could save|Not worth hollowing)/i.test(status.textContent);
    };

    const hollowSettled = () => {
        const status = document.getElementById("bp-hollow-status");
        if (!status) return false;
        const text = status.textContent.trim();
        return text.length > 0 && !/Checking walls…/.test(text) &&
            /(?:coarse preview|warnings:)/i.test(text);
    };

    let stage = "start";

    (async () => {
        try {
            stage = "boot";
            await waitFor(() => !!(CC && CC.pieces && CutCore), "app boot", 60000);

            stage = "load";
            const loadStart = performance.now();
            await fileInputLoad();
            const loadMs = performance.now() - loadStart;

            stage = "repair";
            await waitFor(() => {
                const text = document.getElementById("simplify-text");
                return !!(text && text.textContent);
            }, "simplify offer", 60000);
            await sleep(1000);
            const repairStart = performance.now();
            document.getElementById("simplify-keep").click();
            await waitFor(capNoteVisible, "holes capped chip");
            const repairMs = performance.now() - repairStart;
            await waitFor(() => !CC.ops.busy(), "repair operation end", 60000);

            stage = "hollow";
            document.getElementById("bigprint-btn").click();
            await waitFor(() => CC.bigPrintActive === true, "Big Print entry", 60000);
            const hollowOn = document.getElementById("bp-hollow-on");
            hollowOn.click();
            const hollowWall = document.getElementById("bp-hollow-wall");
            hollowWall.value = "1.6";
            const hollowStart = performance.now();
            hollowWall.dispatchEvent(new Event("input", { bubbles: true }));
            await waitFor(savingsVisible, "hollow savings text");
            const hollowSavingsMs = performance.now() - hollowStart;
            await waitFor(hollowSettled, "hollow warnings or settled status");
            const hollowSettleMs = performance.now() - hollowStart;
            document.getElementById("bp-cancel").click();
            await waitFor(() => !CC.bigPrintActive, "Big Print exit", 60000);

            stage = "cut";
            const c = CC.getModelCenter();
            const V = (x, y, z) => new THREE.Vector3(x, y, z);
            CC.spline = {
                points: [
                    { a: V(c.x, c.y + 500, c.z), hIn: null, hOut: null },
                    { a: V(c.x, c.y - 500, c.z), hIn: null, hOut: null },
                ],
                normal: V(0, 0, 1),
                planePoint: c,
            };
            window.dispatchEvent(new CustomEvent("curvecut:spline-ready"));
            const cutDone = waitForEvent("curvecut:pieces-changed", "curve cut");
            const cutStart = performance.now();
            document.getElementById("cut-apply").click();
            await cutDone;
            const cutMs = performance.now() - cutStart;
            if (CC.pieces.length !== 2) {
                throw new Error(`expected 2 pieces after curve cut, got ${CC.pieces.length}`);
            }
            await waitFor(() => !CC.ops.busy(), "cut operation end", 60000);

            stage = "measure";
            await sleep(300);
            if (window.gc) {
                window.gc();
                await sleep(500);
            }
            const heapMB = performance.memory &&
                Number.isFinite(performance.memory.usedJSHeapSize)
                ? performance.memory.usedJSHeapSize / 1048576 : -1;
            await sleep(250);
            if (longTaskObserver) longTaskObserver.disconnect();
            document.title = "PERFREAL load=" + Math.round(loadMs) +
                " repair=" + Math.round(repairMs) +
                " ltout=" + Math.round(longOutside) +
                " ltsan=" + Math.round(longSanctioned) +
                " hsave=" + Math.round(hollowSavingsMs) +
                " hsettle=" + Math.round(hollowSettleMs) +
                " cut=" + Math.round(cutMs) +
                " heap=" + heapMB.toFixed(1);
        } catch (err) {
            if (longTaskObserver) longTaskObserver.disconnect();
            document.title = `PERFREAL FAIL at ${stage}: ${err.message}`;
        }
    })();
})();
