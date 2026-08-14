import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SUBAGENT_TOOLS, PIBOX_EVALUATION_TOOL_GROUP, PIBOX_TASK_TOOL_GROUP, PIBOX_TOOL_GROUPS, resolveToolSelectors, validateToolSelectors } from "../tool-groups.js";

test("expands namespaced PiBox tool groups without leaking selector names", () => {
	const resolved = resolveToolSelectors(["read", PIBOX_TASK_TOOL_GROUP, "read"]);
	assert.equal(resolved[0], "read");
	assert.equal(resolved.includes(PIBOX_TASK_TOOL_GROUP), false);
	assert.deepEqual(resolved.slice(1), [...PIBOX_TOOL_GROUPS[PIBOX_TASK_TOOL_GROUP]]);
});

test("adds managed capability groups at runtime while preserving agent restrictions", () => {
	assert.deepEqual(resolveToolSelectors(["read"], [PIBOX_EVALUATION_TOOL_GROUP]), ["read", ...PIBOX_TOOL_GROUPS[PIBOX_EVALUATION_TOOL_GROUP]]);
});

test("keeps the conventional default child tools available when definitions omit tools", () => {
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("read"));
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("edit"));
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("ls"));
});

test("rejects unknown selectors in the reserved PiBox namespace", () => {
	assert.throws(() => validateToolSelectors(["pibox:unknown"]), /Unknown PiBox tool group/);
});
