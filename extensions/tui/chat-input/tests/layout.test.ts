import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { frameEditorLines, isEditorRail, scrollLabel } from "../layout.js";

const identity = (value: string) => value;

test("recognizes native rails and viewport labels", () => {
	assert.equal(isEditorRail("────────"), true);
	assert.equal(isEditorRail("── ↑ 12 more ──"), true);
	assert.equal(scrollLabel("── ↓ 3 more ──"), "↓ 3 more");
	assert.equal(isEditorRail("ordinary text"), false);
});

test("frames body while leaving autocomplete outside", () => {
	const rendered = frameEditorLines(["──────────", "hello", "──────────", "completion"], {
		width: 18,
		contentWidth: 12,
		paddingX: 1,
		prefix: "❯",
		paintBorder: identity,
		paintPrefix: identity,
	});
	assert.ok(rendered);
	assert.equal(rendered[0], "┌────────────────┐");
	assert.match(rendered[1] ?? "", /^│ ❯ hello/);
	assert.equal(rendered.at(-1), " completion");
	for (const line of rendered) assert.ok(visibleWidth(line) <= 18);
});
