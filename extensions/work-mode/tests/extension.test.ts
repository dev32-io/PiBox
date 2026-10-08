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
		on(name: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(name);
			handlers.set(name, async (event, ctx) => {
				const result = await previous?.(event, ctx);
				const next = name === "context" && result?.messages ? { ...event, messages: result.messages }
					: name === "before_provider_request" && result ? { ...event, payload: result }
						: name === "before_agent_start" && result?.systemPrompt ? { ...event, systemPrompt: result.systemPrompt } : event;
				return await handler(next, ctx) ?? result;
			});
		},
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

test("child runtime registers no parent mode system contribution", () => {
	let registrations = 0;
	const priorRole = process.env.PIBOX_RUNTIME_ROLE;
	process.env.PIBOX_RUNTIME_ROLE = "subagent";
	try {
		workModeExtension({ on() { registrations++; } } as unknown as ExtensionAPI);
	} finally {
		if (priorRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRole;
	}
	assert.equal(registrations, 0);
});

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
	assert.match(warning?.text ?? "", /Each mode has distinct system authority; scratch presence or state/);
	assert.match(warning?.text ?? "", /may cause a large prompt-cache miss[\s\S]+context is approximately 42k tokens[\s\S]+logical conversation is preserved/i);
	await dialog.confirm("workflow", new AbortController().signal);
	assert.equal(currentWorkMode(), "workflow");
	assert.deepEqual(testHarness.active(), ["read", "subagent_spawn", "unrelated", ...WORKFLOW_TOOL_NAMES]);
	const workflowPrompt = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
	assert.match(workflowPrompt.systemPrompt, /\[PiBox mode: Workflow\]/);

	await handlers.get("before_provider_request")?.({}, ctx);
	assert.equal(testHarness.appended.at(-1)?.data.workflowToolsExposed, true);
	await testHarness.commands.get("mode")?.("agent", ctx);
	assert.equal(currentWorkMode(), "agent");
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => !testHarness.active().includes(name)), "workflow schemas are removed even after provider exposure");
	const agentPrompt = await handlers.get("before_agent_start")?.({ systemPrompt: workflowPrompt.systemPrompt }, ctx) as { systemPrompt: string };
	assert.match(agentPrompt.systemPrompt, /\[PiBox mode: Agent\]/);
	assert.doesNotMatch(agentPrompt.systemPrompt, /PiBox mode: Workflow/);
	assert.equal(modeTransitionImpact({ schemaVersion: 1, mode: "workflow", providerMode: "workflow", workflowToolsExposed: true }, "agent").changesSystemPrompt, true);
	assert.deepEqual(await handlers.get("tool_call")?.({ toolName: "workflow_status" }, ctx), {
		block: true,
		reason: "PiBox Workflow mode is required. Select the Workflow icon in the interactive footer, then retry.",
	});
	assert.equal(await handlers.get("tool_call")?.({ toolName: "read" }, ctx), undefined);
	const context = await handlers.get("context")?.({ messages: [{ role: "user", content: "continue" }] }, ctx) as { messages: any[] };
	const markers = context.messages.filter((message) => message.customType === "pibox-system-prompt-request");
	assert.equal(markers.length, 1);
	assert.match(markers[0].content, /^pibox-request-/);
	assert.doesNotMatch(markers[0].content, /mode: Agent/);
	assert.equal(context.messages.some((message) => message.customType === "pibox-work-mode-context"), false);
	const completion = { role: "custom", customType: "pibox-subagent-result", content: "completed" };
	const noUser = await handlers.get("context")?.({ messages: [{ role: "compactionSummary", summary: "Prior work" }, completion] }, ctx);
	assert.equal(noUser.messages[0].role, "compactionSummary");
	assert.equal(noUser.messages.filter((message: any) => message.customType !== "pibox-system-prompt-request").at(-1), completion);
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
		const prompt = await restored.handlers.get("before_agent_start")?.({ systemPrompt: "base" }, restored.ctx) as { systemPrompt: string };
		assert.match(prompt.systemPrompt, /\[PiBox mode: Agent\]/);
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
	assert.ok(WORKFLOW_TOOL_NAMES.every((name) => !testHarness.active().includes(name)), "legacy sticky exposure cannot override restored Designer mode");

	testHarness.branch([custom({ ...saved, mode: "orchestrator", providerMode: "agent", workflowToolsExposed: false })]);
	await handlers.get("session_tree")?.({}, ctx);
	assert.equal(currentWorkMode(), "orchestrator");
	const result = await handlers.get("before_agent_start")?.({ systemPrompt: "base" }, ctx) as { systemPrompt: string };
	assert.match(result.systemPrompt, /^base[\s\S]+# PiBox Orchestrator Mode/);
	const prompt = result.systemPrompt;
	assert.doesNotMatch(prompt, /\/tmp\/pibox-session-[0-9a-f]+/, "static mode prompt contains no workspace path");
	assert.deepEqual(modeTransitionImpact({ schemaVersion: 1, mode: "agent", providerMode: "agent", workflowToolsExposed: false }, "workflow"), {
		changesSystemPrompt: true,
		changesToolDefinitions: true,
		mayMissPromptCache: true,
	});
	assert.deepEqual(modeTransitionImpact({ schemaVersion: 1, mode: "workflow", providerMode: "workflow", workflowToolsExposed: true }, "agent"), {
		changesSystemPrompt: true,
		changesToolDefinitions: true,
		mayMissPromptCache: true,
	});
	assert.equal(modeTransitionImpact({ schemaVersion: 1, mode: "agent", providerMode: "agent", workflowToolsExposed: true }, "workflow").changesToolDefinitions, true, "legacy exposure does not hide readdition impact");
	assert.equal(modeTransitionImpact({ schemaVersion: 1, mode: "agent", providerMode: "agent", workflowToolsExposed: true }, "designer").changesToolDefinitions, false);
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

test("every mode has one stable system declaration and no synthetic user advisory", async () => {
	const { handlers, commands, ctx } = harness();
	ctx.model = { api: "openai-completions" };
	await handlers.get("session_start")?.({ reason: "startup" }, ctx);
	try {
		const systems = new Set<string>();
		for (const mode of ["agent", "workflow", "designer", "orchestrator", "agent"]) {
			await commands.get("mode")?.(mode, ctx);
			const bodies = [];
			for (let turn = 0; turn < 2; turn++) {
				const { systemPrompt } = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx);
				const original = [{ role: "user", content: "First real request" }];
				if (turn) original.push({ role: "assistant", content: "done" }, { role: "user", content: "Second request" });
				const { messages } = await handlers.get("context")?.({ messages: original }, ctx);
				const body = await handlers.get("before_provider_request")?.({ payload: { messages: [
					{ role: "system", content: systemPrompt },
					...messages.map((message: any) => ({ role: message.role === "custom" ? "user" : message.role, content: message.content })),
				] } }, ctx);
				assert.deepEqual(body.messages.slice(1), original);
				assert.equal(body.messages[0].content.match(/\[PiBox mode:/g)?.length, 1);
				bodies.push(body.messages[0].content);
			}
			assert.equal(bodies[0], bodies[1]);
			systems.add(bodies[0]);
		}
		assert.equal(systems.size, 4, "returning to Agent restores exactly the same authority");
	} finally {
		await handlers.get("session_shutdown")?.({}, ctx);
		resetInteractiveFooterRegistryForTests();
	}
});

test("workflow readdition preserves initial tool allowlist", async () => {
	const h = harness([], {}, ["read", "workflow_status"]);
	await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
	try {
		assert.deepEqual(h.active(), ["read"]);
		await h.commands.get("mode")?.("workflow", h.ctx);
		assert.deepEqual(h.active(), ["read", "workflow_status"]);
		await h.handlers.get("before_provider_request")?.({}, h.ctx);
		await h.commands.get("mode")?.("agent", h.ctx);
		assert.deepEqual(h.active(), ["read"]);
		await h.handlers.get("before_provider_request")?.({}, h.ctx);
		assert.equal(h.appended.at(-1)?.data.workflowToolsExposed, false);
		await h.commands.get("mode")?.("workflow", h.ctx);
		assert.deepEqual(h.active(), ["read", "workflow_status"]);
	} finally { await h.handlers.get("session_shutdown")?.({}, h.ctx); }
});
