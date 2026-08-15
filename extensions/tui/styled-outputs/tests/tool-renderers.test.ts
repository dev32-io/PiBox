import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { classifyLoadedResource, normalizeDiffGutters, renderToolCall, renderToolResult } from "../components/tool-renderers.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

test("reserves a sign column in diff line-number gutters", () => {
	assert.equal(
		normalizeDiffGutters(" 8     context\n+8     added\n-23    removed\n 24    context"),
		"  8     context\n+ 8     added\n-23    removed\n 24    context",
	);
});

test("renders skill and rule reads as compact loaded resources", () => {
	assert.deepEqual(classifyLoadedResource("/repo/skills/architecture-visualizer/SKILL.md"), { kind: "skill", label: "architecture-visualizer" });
	assert.deepEqual(classifyLoadedResource("/repo/.claude/rules/gateway/typescript.md"), { kind: "rule", label: "gateway/typescript" });
	assert.deepEqual(classifyLoadedResource("~/.pi/agent/rules/personal.md"), { kind: "rule", label: "personal" });
	assert.equal(classifyLoadedResource("/repo/src/rules.ts"), undefined);

	const call = renderToolCall("read", { path: "/repo/.pi/rules/typescript.md" }, theme, { cwd: "/repo", isPartial: false, isError: false });
	assert.equal(call.render(100).join("\n").trimEnd(), "✓ Loaded rule typescript");
	const collapsed = renderToolResult("read", { content: [{ type: "text", text: "rule body" }] }, { expanded: false }, theme, {
		args: { path: "/repo/.pi/rules/typescript.md" }, isError: false, state: {},
	});
	assert.deepEqual(collapsed.render(100), []);
});

test("caps read previews at ten lines", () => {
	const call = renderToolCall("read", { path: "/tmp/project/file.ts" }, theme, {
		cwd: "/tmp/project",
		isPartial: false,
		isError: false,
	});
	assert.match(call.render(100).join("\n"), /^✓ Read file\.ts/);

	const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
	const result = renderToolResult("read", { content: [{ type: "text", text: lines.join("\n") }] }, { expanded: false }, theme, {
		args: { path: "/tmp/project/file.ts" },
		isError: false,
		state: {},
	});
	const rendered = result.render(100).join("\n");
	assert.match(rendered, /^└─ Done • 12 lines/);
	assert.match(rendered, /line 10/);
	assert.doesNotMatch(rendered, /line 11/);
	assert.match(rendered, /… \+2 more lines \(ctrl\+o to expand\)/);
});

test("keeps expanded output nested beneath the message-aligned tool row", () => {
	const result = renderToolResult("bash", { content: [{ type: "text", text: "one\ntwo" }] }, { expanded: true }, theme, {
		args: { command: "printf output" },
		isError: false,
	});
	assert.deepEqual(result.render(100).map((line) => stripTerminalSequences(line).trimEnd()), ["└─ Done • 2 lines", "   one", "   two"]);
});

test("preserves leading whitespace in tool output", () => {
	const result = renderToolResult("read", { content: [{ type: "text", text: "function demo() {\n\treturn true;\n}" }] }, { expanded: true }, theme, {
		args: { path: "/tmp/project/file.ts" },
		isError: false,
		state: {},
	});
	assert.deepEqual(result.render(100).map((line) => stripTerminalSequences(line).trimEnd()), ["└─ Done • 3 lines", "   function demo() {", "      return true;", "   }"]);
});

test("caps collapsed long-line output by characters", () => {
	const result = renderToolResult("bash", { content: [{ type: "text", text: "x".repeat(1_400) }] }, { expanded: false }, theme, {
		args: { command: "emit source map" },
		isError: false,
	});
	const rendered = stripTerminalSequences(result.render(2_000).join("\n"));
	assert.match(rendered, /… \+200 more characters \(ctrl\+o to expand\)/);
	assert.doesNotMatch(rendered, new RegExp(`x{1201}`));
});
