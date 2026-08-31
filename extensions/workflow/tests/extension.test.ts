import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow, { structuredCapabilityError, WORKFLOW_CHILD_EXTENSION_PATHS } from "../index.js";
import { HarnessError } from "../errors.js";
import { FAST_MODE_POLICY_EVENT } from "../../fast-mode/policy.js";
import { getActiveFastModePolicy } from "../../fast-mode/runtime.js";
import { ALL_TOOLS_SUBAGENT_ENV } from "../tool-groups.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";

test("mutation errors preserve state-aware remediation for tool callers", () => {
	const formatted = structuredCapabilityError(new HarnessError("CAPABILITY_DENIED", "Completed baseline is immutable.", { workflowState: { phase: "complete", state: "complete" }, guidance: { tool: "workflow_transition", arguments: { ref: "work-item:done", action: "reopen" }, outcome: "Use the returned amendment ref." } }), "work-item:done");
	const payload = JSON.parse(formatted.message);
	assert.equal(payload.code, "CAPABILITY_DENIED");
	assert.equal(payload.resourceRef, "work-item:done");
	assert.equal(payload.details.workflowState.phase, "complete");
	assert.equal(payload.details.guidance.tool, "workflow_transition");
	assert.equal(payload.details.guidance.arguments.action, "reopen");
	assert.match(payload.details.guidance.outcome, /amendment ref/);
});

test("loads workflow, context, and Fast-mode hooks explicitly in spawned agents", () => {
	assert.equal(WORKFLOW_CHILD_EXTENSION_PATHS.length, 4);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[0] ?? "", /workflow\/index\.ts$/);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[1] ?? "", /memory-adapter\/index\.ts$/);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[2] ?? "", /distill\/index\.ts$/);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[3] ?? "", /fast-mode\/index\.ts$/);
});

test("packaged standalone child keeps generic capabilities without workflow prompt or tools", { concurrency: false }, async () => {
	const previousRole = process.env[PIBOX_RUNTIME_ROLE_ENV];
	const previousId = process.env.PIBOX_SUBAGENT_ID;
	const previousAllTools = process.env[ALL_TOOLS_SUBAGENT_ENV];
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
	delete process.env.PIBOX_SUBAGENT_ID;
	process.env[ALL_TOOLS_SUBAGENT_ENV] = "1";
	try {
		const genericTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "memory_adapter", "distill_prepare", "distill_collect", "distill_read", "distill_record", "distill_compare", "distill_instruction_check"];
		const tools = new Map(genericTools.map((name) => [name, { name }]));
		const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
		let activeTools = [...tools.keys()];
		const pi = {
			events: { on() {}, emit() {} },
			registerTool(definition: any) { tools.set(definition.name, definition); activeTools.push(definition.name); },
			registerCommand() {},
			on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
			getAllTools() { return [...tools.values()]; },
			getActiveTools() { return activeTools; },
			setActiveTools(names: string[]) { activeTools = names; },
		} as unknown as ExtensionAPI;
		workflow(pi);
		const promptResults = await Promise.all((handlers.get("before_agent_start") ?? []).map((handler) => handler({ systemPrompt: "base", prompt: "task" }, {})));
		assert.deepEqual(promptResults, [undefined], "the workflow orchestrator contract is not appended in an explicit standalone child");
		for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, {});
		assert.deepEqual(activeTools.sort(), [...genericTools].sort());
		assert.equal(activeTools.some((name) => /^(resource|workflow|task|evaluation)_/.test(name)), false);
	} finally {
		if (previousRole === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previousRole;
		if (previousId === undefined) delete process.env.PIBOX_SUBAGENT_ID; else process.env.PIBOX_SUBAGENT_ID = previousId;
		if (previousAllTools === undefined) delete process.env[ALL_TOOLS_SUBAGENT_ENV]; else process.env[ALL_TOOLS_SUBAGENT_ENV] = previousAllTools;
	}
});

