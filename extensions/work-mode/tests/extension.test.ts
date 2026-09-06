import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentWorkMode } from "../runtime.js";
import workModeExtension, { modeTransitionImpact } from "../index.js";
import { WORKFLOW_TOOL_NAMES } from "../tool-groups.js";
import { WORK_MODE_ENTRY_TYPE } from "../policy.js";
import { getInteractiveFooterItem, resetInteractiveFooterRegistryForTests } from "../../tui/interactive-footer/registry.js";

function harness(initialEntries: any[] = [], flags: Record<string, unknown> = {}, initialActive?: string[]) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const commands = new Map<string, (...args: any[]) => any>();
	const appended: any[] = [];
	const statuses = new Map<string, string | undefined>();
	const allNames = ["read", "subagent_spawn", ...WORKFLOW_TOOL_NAMES, "unrelated"];
	let active = initialActive ? [...initialActive] : [...allNames];
	let branch = initialEntries;
	let confirms = 0;
	const pi = {
		registerFlag() {},
		registerCommand(name: string, spec: any) { commands.set(name, spec.handler); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		getFlag(name: string) { return flags[name]; },
		getAllTools() { return allNames.map((name) => ({ name })); },
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; },
		appendEntry(customType: string, data: unknown) { appended.push({ type: "custom", customType, data }); },
		events: { emit() {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp",
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => "session-a" },
		getContextUsage: () => ({ tokens: 42_000, contextWindow: 100_000, percent: 42 }),
		waitForIdle: async () => {},
		ui: {
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			notify() {},
			async confirm() { confirms += 1; return true; },
		},
	} as any;
	const priorRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { workModeExtension(pi); } finally {
		if (priorRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRole;
	}
	return { handlers, commands, appended, statuses, ctx, active: () => active, branch: (value: any[]) => { branch = value; }, confirms: () => confirms };
}

function custom(data: unknown) {
	return { type: "custom", customType: WORK_MODE_ENTRY_TYPE, data };
}

test("mode transitions stage workflow schemas, persist privately, and gate stale calls", async () => {
	resetInteractiveFooterRegistryForTests();
	const testHarness = harness();
	const { handlers, ctx } = testHarness;
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	assert.equal(currentWorkMode(), "orchestrator");
	const prompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
	assert.match(prompt.systemPrompt, /# PiBox Orchestrator Mode/);
	assert.deepEqual(testHarness.active(), ["read", "subagent_spawn", "unrelated"]);
	assert.equal(testHarness.appended.length, 0, "default startup adds no entry or model message");
	await testHarness.commands.get("mode")?.("workflow", ctx);
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => testHarness.active().includes(name)));
	await testHarness.commands.get("mode")?.("agent", ctx);
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => !testHarness.active().includes(name)), "pre-exposure workflow schemas remain removable");
	assert.equal(testHarness.confirms(), 0, "pre-request browsing has no cache warning");

	await handlers.get("before_provider_request")?.({}, ctx);
	assert.equal(testHarness.appended.at(-1)?.data.providerMode, "agent");
	const item = getInteractiveFooterItem("work-mode");
	assert.ok(item);
	const dialog = await item!.dialog(ctx);
	assert.equal(dialog.kind, "choice");
	if (dialog.kind !== "choice") throw new Error("expected choice dialog");
	assert.deepEqual(dialog.choices.map((choice) => choice.label), ["Agent", "Orchestrator", "Workflow", "Designer"]);
	assert.equal(currentWorkMode(), "agent", "opening and previewing do not mutate mode");
	const warning = dialog.notice?.("workflow");
	assert.equal(warning?.tone, "warning");
	assert.match(warning?.text ?? "", /may cause a large prompt-cache miss[\s\S]+context is approximately 42k tokens[\s\S]+logical conversation is preserved/i);
	await dialog.confirm("workflow", new AbortController().signal);
	assert.equal(currentWorkMode(), "workflow");
	assert.deepEqual(testHarness.active(), ["read", "subagent_spawn", "unrelated", ...WORKFLOW_TOOL_NAMES]);

	await handlers.get("before_provider_request")?.({}, ctx);
	assert.equal(testHarness.appended.at(-1)?.data.workflowToolsExposed, true);
	await testHarness.commands.get("mode")?.("agent", ctx);
	assert.equal(currentWorkMode(), "agent");
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => testHarness.active().includes(name)), "exposed schemas remain resident");
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "workflow_status" }, ctx), {
		block: true,
		reason: "PiBox Workflow mode is required. Select the Workflow icon in the interactive footer, then retry.",
	});
	assert.equal(await handlers.get("tool_call")?.({ toolName: "read" }, ctx), undefined);
	const context = await handlers.get("context")?.({ messages: [
		{ role: "custom", customType: "pibox-work-mode-context", content: "stale workflow authority" },
		{ role: "user", content: "continue" },
	] }, ctx) as { messages: any[] };
	assert.equal(context.messages.filter((message) => message.customType === "pibox-work-mode-context").length, 1);
	assert.match(context.messages.find((message) => message.customType === "pibox-work-mode-context").content, /mode: Agent/);
	await handlers.get("session_shutdown")?.({}, ctx);
	resetInteractiveFooterRegistryForTests();
});

