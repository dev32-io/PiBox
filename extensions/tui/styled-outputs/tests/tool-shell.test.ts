import assert from "node:assert/strict";
import test from "node:test";
import { Box, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { LinePrefixedComponent } from "../components/tool-shell.js";

test("decorates third-party tool output while preserving nested lines", () => {
	const component = new LinePrefixedComponent(
		new Text("3 sources\nSource: example", 0, 0),
		"└─ Done • ",
		"   ",
		10,
		3,
	);

	assert.deepEqual(component.render(80).map((line) => stripTerminalSequences(line).trimEnd()), [
		"└─ Done • 3 sources",
		"   Source: example",
	]);
});

test("shows three preview lines and a dynamic expansion hint", () => {
	const box = new Box(1, 0, (text) => `\x1b[42m${text}\x1b[0m`);
	box.addChild(new Text("first\nsecond\nthird\nfourth\nfifth", 0, 0));
	const component = new LinePrefixedComponent(
		box,
		"└─ Done • ",
		"   ",
		10,
		3,
		"",
		0,
		3,
		(text) => text,
		(omitted) => `… +${omitted} lines (ctrl+o to expand)`,
	);

	assert.deepEqual(component.render(80).map((line) => stripTerminalSequences(line).trimEnd()), [
		"└─ Done • first",
		"    second",
		"    third",
		"   … +2 lines (ctrl+o to expand)",
	]);
});

test("reserves enough width for the longest lifecycle prefix", () => {
	let renderedWidth = 0;
	const child = {
		render(width: number): string[] {
			renderedWidth = width;
			return ["progress"];
		},
		invalidate() {},
	};
	const component = new LinePrefixedComponent(child, "└─ Running… • ", "   ", 14, 3);

	component.render(40);
	assert.equal(renderedWidth, 26);
});
