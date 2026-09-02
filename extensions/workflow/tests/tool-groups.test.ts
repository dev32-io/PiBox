import assert from "node:assert/strict";
import test from "node:test";
import { ALL_TOOLS_SELECTOR, DEFAULT_SUBAGENT_TOOLS, resolveToolSelectors, validateToolSelectors } from "../tool-groups.js";

test("resolves generic child selectors and maps optional MCP servers to the proxy", () => {
	assert.deepEqual(resolveToolSelectors(["read", "mcp:playwright", "read"]), ["read", "mcp"]);
	assert.deepEqual(resolveToolSelectors([ALL_TOOLS_SELECTOR, "read"]), [ALL_TOOLS_SELECTOR, "read"]);
});

test("target workflow groups and malformed MCP selectors are rejected", () => {
	assert.throws(() => validateToolSelectors(["pibox:task"]), /Obsolete PiBox tool group/);
	assert.throws(() => validateToolSelectors(["mcp:"]), /mcp:<server>/);
});

test("generic defaults remain available without workflow handoff tools", () => {
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("read"));
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("edit"));
	assert.equal(DEFAULT_SUBAGENT_TOOLS.some((tool) => /task_|evaluation_|workflow_/.test(tool)), false);
});