test("new defaults preserve explicit Agent choices and startup overrides", async () => {
	resetInteractiveFooterRegistryForTests();
	const savedAgent = custom({ schemaVersion: 1, mode: "agent", workflowToolsExposed: false, providerMode: "agent" });
	for (const reason of ["resume", "reload", "fork"]) {
		const restored = harness([savedAgent]);
		await restored.handlers.get("session_start")?.({ reason }, restored.ctx);
		assert.equal(currentWorkMode(), "agent", reason);
		assert.equal(await restored.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, restored.ctx), undefined);
		await restored.handlers.get("session_shutdown")?.({}, restored.ctx);
	}
	const explicit = harness([], { "work-mode": "agent" });
	await explicit.handlers.get("session_start")?.({ reason: "startup" }, explicit.ctx);
	assert.equal(currentWorkMode(), "agent");
	assert.equal(explicit.appended.at(-1)?.data.mode, "agent");
	await explicit.handlers.get("session_shutdown")?.({}, explicit.ctx);

	// A startup override does not carry into a new session with no saved selection.
	await explicit.handlers.get("session_start")?.({ reason: "new" }, explicit.ctx);
	assert.equal(currentWorkMode(), "orchestrator");
	assert.equal(getInteractiveFooterItem("work-mode")!.status().marker, "󰏿");
	await explicit.handlers.get("before_provider_request")?.({}, explicit.ctx);
	assert.equal(explicit.appended.at(-1)?.data.providerMode, "orchestrator");
	await explicit.handlers.get("session_shutdown")?.({}, explicit.ctx);
	assert.equal(currentWorkMode(), "orchestrator", "unbound helpers use the same default");
	resetInteractiveFooterRegistryForTests();
});

test("branch restoration, mode prompts, startup aliases, and cache impact stay exact", async () => {
	resetInteractiveFooterRegistryForTests();
	const saved = { schemaVersion: 1, mode: "designer", workflowToolsExposed: true, providerMode: "workflow" };
	const testHarness = harness([custom(saved)]);
	const { handlers, ctx } = testHarness;
	await handlers.get("session_start")?.({ reason: "resume" }, ctx);
	assert.equal(currentWorkMode(), "designer");
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => testHarness.active().includes(name)));

	testHarness.branch([custom({ ...saved, mode: "orchestrator", providerMode: "agent", workflowToolsExposed: false })]);
	await handlers.get("session_tree")?.({}, ctx);
	assert.equal(currentWorkMode(), "orchestrator");
	const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
	assert.match(result.systemPrompt, /^base[\s\S]+# PiBox Orchestrator Mode[\s\S]+plan\.md[\s\S]+ledger\.md/);
	assert.match(result.systemPrompt, /present a concise plan in your response, and wait for approval before substantial execution/);
	assert.match(result.systemPrompt, /Actively use session scratch as a flexible memo board and workbench/);
	assert.match(result.systemPrompt, /`plan\.md` as a step-by-step checklist that guides delivery of the agreed goal, not paperwork/);
	assert.match(result.systemPrompt, /dependencies, and completion checks[\s\S]+sequentially[\s\S]+independent implementation work suitable for parallel subagents/);
	assert.match(result.systemPrompt, /`ledger\.md` as a concise rolling record of execution context[\s\S]+without repeating prior investigation/);
	assert.match(result.systemPrompt, /meaningful progress[\s\S]+approaches tried or ruled out[\s\S]+not merely a list of completed actions/);
	assert.match(result.systemPrompt, /`scripts\/` and `results\/`[\s\S]+starting points, not limits/);
	assert.match(result.systemPrompt, /logical boundaries using judgment, preserving anything that may still help/);
	assert.doesNotMatch(result.systemPrompt, /detailed, step-by-step checklist|Before context compaction|Replace the active plan when|Retain a note only if/);
	assert.deepEqual(modeTransitionImpact({ schemaVersion: 1, mode: "agent", providerMode: "agent", workflowToolsExposed: false }, "workflow"), {
		changesSystemPrompt: false,
		changesToolDefinitions: true,
		mayMissPromptCache: true,
	});
	assert.equal(modeTransitionImpact({ schemaVersion: 1, mode: "agent", workflowToolsExposed: false }, "designer").mayMissPromptCache, false);
	await handlers.get("session_shutdown")?.({}, ctx);

	const legacy = harness([{ type: "message", message: { role: "assistant", content: "prior answer" } }]);
	await legacy.handlers.get("session_start")?.({ reason: "resume" }, legacy.ctx);
	const legacyDialog = await getInteractiveFooterItem("work-mode")!.dialog(legacy.ctx);
	assert.equal(legacyDialog.kind, "choice");
	if (legacyDialog.kind !== "choice") throw new Error("expected choice dialog");
	assert.equal(currentWorkMode(), "orchestrator", "legacy sessions without a saved mode use the new default");
	assert.equal(legacyDialog.notice?.("agent"), undefined, "legacy provider history still conservatively infers the old Agent prefix");
	assert.equal(legacyDialog.notice?.("designer")?.tone, "warning");
	await legacy.handlers.get("session_shutdown")?.({}, legacy.ctx);

	const startup = harness([], { profile: "designer" });
	await startup.handlers.get("session_start")?.({ reason: "startup" }, startup.ctx);
	assert.equal(currentWorkMode(), "designer");
	assert.equal(startup.appended.length, 1, "an explicit compatibility alias is persisted once");
	await startup.handlers.get("session_shutdown")?.({}, startup.ctx);

	const unavailable = harness([custom(saved)], {}, ["read", ...WORKFLOW_TOOL_NAMES]);
	await unavailable.handlers.get("session_start")?.({ reason: "resume" }, unavailable.ctx);
	assert.equal(currentWorkMode(), "agent", "restored Designer mode fails closed when its required tool is inactive");
	assert.equal(unavailable.appended.at(-1)?.data.mode, "agent");
	await unavailable.handlers.get("session_shutdown")?.({}, unavailable.ctx);
	resetInteractiveFooterRegistryForTests();
});
