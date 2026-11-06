# Third-party notices

Curve Cut itself is licensed under the GNU AGPL-3.0-only (see `LICENSE`). It bundles
the following third-party components under `vendor/`, each under its own license.
The root license does not apply to them; each component's own terms do. Full
license texts sit beside each component.

| Component | Version | License | Text | Source |
|---|---|---|---|---|
| Three.js (+ OrbitControls, STLLoader, STLExporter, OBJLoader, 3MFLoader examples) | r147 | MIT | `vendor/three/LICENSE` | https://github.com/mrdoob/three.js |
| Manifold (manifold-3d, WASM embedded as base64) | 3.5.1 | Apache-2.0 | `vendor/manifold/LICENSE` | https://github.com/elalish/manifold |
| fflate | 0.8.2 | MIT | `vendor/fflate/LICENSE` | https://github.com/101arrowz/fflate |
| GSAP | 3.12.5 | GSAP Standard License (free, incl. commercial use) | `vendor/gsap/LICENSE` | https://gsap.com |
| Inter font (latin 300–700 woff2, via Fontsource) | 5.0.18 | SIL Open Font License 1.1 | `vendor/fonts/LICENSE` | https://github.com/rsms/inter |
| Hershey `futural` stroke font | 1967 (JHF) | Public domain (attribution note) | `vendor/hershey/LICENSE` | https://github.com/kamalmostafa/hershey-fonts |
| Voron Design Cube (demo model) | v8 | GPL-3.0 | `assets/demo/LICENSE` | https://github.com/VoronDesign |

Acknowledgement (Hershey Fonts distribution requirement): the Hershey Fonts were
originally created by Dr. A. V. Hershey while working at the U.S. National Bureau
of Standards; the JHF data format was originally created by James Hurt, Cognition, Inc.

Vendored copies are produced reproducibly by `tools/vendor_libs.py`,
`tools/vendor_manifold.py`, and `tools/vendor_hershey.py`, which record the exact
versions and source URLs. (SHA-256 pinning in those scripts is tracked as known
debt in `docs/ROADMAP.md`.)

Note: GSAP is not under an OSI license; it is bundled as a separate, independent
work (mere aggregation), not as an AGPL-derived work. Curve Cut is free to use,
so the "no charge" terms are satisfied either way.
