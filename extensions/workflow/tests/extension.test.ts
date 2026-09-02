import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow, { structuredCapabilityError, WORKFLOW_CHILD_EXTENSION_PATHS } from "../index.js";
import { HarnessError } from "../errors.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";

function host() {
	const tools: string[] = []; const commands: string[] = []; const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	const pi = { events: { on() {}, emit() {} }, registerTool(definition: any) { tools.push(definition.name); }, registerCommand(name: string) { commands.push(name); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
	return { pi, tools, commands, handlers };
}

test("structured target errors preserve concrete refusal details", () => {
	const formatted = structuredCapabilityError(new HarnessError("CAPABILITY_DENIED", "Legacy workflow is active.", { legacy: { active: true } }), "work-item:old");
	const payload = JSON.parse(formatted.message);
	assert.equal(payload.code, "CAPABILITY_DENIED"); assert.equal(payload.resourceRef, "work-item:old"); assert.equal(payload.details.legacy.active, true);
});

test("managed child extension paths preserve generic context hooks", () => {
	assert.equal(WORKFLOW_CHILD_EXTENSION_PATHS.length, 4);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[0] ?? "", /workflow\/index\.ts$/);
});

test("main session registers only target planning tools", () => {
	const previous = process.env[PIBOX_RUNTIME_ROLE_ENV]; delete process.env[PIBOX_RUNTIME_ROLE_ENV];
	const f = host(); try { workflow(f.pi); } finally { if (previous === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previous; }
	assert.deepEqual(f.tools, ["resource_list", "resource_read", "story_write", "e2e_write", "task_write", "stage_write", "resource_delete", "workflow_compile", "workflow_status", "workflow_init"]);
	assert.deepEqual(f.commands, ["workflow", "harness"]);
	for (const obsolete of ["resource_write", "workflow_apply_change", "workflow_transition", "workflow_list", "workflow_get", "workflow_schema", "workflow_plan_write", "workflow_create", "workflow_patch", "workflow_delete", "workflow_checkpoint", "task_integrate", "evaluation_record", "work_item_complete", "task_checkpoint", "task_complete", "evaluation_complete", "workflow_ledger"]) assert.equal(f.tools.includes(obsolete), false, obsolete);
});

test("generic children receive no workflow tool while managed target tasks receive only task_clarify", () => {
	const previous = { role: process.env[PIBOX_RUNTIME_ROLE_ENV], story: process.env.PIBOX_WORKFLOW_STORY_ID, task: process.env.PIBOX_WORKFLOW_TASK_ID, token: process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN };
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
	try {
		let f = host(); workflow(f.pi); assert.deepEqual(f.tools, []);
		process.env.PIBOX_WORKFLOW_STORY_ID = "story"; process.env.PIBOX_WORKFLOW_TASK_ID = "task"; process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN = "token";
		f = host(); workflow(f.pi); assert.deepEqual(f.tools, ["task_clarify"]);
	} finally {
		for (const [key, value] of [[PIBOX_RUNTIME_ROLE_ENV, previous.role], ["PIBOX_WORKFLOW_STORY_ID", previous.story], ["PIBOX_WORKFLOW_TASK_ID", previous.task], ["PIBOX_WORKFLOW_ATTEMPT_TOKEN", previous.token]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});
