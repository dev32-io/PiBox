# Scratch vendor notices

`npm run build:scratch-vendor` bundles only six Web Awesome components and required modules into `../assets/webawesome.min.js`. Browser loads no package from `node_modules` or CDN. Sources in `scripts/scratch-webawesome-entry.js`; pinned build inputs in root `package-lock.json`.

Bundled code (versions from lockfile):
- `@awesome.me/webawesome` 3.14.0 — MIT: `webawesome-MIT.txt` (bundle retains Fonticons copyright comment).
- `lit` 3.3.3, `lit-html` 3.3.3, `lit-element` 4.2.2, `@lit/reactive-element` 2.1.2 — BSD-3-Clause: `lit-BSD-3-Clause.txt` (same license text, except trailing newline in `lit-html`).
- `@lit/context` 1.1.6 — BSD-3-Clause: `lit-context-BSD-3-Clause.txt`.
- `@shoelace-style/localize` 3.2.3 — MIT: `shoelace-localize-MIT.txt`.
- `nanoid` 5.1.16 — MIT: `nanoid-MIT.txt`.

`../assets/icons/*.svg`: selected unmodified `lucide-static` 0.577.0 SVGs (source version/license comments retained per file); ISC plus Feather-derived MIT portions: `lucide-ISC.txt`. Neither full icon package nor icon fonts ship.

Shared Markdown renderer and existing exact marked/DOMPurify routes stay outside this bundle; no copies of those vendors here.
