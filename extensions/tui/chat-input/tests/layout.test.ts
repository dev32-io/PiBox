import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isScrollToBottomClick } from "../index.js";
import { centeredTopLabelRange, frameEditorLines, isEditorRail, scrollLabel } from "../layout.js";

const identity = (value: string) => value;

test("recognizes native rails and viewport labels", () => {
	assert.equal(isEditorRail("────────"), true);
	assert.equal(isEditorRail("── ↑ 12 more ──"), true);
	assert.equal(scrollLabel("── ↓ 3 more ──"), "↓ 3 more");
	assert.equal(isEditorRail("ordinary text"), false);
});

test("centers an optional scroll-to-bottom action in the top border", () => {
	const rendered = frameEditorLines(["────────────────────────", "hello", "────────────────────────"], {
		width: 40,
		contentWidth: 34,
		paddingX: 1,
		prefix: "❯",
		paintBorder: identity,
		paintPrefix: identity,
		topCenterLabel: "↓ Scroll to bottom",
		paintTopCenterLabel: identity,
	});
	assert.ok(rendered);
	assert.equal(rendered[0], "┌───────── ↓ Scroll to bottom ─────────┐");
	assert.deepEqual(centeredTopLabelRange(40, undefined, "↓ Scroll to bottom"), { start: 10, end: 30 });
});

test("hides the centered action when it would overlap native editor scroll status", () => {
	assert.equal(centeredTopLabelRange(30, "↑ 1234 more", "↓ Scroll to bottom"), undefined);
});

test("recognizes only primary clicks inside the rendered action", () => {
	const editor = { render: () => [], invalidate() {} } satisfies Component;
	const root = { component: editor, rect: { x: 5, y: 10, width: 40, height: 3 }, children: [] };
	const range = { start: 10, end: 30 };
	assert.equal(isScrollToBottomClick("\x1b[<0;16;11M", range, root, editor), true);
	assert.equal(isScrollToBottomClick("\x1b[<0;15;11M", range, root, editor), false);
	assert.equal(isScrollToBottomClick("\x1b[<0;16;11m", range, root, editor), false);
	assert.equal(isScrollToBottomClick("\x1b[<2;16;11M", range, root, editor), false);
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
