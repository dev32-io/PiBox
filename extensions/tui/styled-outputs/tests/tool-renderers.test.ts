import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderToolCall, renderToolResult } from "../components/tool-renderers.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

test("renders compact Pikit-style tool graphics", () => {
	const call = renderToolCall("read", { path: "/tmp/project/file.ts" }, theme, {
		cwd: "/tmp/project",
		isPartial: false,
		isError: false,
	});
	assert.match(call.render(100).join("\n"), /✓ Read file\.ts/);

	const result = renderToolResult("read", { content: [{ type: "text", text: "one\ntwo" }] }, { expanded: false }, theme, {
		args: { path: "/tmp/project/file.ts" },
		isError: false,
	});
	const rendered = result.render(100).join("\n");
	assert.match(rendered, /└─ Done • 2 lines/);
	assert.match(rendered, /to expand/);
});
