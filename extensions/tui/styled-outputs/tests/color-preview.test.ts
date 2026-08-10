import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { colorChip, decorateHexColors, expandHex, relativeLuminance } from "../color-preview.js";
import { DEFAULT_STYLED_OUTPUTS_CONFIG } from "../config.js";

const config = DEFAULT_STYLED_OUTPUTS_CONFIG.colorPreviews;

test("expands shorthand and chooses readable foregrounds", () => {
	assert.deepEqual(expandHex("#abc"), [170, 187, 204]);
	assert.ok(relativeLuminance(255, 255, 255) > relativeLuminance(0, 0, 0));
	assert.match(colorChip("#fff"), /38;2;0;0;0m#fff/);
	assert.match(colorChip("#0B1116"), /38;2;255;255;255m#0B1116/);
});

test("decorates exact text without changing visible width", () => {
	const source = "Primary #62B8D6 and warning #D6A45F";
	const rendered = decorateHexColors(source, config);
	assert.notEqual(rendered, source);
	assert.equal(visibleWidth(rendered), source.length);
	assert.match(rendered, /48;2;98;184;214/);
});

test("protects URLs, link destinations, and fenced code", () => {
	const source = [
		"https://example.test/#62B8D6",
		"[jump](#D6A45F)",
		"```css",
		"color: #62B8D6;",
		"```",
	].join("\n");
	assert.equal(decorateHexColors(source, config), source);
});

test("can include or exclude inline code", () => {
	const source = "use `#62B8D6` now";
	assert.notEqual(decorateHexColors(source, config), source);
	assert.equal(decorateHexColors(source, { ...config, includeInlineCode: false }), source);
});
