# Curve Cut

Cut 3D printing models along drawn curves instead of flat planes, right in your browser.
Then scale them way past your build plate and print BIG.

**Try it: [maxsikorski.github.io/curve-cut](https://maxsikorski.github.io/curve-cut/)**

Every slicer can split a model with a straight plane. Curve Cut lets you draw the cut
yourself, like an S-curve that follows the natural seam of a model instead of slicing
straight through the detail. Each cut produces watertight, print-ready pieces, and you
can keep cutting those pieces until everything fits your build plate. And when the
model is *supposed* to be bigger than your build plate, Big Print mode slices it into
a labeled grid of parts with alignment connectors and an assembly map.

## Where this came from

I was heavily inspired by DaveRig Design and his project
[Polycarver](https://youtu.be/7G6voqHYV5U), which does beautiful spline cuts as a
Windows desktop app, and by [LuBan3D](https://www.luban3d.com/), which pioneered
splitting huge models into printable, numbered parts. Both are desktop-only. I'm a Mac
user and a browser-based-everything person, so I built my own take that runs anywhere
a browser does — nothing to install, nothing to update. If you want the full desktop
tools, go support their work.

## What it does

- Load an STL, OBJ, or 3MF by drag-and-drop or file picker
- Meshes with small gaps get repaired on load; honest errors when they can't be
- Draw a cut with a pen tool: clicks land as smooth curve points (double-click for a
  sharp corner), drag the line itself to move it, adjustable handles throughout
- Or pick **Planar** (tilt-and-rotate cutting plane) and **Dovetail** (slide-lock joint
  with printable tolerances) modes, Orca-style
- Preview every cut before committing; a Gap setting leaves real clearance so printed
  pieces actually fit together
- Add plug connectors to a cut face — pegs on one side, matching sockets on the other
- **Big Print:** pick your printer (or a custom bed size), scale by multiplier or
  target size, and export a zip of grid-cut parts with engraved IDs (A1, B2-L3…),
  auto-placed connectors on every seam, a manifest, and a printable assembly map —
  plus an exploded 3D preview
- Undo and redo with ⌘Z / ⇧⌘Z, simplify heavy meshes with one click
- Export pieces as binary STL or 3MF (3MF files are a fraction of the size)
- A short guided tour on your first visit — relaunch it any time from the ⓘ button

## Notes worth knowing

Everything runs on your machine. Your models never leave the browser, because there is
no server to send them to. That also means the whole app works offline: download this
repo and double-click `index.html` and you get the exact same tool, geometry engine
included.

Cuts are computed by [Manifold](https://github.com/elalish/manifold), a WebAssembly
geometry engine built so that every boolean result is watertight. Rendering is
[Three.js](https://threejs.org/), animation is [GSAP](https://gsap.com/), zip packing
is [fflate](https://github.com/101arrowz/fflate), engraved labels use the public-domain
Hershey fonts, and the rest is plain HTML, CSS, and JavaScript with no build step.

## License

[AGPL-3.0](LICENSE). Free to use, study, share, and modify — and if you build
something on top of it (including a hosted service), your version stays open too.
Bring it to your print club. Bundled libraries keep their own licenses — see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
