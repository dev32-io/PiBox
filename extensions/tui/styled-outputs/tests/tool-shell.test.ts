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

test("places expansion hints beside padded Box status text", () => {
	const box = new Box(1, 0, (text) => `\x1b[42m${text}\x1b[0m`);
	box.addChild(new Text("3 sources", 0, 0));
	box.addChild(new Text("preview that should stay collapsed", 0, 0));
	const component = new LinePrefixedComponent(
		box,
		"└─ Done • ",
		"   ",
		10,
		3,
		" • ctrl+o to expand",
		19,
		1,
		(text) => text,
	);

	assert.deepEqual(component.render(80), ["└─ Done • 3 sources • ctrl+o to expand"]);
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
