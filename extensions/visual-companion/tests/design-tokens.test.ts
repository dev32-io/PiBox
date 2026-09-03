import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const commonAssets = resolve("extensions/visual-companion/assets");
const architectureAssets = resolve("skills/architecture-visualizer/assets");

function declaration(css: string, name: string): string | undefined {
	return css.match(new RegExp(`${name}\\s*:\\s*([^;]+)`))?.[1]?.trim();
}

function contrastRatio(foreground: string, background: string): number {
	const luminance = (hex: string) => {
		const channels = hex.match(/[\da-f]{2}/gi)?.map((channel) => Number.parseInt(channel, 16) / 255) ?? [];
		const [red = 0, green = 0, blue = 0] = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
		return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
	};
	const foregroundLuminance = luminance(foreground);
	const backgroundLuminance = luminance(background);
	const lighter = Math.max(foregroundLuminance, backgroundLuminance);
	const darker = Math.min(foregroundLuminance, backgroundLuminance);
	return (lighter + 0.05) / (darker + 0.05);
}

test("approved semantic tokens provide the exact medium-charcoal palette and restrained elevation recipes", async () => {
	const css = await readFile(resolve(commonAssets, "design-tokens.css"), "utf8");
	const expected = {
		"--color-canvas": "#242528",
		"--color-canvas-soft": "#292a2e",
		"--color-surface": "#303136",
		"--color-surface-raised": "#37383e",
		"--color-surface-strong": "#3e4046",
		"--color-surface-hover": "#484a51",
		"--color-surface-inset": "#27282c",
		"--color-navy-well": "var(--color-surface-inset)",
		"--color-selected-well": "#3c3838",
		"--color-border-subtle": "#4d4f57",
		"--color-border": "#62656f",
		"--color-border-strong": "#7b7f8a",
		"--color-top-edge": "rgb(255 248 240 / 3%)",
		"--color-top-edge-strong": "rgb(255 248 240 / 8%)",
		"--color-text": "#e7e4e0",
		"--color-text-secondary": "#cac6c0",
		"--color-text-muted": "#aba7a1",
		"--color-text-disabled": "#8c8984",
		"--color-text-inverse": "#242528",
		"--color-accent": "#d99a7b",
		"--color-accent-hover": "#e8ad8e",
		"--color-accent-strong": "#b9795d",
		"--color-accent-soft": "rgb(217 154 123 / 12%)",
		"--color-success": "#afc8a7",
		"--color-success-soft": "rgb(175 200 167 / 12%)",
		"--color-warning": "#dbba75",
		"--color-warning-soft": "rgb(219 186 117 / 12%)",
		"--color-danger": "#e6acac",
		"--color-danger-soft": "rgb(230 172 172 / 12%)",
		"--color-info": "#acbfd1",
		"--color-info-soft": "rgb(172 191 209 / 12%)",
		"--color-data-violet": "#c2b5e3",
		"--color-data-violet-soft": "rgb(194 181 227 / 12%)",
		"--color-concurrent": "#c2b5e3",
		"--color-concurrent-soft": "rgb(194 181 227 / 12%)",
		"--color-scrim": "rgb(20 20 22 / 66%)",
		"--gradient-surface-raised": "linear-gradient(180deg, var(--color-surface-strong), var(--color-surface-raised))",
		"--gradient-header": "linear-gradient(180deg, rgb(55 56 62 / 96%), rgb(42 43 47 / 96%))",
		"--gradient-workflow-hero": "linear-gradient(135deg, rgb(61 58 58 / 96%), rgb(43 44 48 / 98%))",
		"--gradient-stage-header": "linear-gradient(90deg, rgb(217 154 123 / 7%), transparent 68%)",
		"--gradient-accent": "linear-gradient(135deg, var(--color-accent-strong), var(--color-accent))",
		"--shadow-surface": "0 1px 0 var(--color-top-edge), 0 3px 10px rgb(0 0 0 / 16%)",
		"--shadow-panel": "0 1px 0 var(--color-top-edge), 0 10px 26px rgb(0 0 0 / 20%)",
		"--shadow-directional": "0 5px 14px rgb(0 0 0 / 22%)",
		"--shadow-inset-well": "inset 0 1px 2px rgb(0 0 0 / 24%)",
		"--shadow-overlay": "0 20px 48px rgb(0 0 0 / 38%)",
		"--shadow-drawer": "0 24px 64px rgb(0 0 0 / 44%)",
		"--shadow-accent-glow": "0 0 18px var(--color-accent-soft)",
		"--focus-ring": "0 0 0 3px rgb(217 154 123 / 30%), 0 0 0 1px var(--color-accent-hover)",
	};
	for (const [name, value] of Object.entries(expected)) assert.equal(declaration(css, name), value, name);
	for (const contract of ["--font-sans", "--font-mono", "--space-1", "--space-10", "--radius-sm", "--radius-pill", "--motion-fast", "--motion-normal", "--focus-ring", "--header-height", "--content-max-width", "--lane-width", "--drawer-width"]) assert.ok(declaration(css, contract), contract);
	assert.equal(declaration(css, "--font-size-xs"), "12px");
	assert.match(css, /color-scheme:\s*dark/);
	assert.match(css, /:focus-visible/);
	assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("small semantic colors remain readable on normal and hover charcoal surfaces", async () => {
	const css = await readFile(resolve(commonAssets, "design-tokens.css"), "utf8");
	const surface = declaration(css, "--color-surface")!;
	const hover = declaration(css, "--color-surface-hover")!;
	assert.ok(contrastRatio(declaration(css, "--color-accent")!, surface) >= 4.5, "primary accent on normal surface");
	for (const token of ["--color-accent-hover", "--color-success", "--color-warning", "--color-danger", "--color-info", "--color-concurrent"]) {
		assert.ok(contrastRatio(declaration(css, token)!, hover) >= 4.5, `${token} on hover surface`);
	}
});

test("increased-contrast tokens strengthen boundaries, typography, focus, and scrim", async () => {
	const css = await readFile(resolve(commonAssets, "design-tokens.css"), "utf8");
	const contrast = css.slice(css.indexOf("@media (prefers-contrast: more)"), css.indexOf("@media (prefers-reduced-motion: reduce)"));
	const expected = {
		"--color-border-subtle": "#7b7f8a",
		"--color-border": "#9a9da6",
		"--color-border-strong": "#c4c6cc",
		"--color-text-muted": "#d0ccc6",
		"--color-text-disabled": "#b7b3ad",
		"--color-accent": "#e8ad8e",
		"--color-accent-hover": "#f0bea5",
		"--color-accent-soft": "rgb(232 173 142 / 24%)",
		"--color-concurrent": "#d2c8ea",
		"--color-concurrent-soft": "rgb(210 200 234 / 24%)",
		"--color-top-edge": "rgb(255 248 240 / 14%)",
		"--color-top-edge-strong": "rgb(255 248 240 / 22%)",
		"--color-scrim": "rgb(20 20 22 / 78%)",
	};
	for (const [name, value] of Object.entries(expected)) assert.equal(declaration(contrast, name), value, name);
});

test("shell and Architecture consume common tokens with readable system fallbacks", async () => {
	const [shellHtml, shellCss, architectureHtml, architectureCss, architectureApp, storyCss, mockupCss] = await Promise.all([
		readFile(resolve(commonAssets, "index.html"), "utf8"),
		readFile(resolve(commonAssets, "styles.css"), "utf8"),
		readFile(resolve(architectureAssets, "index.html"), "utf8"),
		readFile(resolve(architectureAssets, "styles.css"), "utf8"),
		readFile(resolve(architectureAssets, "app.js"), "utf8"),
		readFile(resolve("extensions/visual-companion/story-board/assets/styles.css"), "utf8"),
		readFile(resolve("extensions/visual-companion/mockup/assets/styles.css"), "utf8"),
	]);
	assert.match(shellHtml, /background:\s*Canvas;\s*color:\s*CanvasText/, "inline shell fallback must survive a failed asset request");
	assert.match(shellHtml, /\/assets\/design-tokens\.css/);
	assert.match(architectureHtml, /\/assets\/design-tokens\.css/);
	assert.match(shellCss, /var\(--color-canvas,\s*Canvas\)/);
	assert.match(architectureCss, /var\(--color-text,\s*CanvasText\)/);
	assert.match(architectureApp, /getComputedStyle\(document\.documentElement\)/);
	assert.match(architectureApp, /theme\.accent/);
	assert.doesNotMatch([shellCss, architectureCss, architectureApp, storyCss, mockupCss].join("\n"), /#[\da-f]{3,8}\b|rgba?\(/i, "viewer assets must not establish a second shared palette");
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
