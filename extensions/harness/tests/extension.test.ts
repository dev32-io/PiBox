import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import harness from "../index.js";

test("registers orchestrator capabilities while keeping approval command-only", () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const pi = {
		registerTool(definition: { name: string }) {
			tools.push(definition.name);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string) {
			events.push(name);
		},
	} as unknown as ExtensionAPI;

	harness(pi);
	assert.deepEqual(tools, [
		"harness_status",
		"work_item_create",
		"artifact_create",
		"artifact_update",
		"task_define",
		"evaluation_define",
		"planning_submit",
	]);
	assert.deepEqual(commands, ["harness"]);
	assert.equal(tools.includes("planning_approve"), false);
	assert.deepEqual(events, ["session_start", "agent_settled", "session_shutdown"]);
});
