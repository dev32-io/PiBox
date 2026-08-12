import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderToolCall, renderToolResult } from "../components/tool-renderers.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

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
	assert.deepEqual(result.render(100).map((line) => line.trimEnd()), ["└─ Done • 2 lines", "   one", "   two"]);
});
