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
		"--color-canvas": "#0c0e12",
		"--color-surface": "#12151b",
		"--color-surface-raised": "#181c24",
		"--color-surface-strong": "#202631",
		"--color-surface-hover": "#262d39",
		"--color-border-subtle": "#252b35",
		"--color-border": "#313946",
		"--color-border-strong": "#465163",
		"--color-text": "#f2f4f7",
		"--color-text-secondary": "#b8c0cc",
		"--color-text-muted": "#7f8998",
		"--color-text-disabled": "#596270",
		"--color-text-inverse": "#0c0e12",
		"--color-accent": "#7697e8",
		"--color-accent-hover": "#89a7ee",
		"--color-success": "#6fbd8c",
		"--color-warning": "#d9a85f",
		"--color-danger": "#d87878",
		"--color-info": "#6eaed4",
		"--color-scrim": "rgb(0 0 0 / 42%)",
		"--header-height": "68px",
		"--content-max-width": "1180px",
		"--lane-width": "288px",
		"--drawer-width": "464px",
	};
	for (const [name, value] of Object.entries(expected)) assert.equal(declaration(css, name), value, name);
	for (const contract of ["--font-sans", "--font-mono", "--space-1", "--space-10", "--radius-sm", "--radius-pill", "--shadow-overlay", "--motion-fast", "--motion-normal", "--focus-ring"]) {
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
