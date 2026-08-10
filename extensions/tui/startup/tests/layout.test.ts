import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderStartup } from "../layout.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

const counts = { models: 8, components: 5, contextFiles: 2 };
const keys = { model: "ctrl+p", thinking: "shift+tab" };

test("startup remains visible and width-safe across layouts", () => {
	for (const width of [20, 36, 51, 52, 80, 120]) {
		const lines = renderStartup(theme, counts, keys, width);
		assert.ok(lines.some((line) => line.includes("PiBox")));
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
	}
});

test("rattle defines the required visual token groups", async () => {
	const themeFile = JSON.parse(await readFile("themes/rattle.json", "utf8")) as { name: string; colors: Record<string, string>; export: Record<string, string> };
	assert.equal(themeFile.name, "rattle");
	for (const token of [
		"accent", "border", "success", "error", "warning", "text", "userMessageBg", "toolPendingBg",
		"toolSuccessBg", "toolErrorBg", "toolDiffAdded", "toolDiffRemoved", "mdHeading", "mdCodeBlock",
		"syntaxKeyword", "thinkingOff", "thinkingMedium", "thinkingMax", "bashMode",
	]) assert.equal(typeof themeFile.colors[token], "string", token);
	assert.equal(themeFile.export.pageBg, "#0B1116");
});