test("registers the resource API and hides legacy planning tools from the main session", async () => {
	const tools: string[] = [];
	const commands: string[] = [];
	const events: string[] = [];
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const schemas = new Map<string, unknown>();
	const descriptions = new Map<string, string>();
	const definitions = new Map<string, any>();
	const busHandlers = new Map<string, Array<(value: unknown) => void>>();
	let activeTools: string[] = [];
	const pi = {
		events: {
			on(name: string, handler: (value: unknown) => void) { busHandlers.set(name, [...(busHandlers.get(name) ?? []), handler]); },
			emit(name: string, value: unknown) { for (const handler of busHandlers.get(name) ?? []) handler(value); },
		},
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
	assert.deepEqual(getActiveFastModePolicy(), { main: false, subagents: "off" });
	pi.events.emit(FAST_MODE_POLICY_EVENT, { main: true, subagents: "low" });
	assert.deepEqual(getActiveFastModePolicy(), { main: true, subagents: "low" }, "shared event bus bridges isolated extension module graphs");
	pi.events.emit(FAST_MODE_POLICY_EVENT, { main: "invalid", subagents: "max" });
	assert.deepEqual(getActiveFastModePolicy(), { main: true, subagents: "low" }, "malformed policy events are ignored");
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
		"workflow_ledger",
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
	assert.match(descriptions.get("resource_write") ?? "", /local task tier.*explicit user permission.*assignment\.rationale/i);
	assert.match(descriptions.get("workflow_plan_write") ?? "", /local task routing.*explicit user permission.*assignment\.rationale/i);
	assert.match(resourceWriteSchema, /ref.*type.*parent.*value/);
	assert.doesNotMatch(resourceWriteSchema, /authority|expectedRevision|briefSections|criterionContributions/);
	assert.ok(resourceWriteSchema.length < 1000, "always-visible resource writer stays shallow");
	assert.ok(JSON.stringify(schemas.get("workflow_apply_change")).length < 2500, "always-visible repair batch stays compact");
	assert.match(JSON.stringify(schemas.get("resource_list")), /type.*parent.*query/);
	assert.match(JSON.stringify(schemas.get("resource_read")), /ref/);
	const taskSchemaResult = await definitions.get("workflow_schema").execute("test-task", { operation: "create", resource: "task", limit: 12000 });
	assert.match((taskSchemaResult as any).content[0].text, /local[\s\S]*Permission-gated[\s\S]*explicitly requests local/i);
	const schemaResult = await definitions.get("workflow_schema").execute("test", { operation: "create", resource: "stage", limit: 12000 });
	const exactStageCreateSchema = JSON.parse((schemaResult as any).content[0].text.split("\n", 2)[1]);
	const stageSchema = exactStageCreateSchema.properties.body;
	assert.equal(Check({ id: "ordered", tasks: ["task"], mode: "sequential" }, stageSchema), true);
	assert.equal(Check({ id: "legacy", tasks: ["task"] }, stageSchema), true, "mode remains optional for legacy authoring");
	assert.deepEqual(stageSchema.properties.mode.anyOf.map((entry: { const: string }) => entry.const), ["sequential", "concurrent"]);
	const completionSchema = schemas.get("work_item_complete") as { type?: string; properties?: Record<string, unknown>; anyOf?: unknown };
	assert.equal(completionSchema.type, "object");
	assert.deepEqual(Object.keys(completionSchema.properties ?? {}), ["workItemId", "outcomeSections", "outcome"]);
	assert.equal(completionSchema.anyOf, undefined, "completion arguments remain discoverable to strict local servers");
	assert.match(descriptions.get("task_clarify") ?? "", /Do not call at startup[\s\S]+read only the relevant resource/);
	assert.match(descriptions.get("task_request_change") ?? "", /consult the one relevant canonical source[\s\S]+smallest safe amendment/i);
	assert.match(descriptions.get("task_blocked") ?? "", /external blocker[\s\S]+cannot be resolved through a task-contract amendment/i);
	assert.deepEqual(events, ["tool_call", "before_agent_start", "session_start", "session_shutdown"], "service transport owns child results; workflow registers no per-turn legacy result writer");
	activeTools = [...tools, "read"];
	await handlers.get("session_start")?.({ reason: "startup" }, {
		cwd: "/tmp/not-a-pibox-repository",
		sessionManager: { getSessionId: () => { throw new Error("fresh startup must not initialize workflow runtime"); }, getSessionFile: () => undefined },
		ui: { notify() {} },
	});
	for (const legacy of ["work_item_create", "artifact_update", "task_define", "evaluation_define", "planning_submit"]) assert.equal(tools.includes(legacy), false, legacy);
	assert.equal(tools.includes("agent_run"), false, "direct specialist duplication is removed");
	for (const preferred of ["resource_list", "resource_read", "resource_write", "resource_delete", "workflow_apply_change"]) assert.equal(activeTools.includes(preferred), true, preferred);
	for (const compatibility of ["workflow_list", "workflow_get", "workflow_schema", "workflow_plan_write", "workflow_create", "workflow_patch", "workflow_delete"]) assert.equal(activeTools.includes(compatibility), false, compatibility);
	assert.equal(activeTools.includes("workflow_ledger"), false, "main sessions do not receive the worker ledger");
	assert.equal(activeTools.includes("read"), true);
	await handlers.get("session_shutdown")?.({ reason: "quit" });
	assert.deepEqual(getActiveFastModePolicy(), { main: false, subagents: "off" });
});
