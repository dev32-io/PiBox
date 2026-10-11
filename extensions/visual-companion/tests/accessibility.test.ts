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
	assert.equal((html.match(/role="tab"/g) ?? []).length, 4);
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

test("Architecture delegates keyboard selection and focus-managed details to native LikeC4 with shadow-root accessibility styles", async () => {
	const [app, css, upstream] = await Promise.all([
		readFile(resolve(architectureAssets, "../scripts/viewer.jsx"), "utf8"),
		readFile(resolve(architectureAssets, "../scripts/shadow.css"), "utf8"),
		readFile(resolve("node_modules/likec4/react/index.mjs"), "utf8"),
	]);
	assert.match(app, /role="group" aria-label="Graph controls"/);
	assert.match(app, /<button onClick=\{refresh\}>Refresh</);
	assert.match(app, /nodesFocusable: true, edgesFocusable: true/);
	assert.match(app, /role="status" aria-live="polite" aria-atomic="true"/);
	assert.match(app, /onSelectionChange:[\s\S]*Selected/);
	assert.match(app, /enableElementDetails enableRelationshipDetails/);
	assert.match(app, /request !== generation.current/);
	assert.match(app, /showing the last valid document/);
	assert.match(app, /<style>\{shadowCss\}<\/style>/, "accessibility CSS must enter the shadow root, not only style host");
	assert.match(css, /:focus-visible/);
	assert.match(css, /prefers-reduced-motion: reduce/);
	assert.match(css, /forced-colors: active/);
	for (const color of ["Canvas", "CanvasText", "Highlight"]) assert.ok(css.includes(color));
	// Version-bound delegate contracts; actual keyboard/modal/narrow behavior is
	// also part of browser E2E, not inferred from these static checks.
	assert.match(upstream, /function NodeWrapper/);
	assert.match(upstream, /function EdgeWrapper/);
	assert.match(upstream, /key === "Escape"/);
	const details = upstream.slice(upstream.indexOf("function ElementDetailsCard("), upstream.indexOf("function ElementDetails("));
	assert.match(details, /showModal\(\)/, "native modal owns focus containment, Escape and focus return");
	assert.match(details, /zy\.dialog/);
	assert.match(details, /onClose: pe/);
	assert.match(details, /Math\.min\(700, T - 48\)/, "details shrink to narrow viewport");
	assert.match(details, /Math\.min\(650, E - 48\)/, "details stay within viewport height");
});
