import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const shellAssets = resolve("extensions/visual-companion/assets");
const storyAssets = resolve("extensions/visual-companion/story-board/assets");
const architectureAssets = resolve("skills/architecture-visualizer/assets");

test("shared shell implements keyboard tabs, visible focus, and assertive error boundaries", async () => {
	const [html, app, tokens, styles] = await Promise.all([
		readFile(resolve(shellAssets, "index.html"), "utf8"),
		readFile(resolve(shellAssets, "app.js"), "utf8"),
		readFile(resolve(shellAssets, "design-tokens.css"), "utf8"),
		readFile(resolve(shellAssets, "styles.css"), "utf8"),
	]);
	assert.match(html, /role="tablist"/);
	assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
	for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.match(app, new RegExp(key));
	assert.match(app, /state === "error" \? "alert" : "status"/);
	assert.match(tokens, /:focus-visible/);
	assert.match(tokens, /prefers-reduced-motion:\s*reduce/);
	const forcedColors = styles.slice(styles.indexOf("@media (forced-colors: active)"));
	assert.match(forcedColors, /\.shell-tab \{ border-color: transparent; \}/);
	assert.match(forcedColors, /\.shell-tab\[aria-selected="true"\] \{[^}]*border-color: Highlight;[^}]*background: Highlight;[^}]*color: HighlightText;/);
	assert.match(forcedColors, /\.shell-tab:focus-visible \{[^}]*outline: 2px solid Highlight;/);
});

test("Story Board exposes non-color status text and modal focus, return, and narrow-sheet contracts", async () => {
	const [app, css] = await Promise.all([
		readFile(resolve(storyAssets, "app.js"), "utf8"),
		readFile(resolve(storyAssets, "styles.css"), "utf8"),
	]);
	assert.match(app, /role=\\?"dialog/);
	assert.match(app, /aria-modal=\\?"true/);
	assert.match(app, /aria-label=\\?"Close detail/);
	assert.match(app, /event\.key === "Escape"/);
	assert.match(app, /event\.key !== "Tab"/);
	assert.match(app, /captureInteractionState/); assert.match(app, /restoreInteractionState/, "async rendering must retain exact focus and drawer scroll");
	assert.match(app, /\.drawer \[data-action="close-detail"\]/, "modal rerenders fall back to a control inside the drawer");
	assert.match(app, /focusTarget \? root\.querySelector\(focusTarget\)/, "closing returns focus to the invoking card or section fallback");
	assert.match(app, /badge\(task\.status, "status"\)/);
	assert.match(app, /Evidence missing|Unsupported evidence type/);
	assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.board \{ grid-template-columns: 1fr; \}/, "task columns must stack without essential horizontal scrolling");
	assert.doesNotMatch(css, /overflow-x:\s*auto/);
	assert.match(css, /\.detail-layer \{ position: fixed;[^}]*place-items: center/);
	assert.match(css, /\.detail-sheet \{ width: 100%; max-height: calc\(100vh - 2 \* var\(--space-3\)\)/);
	assert.match(css, /background: var\(--color-scrim\)/);
	assert.match(css, /@media \(prefers-contrast: more\)/);
	assert.match(css, /@media \(forced-colors: active\)/);
	assert.match(css, /\.stage-header:focus-visible[^}]*box-shadow:\s*inset var\(--focus-ring\)/s);
	assert.match(css, /\.workflow-task > button:first-child:focus-visible[^}]*box-shadow:\s*inset var\(--focus-ring\)/s);
	assert.match(css, /\.workflow-gate > button:focus-visible[^}]*box-shadow:\s*inset var\(--focus-ring\)/s);
	const forcedColors = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(forcedColors, /\.local-nav a \{ border-color: transparent; \}/);
	assert.match(forcedColors, /\.local-nav a\[aria-current="page"\] \{[^}]*border-color: Highlight;[^}]*background: Highlight;[^}]*color: HighlightText;/);
	assert.match(forcedColors, /\.local-nav a:focus-visible \{[^}]*outline: 2px solid Highlight;/);
	assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, "Story Board must use shared palette tokens");
});

test("Architecture controls and graph selection are keyboard operable with focus-managed narrow details", async () => {
	const [html, app, css] = await Promise.all([
		readFile(resolve(architectureAssets, "index.html"), "utf8"),
		readFile(resolve(architectureAssets, "app.js"), "utf8"),
		readFile(resolve(architectureAssets, "styles.css"), "utf8"),
	]);
	assert.match(html, /role="group" aria-label="Graph controls"/);
	assert.match(html, /id="refresh"[^>]*>Refresh</);
	assert.match(html, /id="canvas"[^>]+tabindex="0"[^>]+aria-label="Interactive architecture graph"/);
	assert.match(html, /id="selection-status"[^>]+class="sr-only"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
	assert.match(app, /\["ArrowLeft", "ArrowRight", "Home", "End", "Enter"\]/);
	assert.match(app, /cy\.on\("select", "node, edge", \(event\) => announceSelection\(event\.target\)\)/);
	assert.match(app, /Selected \$\{label\}\. \$\{kind\}\.\$\{position\}/);
	assert.match(app, /Item \$\{index \+ 1\} of \$\{elements\.length\} in keyboard navigation order/);
	assert.match(app, /details\.addEventListener\("keydown"/);
	assert.match(app, /event\.key === "Escape"/);
	assert.match(app, /cy\.elements\(":selected"\)\.unselect/);
	assert.match(app, /preserveViewport/);
	assert.match(app, /Showing the last valid document/);
	assert.match(app, /generation !== loadGeneration/);
	assert.match(css, /#canvas:focus-visible/);
	assert.match(css, /input\[type="checkbox"\] \{ accent-color: var\(--color-accent, Highlight\); \}/);
	assert.match(css, /\.legend \.node-dot \{ background: var\(--color-accent, Highlight\); \}/);
	const forcedColors = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(forcedColors, /\.canvas-wrap canvas \{ forced-color-adjust: none; \}/);
	assert.match(forcedColors, /#canvas:focus-visible \{ outline: 2px solid Highlight;/);
	assert.doesNotMatch(css, /#canvas\s*\{[^}]*forced-color-adjust:\s*none/s, "the focusable graph container remains under system forced-color control");
	assert.match(app, /const forcedColorsQuery = matchMedia\("\(forced-colors: active\)"\)/);
	assert.match(app, /if \(forcedColorsQuery\.matches\)/);
	assert.match(app, /forcedColorsQuery\.addEventListener\("change"[\s\S]*renderGraph\(\{ preserveViewport: true \}\)/);
	for (const color of ["Canvas", "CanvasText", "Highlight"]) assert.match(app, new RegExp(`systemColor\\("${color}"\\)`));
	assert.match(css, /aside\[data-open="true"\]/);
});
