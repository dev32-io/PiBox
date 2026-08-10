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
		"task_context",
		"task_checkpoint",
		"task_request_change",
		"task_report_decision",
		"task_blocked",
		"task_complete",
		"evaluation_context",
		"evidence_record",
		"finding_report",
		"evaluation_checkpoint",
		"evaluation_complete",
		"harness_status",
		"work_item_create",
		"artifact_create",
		"artifact_update",
		"task_define",
		"evaluation_define",
		"agent_run",
		"evaluation_launch",
		"task_launch",
		"task_integrate",
		"agent_status",
		"agent_control",
		"evaluation_record",
		"work_item_complete",
		"planning_submit",
	]);
	assert.deepEqual(commands, ["harness"]);
	assert.equal(tools.includes("planning_approve"), false);
	assert.deepEqual(events, ["session_start", "agent_settled", "session_shutdown"]);
});
