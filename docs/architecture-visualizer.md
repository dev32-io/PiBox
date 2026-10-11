# Architecture visualizer

PiBox's Architecture tab uses [LikeC4](https://likec4.dev/) to explore responsibilities, boundaries, and interactions through a shared model and purpose-specific views. It runs inside the existing Visual Companion with PiBox's charcoal/copper theme.

## Start an explanation

Ask the agent to visualize the system or invoke:

```text
/skill:architecture-visualizer Explain this service's architecture, then walk through a request.
```

The agent inspects relevant source, authors one self-contained native `.c4` file under `.pibox/visualization/architecture/`, and opens it through `visual_companion`. This directory is ignored repository-local output, not workflow authority. Existing files persist beyond the backend's session lifetime.

Use the [native example](../skills/architecture-visualizer/templates/example.c4) as a syntax starter. It contains an illustrative overview, a subsystem drilldown, and an ordered request scenario—not claims about PiBox's implementation. The [authoring reference](../skills/architecture-visualizer/references/visual-document.md) covers evidence, containment, view selection, and rendered inspection.

## Explore the diagram

- **Views and Back:** choose a named view from the selector. Select a node and use its revealed navigation control to open a scoped drilldown; Back returns to the previous view.
- **Search:** use the diagram toolbar to find elements and views.
- **Focus:** double-click an element to focus its relationship neighborhood and dim unrelated content.
- **Relationships:** select an element and use its relationship control to inspect incoming and outgoing connections.
- **Details:** inspect responsibility descriptions and source metadata without filling the canvas with prose.
- **Walkthroughs:** in a dynamic view, use Start, Next, and Previous to follow authored interactions. These are explanations, not live tracing or simulations.
- **Pan, zoom, and fit:** use the native canvas controls. Keyboard users can Tab to graph items and press Enter to select; details dialogs support Escape and focus return.
- **Save screenshot:** download the current diagram viewport as PNG, with the current pan/zoom and visible state. It does not capture the desktop, other tabs, off-screen content, or all views. No screen-sharing permission or separate capture service is needed.

An overview should remain understandable without hunting across the canvas. Use drilldowns and focused scenarios for detail rather than expanding everything into one graph.

## Live edits and verification

Update the same `.c4` file during discussion. The browser refreshes its model and retains the selected view when that view still exists. The visible revision marker identifies the source hash and selected view.

If parsing fails, diagnostics appear and the backend retains the last valid diagram, including across browser reloads. That diagram is **not** proof that the latest edit succeeded. Correct the source and wait for the new revision before verifying it.

The architecture skill requires actual rendered-image inspection before claiming visual verification. A successful parse or an open URL alone does not establish readability. Screenshots should match the intended source revision, selected view, and viewport.

## Installation and lifecycle

Requires **Node.js >=22.22.3**. LikeC4 is installed once as a PiBox package dependency; prebuilt browser code and local fonts ship with PiBox. There is no per-session install/build, additional MCP server, or second architecture server.

The companion backend starts on demand, belongs to the current session, and closes on stop or session shutdown. LikeC4's compiler is imported lazily when architecture is requested. After updating PiBox in an already-running session, use `/reload` before opening a new native document.

Only a single `.c4` source file is supported. The integration does not execute workspace configuration, invoke the LikeC4 CLI, or run a Vite development server. Remote icons are not rendered; local assets and fonts avoid network-dependent presentation.

### Migrating legacy JSON

The old custom architecture JSON format is no longer rendered. PiBox leaves those files untouched and provides an actionable diagnostic. Reauthor their relevant elements, relationships, and views in a new `.c4` file, then open that file. Renaming `.json` to `.c4` is not conversion; automatic conversion and a parallel legacy renderer are intentionally absent.

## Development

Browser source lives in `skills/architecture-visualizer/scripts/viewer.jsx` and `scripts/shadow.css`; the native loader is `scripts/server.mjs` in the same skill directory. Shared application colors come from `extensions/visual-companion/assets/design-tokens.css`.

After changing browser source or pinned build inputs:

```bash
npm run build:architecture
npm run check
npm test
git diff --check
```

Commit regenerated `skills/architecture-visualizer/assets/` files, including font and license assets. Consumers use these prebuilt files without a build step. Browser verification should cover overview/drilldown, native exploration controls, walkthrough steps, downloaded screenshot fidelity, live-edit/error recovery, and normal keyboard/narrow-screen accessibility. The existing assisted launcher exercises the real backend and viewer factories in bounded tests without starting Pi.

### Dependencies and notices

LikeC4 1.59.4 and the screenshot helper are MIT-licensed; bundled dependencies and fonts retain their own terms. Shipped [third-party notices](../skills/architecture-visualizer/assets/notices/THIRD-PARTY.txt) include copyright/license text and Graphviz/WASM source references. These licenses do not replace PiBox's MIT license.

The pinned LikeC4 installation includes an unpatched `braces` advisory ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)) through its CLI dependency chain. The approved integration uses fixed `LikeC4.fromSource` options with WASM layout and a prebuilt React viewer; import-blocking probes and bundle inspection found that chain outside the exercised runtime/browser paths. This is a version- and integration-specific non-reachability assessment, not a clean-audit claim or general security guarantee. Reassess the advisory and execution boundary when upgrading dependencies or adding runtime capabilities; do not silently introduce CLI/workspace configuration execution.
