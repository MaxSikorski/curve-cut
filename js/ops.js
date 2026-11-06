/* Curve Cut — operation coordinator (v2.0.2 hardening, review finding #1)
   One structural async operation at a time. begin() hands out a job token
   pinned to the current model revision; callers must see token.alive() true
   before committing results to CC.pieces. The busy state lets model loads,
   undo/redo, and mode switches refuse to run mid-operation instead of
   corrupting a job in flight. DOM-free on purpose — test pages load it. */

(() => {
    "use strict";

    const CC = window.CurveCut;

    let revision = 0;   // bumps on every structural piece-set change
    let current = null; // the one running operation's token, or null

    // Both events fire only on structural changes (load, cut commit, simplify
    // commit, undo/redo, Start New) — visibility toggles fire neither.
    window.addEventListener("curvecut:model-loaded", () => { revision++; });
    window.addEventListener("curvecut:pieces-changed", () => { revision++; });

    CC.ops = {
        /* Returns a token, or null when another operation is running (the
           caller toasts and bails). alive() goes false if the piece set
           changed under the job or someone requested cancellation. */
        begin(name) {
            if (current) return null;
            const token = {
                name,
                rev: revision,
                cancelled: false,
                alive() { return !this.cancelled && this.rev === revision; },
            };
            current = token;
            return token;
        },

        /* Always call from a finally — a token left dangling bricks the app.
           Announces curvecut:op-ended so UI waiting on an operation hears
           about failures too (success alone already fires pieces-changed). */
        end(token) {
            if (current !== token) return;
            current = null;
            window.dispatchEvent(new CustomEvent("curvecut:op-ended",
                { detail: { name: token.name } }));
        },

        busy: () => !!current,
        busyName: () => (current ? current.name : null),

        /* Ask the running operation to stop; it decides when it's safe. */
        cancel() {
            if (!current) return false;
            current.cancelled = true;
            return true;
        },

        revision: () => revision,
    };
})();
