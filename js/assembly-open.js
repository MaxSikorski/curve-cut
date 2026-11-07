/* In-app assembly viewer: open exported files without running their scripts. */
(() => {
    "use strict";

    const CC = window.CurveCut;
    const overlay = document.getElementById("assembly-overlay");
    const mountEl = document.getElementById("assembly-mount");
    const openBtn = document.getElementById("assembly-open-btn");
    const fileInput = document.getElementById("assembly-file-input");
    const viewBtn = document.getElementById("bp-view-assembly");
    const trap = CC.a11y.makeFocusTrap(overlay);
    let open = false, handle = null, offeredBytes = null, loading = false;
    let opener = null, pushed = false, ignoreNextPop = false, offerVersion = 0;

    function show(data, bytes, source) {
        if (open) return;
        gsap.set(overlay, { autoAlpha: 0 });
        try {
            handle = AssemblyViewer.mount(mountEl, { THREE: window.THREE, data, bytes });
        } catch (_) {
            handle = null;
            mountEl.replaceChildren();
            CC.toast(AssemblyOpenCore.messageFor("damaged"));
            return;
        }
        open = true;
        opener = source;
        trap.activate();
        gsap.to(overlay, { autoAlpha: 1, duration: CC.a11y.dur(0.3), ease: "power2.out" });
        try {
            history.pushState({ curvecutAssembly: true }, "");
            pushed = true;
        } catch (_) { pushed = false; }
    }

    function close(fromHistory = false) {
        if (!open) return;
        handle.dispose();
        handle = null;
        mountEl.replaceChildren();
        gsap.killTweensOf(overlay);
        gsap.set(overlay, { autoAlpha: 0 });
        trap.deactivate();
        if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
        opener = null;
        open = false;
        if (pushed && !fromHistory) {
            ignoreNextPop = true;
            history.back();
        }
        pushed = false;
    }

    function offer(bytes) {
        if (!bytes && open) close();
        offerVersion++;
        offeredBytes = bytes;
        viewBtn.style.display = bytes ? "" : "none";
    }

    async function readAndShow(blob, source, label, version) {
        if (loading) return false;
        loading = true;
        CC.progress.show(label);
        let result;
        try {
            result = await AssemblyOpenCore.readAssembly(blob);
        } catch (error) {
            CC.toast(AssemblyOpenCore.messageFor(error.code));
            return false;
        } finally {
            CC.progress.hide();
            loading = false;
        }
        if (version !== undefined && version !== offerVersion) return false;
        show(result.data, result.bytes, source);
        return open;
    }

    function openFile(file) {
        return readAndShow(file, openBtn, "Opening the assembly file…");
    }

    openBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        const file = fileInput.files[0];
        if (file) openFile(file);
        fileInput.value = "";
    });
    viewBtn.addEventListener("click", () => {
        if (offeredBytes) readAndShow(new Blob([offeredBytes], { type: "text/html" }), viewBtn, "Opening the 3D assembly view…", offerVersion);
    });
    document.getElementById("assembly-close").addEventListener("click", () => close());
    window.addEventListener("keydown", (e) => {
        if (!open || e.key === "Tab") return;
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); close(); }
    }, true);
    window.addEventListener("popstate", () => {
        if (ignoreNextPop) { ignoreNextPop = false; return; }
        if (open) close(true);
    });
    for (const type of ["dragenter", "dragover", "dragleave", "drop"]) {
        overlay.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); });
    }

    CC.assembly = {
        offer, openFile, close, isOpen: () => open,
        _state: () => ({ open, mounted: !!handle, offered: !!offeredBytes, loading }),
        _handle: () => handle
    };
})();
