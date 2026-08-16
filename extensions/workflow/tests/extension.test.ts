import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow, { WORKFLOW_CHILD_EXTENSION_PATHS } from "../index.js";

test("loads workflow and memory context hooks explicitly in spawned agents", () => {
	assert.equal(WORKFLOW_CHILD_EXTENSION_PATHS.length, 2);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[0] ?? "", /workflow\/index\.ts$/);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[1] ?? "", /memory-adapter\/index\.ts$/);
});

test("registers the resource API and hides legacy planning tools from the main session", async () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const schemas = new Map<string, unknown>();
	const descriptions = new Map<string, string>();
	const definitions = new Map<string, any>();
	let activeTools: string[] = [];
	const pi = {
		events: { on() {}, emit() {} },
		registerTool(definition: { name: string; description?: string; parameters?: unknown }) {
			tools.push(definition.name);
			definitions.set(definition.name, definition);
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

	workflow(pi);
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
		"resource_list",
		"resource_read",
		"resource_write",
		"resource_delete",
		"workflow_status",
		"workflow_list",
		"workflow_get",
		"workflow_schema",
		"workflow_plan_write",
		"workflow_create",
		"workflow_patch",
		"workflow_delete",
		"workflow_apply_change",
		"workflow_transition",
		"workflow_init",
		"task_integrate",
		"evaluation_record",
		"work_item_complete",
	]);
	assert.deepEqual(commands, ["workflow", "harness"]);
	assert.doesNotMatch(await readFile(new URL("../index.ts", import.meta.url), "utf8"), /command === "approve"/);
	assert.equal(tools.includes("planning_approve"), false);
	assert.doesNotMatch(descriptions.get("workflow_transition") ?? "", /approval/i);
	assert.doesNotMatch(JSON.stringify(schemas.get("workflow_patch")), /retain-approval|request-user/);
	assert.doesNotMatch(JSON.stringify(schemas.get("workflow_patch")), /expectedRevision|contractDigest/);
	assert.doesNotMatch(JSON.stringify(schemas.get("workflow_apply_change")), /expectedRevision|contractDigest/);
	assert.doesNotMatch(JSON.stringify(schemas.get("workflow_create")), /tier|deliberation|isolation|parallelism/);
	const resourceWriteSchema = JSON.stringify(schemas.get("resource_write"));
	assert.match(resourceWriteSchema, /ref.*type.*parent.*value/);
	assert.doesNotMatch(resourceWriteSchema, /authority|expectedRevision|briefSections|criterionContributions/);
	assert.ok(resourceWriteSchema.length < 1000, "always-visible resource writer stays shallow");
	assert.ok(JSON.stringify(schemas.get("workflow_apply_change")).length < 2500, "always-visible repair batch stays compact");
	assert.match(JSON.stringify(schemas.get("resource_list")), /type.*parent.*query/);
	assert.match(JSON.stringify(schemas.get("resource_read")), /ref/);
	const completionSchema = schemas.get("work_item_complete") as { type?: string; properties?: Record<string, unknown>; anyOf?: unknown };
	assert.equal(completionSchema.type, "object");
	assert.deepEqual(Object.keys(completionSchema.properties ?? {}), ["workItemId", "outcomeSections", "outcome"]);
	assert.equal(completionSchema.anyOf, undefined, "completion arguments remain discoverable to strict local servers");
	assert.match(descriptions.get("task_clarify") ?? "", /Do not call at startup[\s\S]+read only the relevant resource/);
	assert.match(descriptions.get("task_request_change") ?? "", /consult the one relevant canonical source[\s\S]+smallest safe amendment/i);
	assert.match(descriptions.get("task_blocked") ?? "", /external blocker[\s\S]+cannot be resolved through a task-contract amendment/i);
	assert.deepEqual(events, ["tool_call", "before_agent_start", "session_start", "message_end", "agent_settled", "session_shutdown"]);
	activeTools = [...tools, "read"];
	await handlers.get("session_start")?.({ reason: "startup" }, { cwd: "/tmp/not-a-pibox-repository", sessionManager: { getSessionId: () => "session", getSessionFile: () => undefined }, ui: { notify() {} } });
	for (const legacy of ["work_item_create", "artifact_update", "task_define", "evaluation_define", "planning_submit"]) assert.equal(tools.includes(legacy), false, legacy);
	assert.equal(tools.includes("agent_run"), false, "direct specialist duplication is removed");
	for (const preferred of ["resource_list", "resource_read", "resource_write", "resource_delete", "workflow_apply_change"]) assert.equal(activeTools.includes(preferred), true, preferred);
	for (const compatibility of ["workflow_list", "workflow_get", "workflow_schema", "workflow_plan_write", "workflow_create", "workflow_patch", "workflow_delete"]) assert.equal(activeTools.includes(compatibility), false, compatibility);
	assert.equal(activeTools.includes("read"), true);
});
