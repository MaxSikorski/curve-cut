/* Curve Cut — undo/redo history (Max, 2026-07-13)
   Snapshot-based: before every structural change (cut, simplify) the current
   piece set is pushed onto an undo stack; undo swaps it back in instantly.
   Cmd/Ctrl+Z undoes, +Shift redoes. Depth-capped at 10 (memory), and a new
   structural change clears redo — standard everywhere-behavior. */

(() => {
    "use strict";

    const CC = window.CurveCut;
    const { scene } = CC;
    const DEPTH = 10;
    const MAX_RETAINED_TRIS = 3_000_000; // memory cap across all snapshots (v1.2)

    const undoBtn = document.getElementById("undo-btn");
    const redoBtn = document.getElementById("redo-btn");

    const undoStack = []; // each entry: array of THREE.Mesh (a full piece set)
    const redoStack = [];

    const snapshot = () => CC.pieces.slice();

    function isReferenced(mesh) {
        if (CC.pieces.includes(mesh)) return true;
        return undoStack.concat(redoStack).some((state) => state.includes(mesh));
    }

    function isMaterialReferenced(material) {
        if (CC.pieces.some((mesh) => mesh.material === material)) return true;
        return undoStack.concat(redoStack).some(
            (state) => state.some((mesh) => mesh.material === material));
    }

    // dispose only meshes no other snapshot (or the live scene) still uses
    function disposeState(state) {
        for (const mesh of state) {
            if (!isReferenced(mesh)) {
                mesh.geometry.dispose();
                if (!isMaterialReferenced(mesh.material)) mesh.material.dispose();
            }
        }
    }

    function updateButtons() {
        undoBtn.disabled = !undoStack.length;
        redoBtn.disabled = !redoStack.length;
    }

    function meshTris(mesh) {
        const g = mesh.geometry;
        return (g.getIndex() ? g.getIndex().count : g.getAttribute("position").count) / 3;
    }

    function retainedStats() {
        const liveGeometries = new Set(CC.pieces.map((mesh) => mesh.geometry));
        const counted = new Set();
        const buffers = new Set();
        const liveBuffers = new Set();
        let retainedTris = 0;
        let retainedBytes = 0;
        const collectBuffers = (geometry) => {
            for (const attribute of Object.values(geometry.attributes)) {
                if (attribute.array && attribute.array.buffer) {
                    liveBuffers.add(attribute.array.buffer);
                }
            }
            const index = geometry.getIndex();
            if (index && index.array && index.array.buffer) liveBuffers.add(index.array.buffer);
        };
        for (const geometry of liveGeometries) collectBuffers(geometry);
        const addBytes = (array) => {
            const buffer = array && array.buffer;
            if (!buffer || liveBuffers.has(buffer) || buffers.has(buffer)) return;
            buffers.add(buffer);
            retainedBytes += buffer.byteLength;
        };
        const visit = (state) => {
            for (const mesh of state) {
                const geometry = mesh.geometry;
                if (liveGeometries.has(geometry) || counted.has(geometry)) continue;
                counted.add(geometry);
                retainedTris += meshTris(mesh);
                for (const attribute of Object.values(geometry.attributes)) {
                    addBytes(attribute.array);
                }
                const index = geometry.getIndex();
                if (index) addBytes(index.array);
            }
        };
        for (const state of undoStack) visit(state);
        for (const state of redoStack) visit(state);
        return { retainedTris, retainedBytes };
    }

    function trimHistory() {
        while (undoStack.length > DEPTH) disposeState(undoStack.shift());
        while (retainedStats().retainedTris > MAX_RETAINED_TRIS) {
            if (undoStack.length) disposeState(undoStack.shift());
            else if (redoStack.length) disposeState(redoStack.shift());
            else break;
        }
    }

    /* Called by cut.js / simplify.js BEFORE they mutate CC.pieces. */
    function capture() {
        undoStack.push(snapshot());
        while (redoStack.length) disposeState(redoStack.pop());
        trimHistory();
        updateButtons();
    }

    function applyState(state) {
        for (const mesh of CC.pieces) scene.remove(mesh);
        CC.pieces.length = 0;
        for (const mesh of state) {
            scene.add(mesh);
            CC.pieces.push(mesh);
        }
        window.dispatchEvent(new CustomEvent("curvecut:pieces-changed"));
    }

    function undo() {
        if (!undoStack.length) return;
        if (CC.ops.busy()) {
            CC.toast("Hang on — an operation is still running.");
            return;
        }
        redoStack.push(snapshot());
        applyState(undoStack.pop());
        trimHistory();
        updateButtons();
        CC.toast(`Undone — back to ${CC.pieces.length} piece${CC.pieces.length === 1 ? "" : "s"}.`);
    }

    function redo() {
        if (!redoStack.length) return;
        if (CC.ops.busy()) {
            CC.toast("Hang on — an operation is still running.");
            return;
        }
        undoStack.push(snapshot());
        applyState(redoStack.pop());
        trimHistory();
        updateButtons();
        CC.toast(`Redone — ${CC.pieces.length} piece${CC.pieces.length === 1 ? "" : "s"}.`);
    }

    // fresh model or Start New: history dies with the old scene
    function clear() {
        // pop first so shared geometry/material stays alive until its final ref
        while (undoStack.length) disposeState(undoStack.pop());
        while (redoStack.length) disposeState(redoStack.pop());
        updateButtons();
    }

    undoBtn.addEventListener("click", undo);
    redoBtn.addEventListener("click", redo);
    window.addEventListener("curvecut:model-loaded", clear);

    window.addEventListener("keydown", (e) => {
        if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
        if (CC.drawActive) return; // the pen tool owns its own editing state
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
    });

    updateButtons();
    CC.history = {
        capture, undo, redo, clear, isMaterialReferenced,
        memoryReport: () => {
            const stats = retainedStats();
            return {
                retainedBytes: stats.retainedBytes,
                retainedTris: stats.retainedTris,
                capTris: MAX_RETAINED_TRIS,
                withinCap: stats.retainedTris <= MAX_RETAINED_TRIS,
                undoEntries: undoStack.length,
                redoEntries: redoStack.length,
            };
        },
    };
})();
