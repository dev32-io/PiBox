import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const commonAssets = resolve("extensions/visual-companion/assets");
const architectureAssets = resolve("skills/architecture-visualizer/assets");

function declaration(css: string, name: string): string | undefined {
	return css.match(new RegExp(`${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
}

test("approved semantic tokens provide color, type, spacing, geometry, focus, and motion", async () => {
	const css = await readFile(resolve(commonAssets, "design-tokens.css"), "utf8");
	const expected = {
		"--color-canvas": "#090d14",
		"--color-surface": "#111821",
		"--color-surface-raised": "#17212c",
		"--color-surface-strong": "#1e2a37",
		"--color-surface-hover": "#243343",
		"--color-border-subtle": "#22303e",
		"--color-border": "#304255",
		"--color-border-strong": "#496078",
		"--color-text": "#f1f6fb",
		"--color-text-secondary": "#b5c2cf",
		"--color-text-muted": "#7f91a3",
		"--color-text-disabled": "#596979",
		"--color-text-inverse": "#071019",
		"--color-accent": "#54b9f5",
		"--color-accent-hover": "#78c9f8",
		"--color-success": "#63c58b",
		"--color-warning": "#e2ad55",
		"--color-danger": "#ef7377",
		"--color-info": "#65bde5",
		"--color-scrim": "rgb(2 7 13 / 58%)",
		"--header-height": "68px",
		"--content-max-width": "1180px",
		"--lane-width": "288px",
		"--drawer-width": "464px",
	};
	for (const [name, value] of Object.entries(expected)) assert.equal(declaration(css, name), value, name);
	for (const contract of ["--color-canvas-soft", "--color-accent-strong", "--color-selected-well", "--color-top-edge", "--font-sans", "--font-mono", "--space-1", "--space-10", "--radius-sm", "--radius-pill", "--shadow-panel", "--shadow-directional", "--shadow-overlay", "--motion-fast", "--motion-normal", "--focus-ring"]) {
		assert.ok(declaration(css, contract), contract);
	}
	assert.match(css, /:focus-visible/);
	assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("shell and Architecture consume common tokens with readable system fallbacks", async () => {
	const [shellHtml, shellCss, architectureHtml, architectureCss, architectureApp] = await Promise.all([
		readFile(resolve(commonAssets, "index.html"), "utf8"),
		readFile(resolve(commonAssets, "styles.css"), "utf8"),
		readFile(resolve(architectureAssets, "index.html"), "utf8"),
		readFile(resolve(architectureAssets, "styles.css"), "utf8"),
		readFile(resolve(architectureAssets, "app.js"), "utf8"),
	]);
	assert.match(shellHtml, /background:\s*Canvas;\s*color:\s*CanvasText/, "inline shell fallback must survive a failed asset request");
	assert.match(shellHtml, /\/assets\/design-tokens\.css/);
	assert.match(architectureHtml, /\/assets\/design-tokens\.css/);
	assert.match(shellCss, /var\(--color-canvas,\s*Canvas\)/);
	assert.match(architectureCss, /var\(--color-text,\s*CanvasText\)/);
	assert.match(architectureApp, /getComputedStyle\(document\.documentElement\)/);
	assert.match(architectureApp, /theme\.accent/);
	assert.doesNotMatch(`${architectureCss}\n${architectureApp}`, /#[\da-f]{3,8}\b|rgba?\(/i, "viewer assets must not establish a second shared palette");
});

test("Architecture keeps narrow details as an operable sheet and honors common motion", async () => {
	const [html, css] = await Promise.all([
		readFile(resolve(architectureAssets, "index.html"), "utf8"),
		readFile(resolve(architectureAssets, "styles.css"), "utf8"),
	]);
	assert.match(html, /id="details"[^>]+aria-label="Selected element details"[^>]+tabindex="-1"/);
	assert.match(html, /id="close-details"[^>]+aria-label="Close element details"/);
	const narrow = css.slice(css.indexOf("@media (max-width: 820px)"), css.indexOf("@media (max-width: 560px)"));
	assert.match(narrow, /aside\s*\{[\s\S]*position:\s*absolute/);
	assert.match(narrow, /aside\[data-open="true"\]/);
	assert.doesNotMatch(narrow, /aside\s*\{[^}]*display:\s*none/s);
	assert.match(narrow, /var\(--motion-normal,\s*0s\)/);
});
