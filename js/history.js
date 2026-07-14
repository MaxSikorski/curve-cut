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

    // dispose only meshes no other snapshot (or the live scene) still uses
    function disposeState(state) {
        for (const mesh of state) {
            if (!isReferenced(mesh)) mesh.geometry.dispose();
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

    // triangles retained by the undo stack beyond what's live in the scene
    function retainedTris() {
        const counted = new Set();
        let total = 0;
        for (const state of undoStack) {
            for (const mesh of state) {
                if (counted.has(mesh) || CC.pieces.includes(mesh)) continue;
                counted.add(mesh);
                total += meshTris(mesh);
            }
        }
        return total;
    }

    /* Called by cut.js / simplify.js BEFORE they mutate CC.pieces. */
    function capture() {
        undoStack.push(snapshot());
        while (redoStack.length) disposeState(redoStack.pop());
        // depth cap AND memory cap — old laptops matter more than deep history
        while (undoStack.length > DEPTH ||
               (undoStack.length > 1 && retainedTris() > MAX_RETAINED_TRIS)) {
            disposeState(undoStack.shift());
        }
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
        redoStack.push(snapshot());
        applyState(undoStack.pop());
        updateButtons();
        CC.toast(`Undone — back to ${CC.pieces.length} piece${CC.pieces.length === 1 ? "" : "s"}.`);
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        applyState(redoStack.pop());
        updateButtons();
        CC.toast(`Redone — ${CC.pieces.length} piece${CC.pieces.length === 1 ? "" : "s"}.`);
    }

    // fresh model or Start New: history dies with the old scene
    function clear() {
        // live pieces were already disposed by app.js; dispose() is idempotent,
        // so sweeping every stacked mesh is safe even when refs were shared
        for (const state of undoStack.concat(redoStack)) {
            for (const mesh of state) mesh.geometry.dispose();
        }
        undoStack.length = 0;
        redoStack.length = 0;
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
    CC.history = { capture, undo, redo, clear };
})();
