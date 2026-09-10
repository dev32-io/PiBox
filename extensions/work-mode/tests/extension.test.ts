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
	// Text contract guards only: these do not prove live model behavior.
	const prompt = result.systemPrompt;
	// Research precedes plan approval; approval is not permission bypass.
	assert.match(prompt, /Before substantial delivery planning, identify unknowns/);
	assert.match(prompt, /exploration, research, and investigation early, not after completing the broad investigation yourself/);
	assert.match(prompt, /Pre-approval delegation is read-only research or critique, not implementation/);
	assert.match(prompt, /Before drafting or presenting the delivery plan, collect, review, and reconcile delegated findings that could affect it/);
	assert.match(prompt, /While these are pending[^\n]+do not present a plan for approval/);
	assert.match(prompt, /Distinguish facts from assumptions and resolve material decision blockers with the user/);
	assert.match(prompt, /draft in scratch `plan\.md`, then present it for discussion and explicit approval/);
	assert.match(prompt, /Revise the same plan during discussion\. Wait for approval before implementation or delegating implementation/);
	assert.match(prompt, /a plan request is not approval, and approval does not bypass tool permissions/);

	// The approved plan remains a live control loop, not a one-time proposal.
	assert.match(prompt, /Record Goal, Deliverable, verifiable Done criteria/);
	assert.match(prompt, /concise step-by-step Markdown checklist \(`- \[ \]` \/ `- \[x\]`\)/);
	assert.match(prompt, /next action, dependencies, completion checks, sequential versus independent work, and remaining assumptions/);
	assert.match(prompt, /After approval, keep working within the agreed scope without waiting for routine user prompts/);
	assert.match(prompt, /Track the current step; mark each item `\[x\]` as soon as its checks pass/);
	assert.match(prompt, /Keep unfinished or blocked work unchecked; reconcile the checklist before reporting progress or completion/);
	assert.match(prompt, /Iterate investigation, delegation, implementation, and verification until Done criteria are met/);
	assert.match(prompt, /Pause only for a genuine blocker, required approval, or a material decision reserved for the user; record what remains and the input needed/);
	assert.match(prompt, /Routine iteration needs no renewed approval; material changes to the agreed plan do/);

	// Default delegation, direct-work exceptions, and explicit handoff ownership.
	assert.match(prompt, /Use ad hoc `subagent_spawn` by default for substantial, separable research, implementation after approval, and independent review/);
	assert.match(prompt, /Handle clear, local, reversible work directly when delegation and planning would add disproportionate overhead/);
	assert.match(prompt, /Work directly for trivial operations, tightly coupled steps, or when delegation is unavailable or adds more coordination than value/);
	assert.match(prompt, /Briefly state the concrete reason if keeping substantial work entirely local/);
	assert.match(prompt, /narrowest agent whose stated contract covers the assignment[^\n]+exact configured name; use `general-purpose` when no specialist fits/);
	assert.match(prompt, /self-contained objective, relevant context and paths, constraints, read-only or edit authority, owned outputs, dependencies, expected result and proof, and a stop condition/);
	assert.match(prompt, /Keep `plan\.md` and `ledger\.md` parent-owned\. Children do not orchestrate recursively/);
	assert.match(prompt, /Review is not approval\. Integrate and verify the assembled outcome yourself/);
	assert.match(prompt, /Use the configured agent's default tier; normally omit `tier`/);
	assert.match(prompt, /reserve upward overrides for complex architecture\/design or unusually demanding reasoning, with a brief task-specific justification/);
	assert.doesNotMatch(prompt, /Prefer Low|prefer High when unsure|normal ceiling/);

	// Safe asynchronous work and recovery from incomplete assignments.
	assert.match(prompt, /Use foreground for a prerequisite needed next and background for independent assignments/);
	assert.match(prompt, /Run independent work concurrently within harness limits; do non-overlapping work while children run, not their assignment again/);
	assert.match(prompt, /Parallel edits require disjoint file ownership and compatible interfaces; sequence shared-file work and resolve newly discovered conflicts before continuing\. Preserve existing user work/);
	assert.match(prompt, /Background results arrive automatically\. End the turn if no useful independent work remains, or use `wait` with `event: subagent_settled` at a genuine dependency barrier/);
	assert.match(prompt, /A wake-up does not mean every prerequisite finished/);
	assert.match(prompt, /Never sleep or poll for completion; `subagent_status` is diagnostic only/);
	assert.match(prompt, /Use `subagent_read` for truncated reports; reserve `subagent_continue` for new follow-up work/);
	assert.match(prompt, /Treat failed, blocked, or partial results as incomplete/);
	assert.match(prompt, /Before reassigning work, confirm the prior attempt has settled and inspect its evidence and any edits; assign only the remaining gap or surface the blocker/);
	assert.match(prompt, /Review decisive evidence before relying on results; resolve disagreements against repository facts and checks, not votes/);

	// Flexible scratch retains the existing continuity and authority boundaries.
	assert.match(prompt, /Actively use session scratch as a flexible memo board and workbench/);
	assert.match(prompt, /`plan\.md` focused on the current goal, not an accumulation of projects/);
	assert.match(prompt, /`ledger\.md` for useful facts, decisions and rationale, evidence pointers, delegated findings, ruled-out approaches, and unresolved issues: context, not a chronological log/);
	assert.match(prompt, /`scripts\/` and `results\/`; these are starting points, not limits/);
	assert.match(prompt, /At goal changes and completion, consolidate notes and remove obsolete detail using judgment/);
	assert.match(prompt, /Retain useful pointers without forced archives, hard caps, or automatic deletion/);
	assert.match(prompt, /After compaction or resume, consult relevant notes; current user direction, repository evidence, and reviewed contracts outrank scratch/);
	assert.match(prompt, /Scratch is private, temporary, non-authoritative `\/tmp` state; keep secrets out of it/);
	assert.match(prompt, /Do not invoke Workflow resource or execution tools in Orchestrator mode/);
	assert.doesNotMatch(prompt, /detailed, step-by-step checklist|Before context compaction|Retain a note only if/);
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
