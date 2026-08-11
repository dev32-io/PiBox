import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import harness from "../index.js";

test("registers the resource API and hides legacy planning tools from the main session", async () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const schemas = new Map<string, unknown>();
	const descriptions = new Map<string, string>();
	let activeTools: string[] = [];
	const pi = {
		registerTool(definition: { name: string; description?: string; parameters?: unknown }) {
			tools.push(definition.name);
			descriptions.set(definition.name, definition.description ?? "");
			schemas.set(definition.name, definition.parameters);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		on(name: string, handler: (...args: any[]) => unknown) {
			events.push(name);
			handlers.set(name, handler);
		},
		getActiveTools() { return activeTools; },
		setActiveTools(names: string[]) { activeTools = names; },
	} as unknown as ExtensionAPI;

	harness(pi);
	assert.deepEqual(tools, [
		"task_clarify",
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
		"exploration_context",
		"exploration_checkpoint",
		"exploration_blocked",
		"exploration_complete",
		"harness_status",
		"harness_list",
		"harness_get",
		"harness_create",
		"harness_patch",
		"harness_delete",
		"harness_apply_change",
		"harness_transition",
		"harness_init",
		"work_item_create",
		"work_item_status",
		"artifact_create",
		"artifact_update",
		"artifact_link",
		"artifact_reconcile",
		"task_define",
		"task_update",
		"evaluation_define",
		"exploration_launch",
		"agent_run",
		"evaluation_launch",
		"task_launch",
		"task_integrate",
		"agent_status",
		"agent_control",
		"agent_respond",
		"evaluation_record",
		"work_item_complete",
		"planning_submit",
	]);
	assert.deepEqual(commands, ["harness"]);
	assert.equal(tools.includes("planning_approve"), false);
	assert.doesNotMatch(JSON.stringify(schemas.get("harness_patch")), /expectedRevision|contractDigest/);
	assert.doesNotMatch(JSON.stringify(schemas.get("harness_apply_change")), /expectedRevision|contractDigest/);
	assert.match(descriptions.get("task_clarify") ?? "", /Do not call at startup[\s\S]+read only the relevant resource/);
	assert.deepEqual(events, ["before_agent_start", "session_start", "agent_start", "message_end", "message_update", "agent_settled", "session_shutdown"]);
	activeTools = [...tools, "read"];
	await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/tmp/not-a-pibox-repository", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined }, ui: { notify() {} } });
	for (const legacy of ["work_item_create", "artifact_update", "task_define", "evaluation_define", "planning_submit"]) assert.equal(activeTools.includes(legacy), false, legacy);
	for (const preferred of ["harness_list", "harness_get", "harness_create", "harness_patch", "harness_apply_change"]) assert.equal(activeTools.includes(preferred), true, preferred);
	assert.equal(activeTools.includes("read"), true);
});
