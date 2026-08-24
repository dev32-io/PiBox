import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const shellAssets = resolve("extensions/visual-companion/assets");
const storyAssets = resolve("extensions/visual-companion/story-board/assets");
const architectureAssets = resolve("skills/architecture-visualizer/assets");

test("shared shell implements keyboard tabs, visible focus, and assertive error boundaries", async () => {
	const [html, app, tokens] = await Promise.all([
		readFile(resolve(shellAssets, "index.html"), "utf8"),
		readFile(resolve(shellAssets, "app.js"), "utf8"),
		readFile(resolve(shellAssets, "design-tokens.css"), "utf8"),
	]);
	assert.match(html, /role="tablist"/);
	assert.equal((html.match(/role="tab"/g) ?? []).length, 3);
	for (const key of ["ArrowRight", "ArrowLeft", "Home", "End"]) assert.match(app, new RegExp(key));
	assert.match(app, /state === "error" \? "alert" : "status"/);
	assert.match(tokens, /:focus-visible/);
	assert.match(tokens, /prefers-reduced-motion:\s*reduce/);
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
	assert.match(app, /focusWasInDrawer/, "async detail rendering must retain focus in the modal");
	assert.match(app, /querySelector\(focusTarget\)\?\.focus/, "closing returns focus to the invoking card");
	assert.match(app, /badge\(task\.status, "status"\)/);
	assert.match(app, /Evidence missing|Unsupported evidence type/);
	assert.match(css, /\.board[^}]+overflow-x:\s*auto/s);
	assert.match(css, /grid-template-columns:\s*repeat\(3,\s*minmax\(82vw,\s*1fr\)\)/);
	assert.match(css, /\.detail-sheet \{ inset: 0; width: 100%; height: 100%/);
	assert.match(css, /var\(--color-scrim,\s*transparent\)/);
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
	assert.match(app, /\["ArrowLeft", "ArrowRight", "Home", "End", "Enter"\]/);
	assert.match(app, /details\.addEventListener\("keydown"/);
	assert.match(app, /event\.key === "Escape"/);
	assert.match(app, /cy\.elements\(":selected"\)\.unselect/);
	assert.match(app, /preserveViewport/);
	assert.match(app, /Showing the last valid document/);
	assert.match(app, /generation !== loadGeneration/);
	assert.match(css, /#canvas:focus-visible/);
	assert.match(css, /aside\[data-open="true"\]/);
});
