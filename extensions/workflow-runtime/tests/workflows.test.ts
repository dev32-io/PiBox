import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPermissionRuntime } from "../../permissions/runtime.js";
import { getSubagentUiProjectionRegistry } from "../../subagent/ui-projection.js";
import { emptyWorkflowMetrics, type StoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { WorkflowAdapter } from "../api.js";
import { getWorkflowAdapterCapabilityRegistry, registerWorkflowAdapter } from "../capability-registry.js";
import workflows from "../index.js";

function state(status: StoryRuntimeState["status"] = "ready", storyId = "example"): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId,
		status,
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: { "task-a": `sha256:${"c".repeat(64)}` } },
		git: { canonicalBranch: "feature/example", baseCommit: "abc" },
		stages: [{
			id: "delivery",
			status: status === "completed" ? "completed" : status === "running" ? "running" : "pending",
			tasks: [{ id: "task-a", status: status === "completed" ? "completed" : status === "running" ? "implementing" : "pending", repairCount: 0, checks: [] }],
			integration: { status: status === "completed" ? "completed" : "pending", repairCount: 0, contributionCommits: [] },
			verification: { status: status === "completed" ? "completed" : "pending", repairCount: 0, checks: [] },
			review: { status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] },
		}],
		finalReview: { status: status === "completed" ? "completed" : "pending", iteration: 0, repairCount: 0, currentFindings: [] },
		e2e: { status: status === "completed" ? "completed" : "pending", repairCount: 0, evidenceRefs: [] },
		metrics: emptyWorkflowMetrics(),
	};
}

function fixture(confirmed: boolean, options: { initialMode?: "enforce" | "bypass"; criticalConfirmed?: boolean } = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const subagentUi = getSubagentUiProjectionRegistry();
	subagentUi.clear();
	let dashboard: { render(width: number): string[] } | undefined;
	let dashboardRenderRequests = 0;
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerMessageRenderer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: { on() {}, emit() {} },
		sendMessage() {},
	} as unknown as ExtensionAPI;
	getWorkflowAdapterCapabilityRegistry().clear();
	const runtimeRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { workflows(pi); } finally { if (runtimeRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE; else process.env.PIBOX_RUNTIME_ROLE = runtimeRole; }
	let mode: "enforce" | "bypass" = options.initialMode ?? "enforce";
	let confirmations = 0;
	let criticalConfirmations = 0;
	installPermissionRuntime({
		getMode: () => mode,
		setMode: (next) => { mode = next; },
		confirmWorkflowStart: async () => { confirmations++; return confirmed; },
		confirmCriticalRisk: async () => { criticalConfirmations++; return options.criticalConfirmed ?? confirmed; },
	});
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_tone: string, text: string) => text, bg: (_tone: string, text: string) => text, bold: (text: string) => text },
			setWidget(id: string, factory: unknown) {
				if (id !== "pibox-workflow") return;
				if (typeof factory !== "function") { dashboard = undefined; return; }
				dashboard = (factory as (tui: { requestRender(): void }) => { render(width: number): string[] })({ requestRender() { dashboardRenderRequests++; } });
			},
			setStatus() {},
		},
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
	};
	return {
		tools, handlers, ctx, subagentUi,
		dashboardLines: (width = 100) => dashboard?.render(width) ?? [],
		dashboardRenderRequests: () => dashboardRenderRequests,
		mode: () => mode, confirmations: () => confirmations, criticalConfirmations: () => criticalConfirmations,
	};
}

function register(adapter: WorkflowAdapter): void {
	registerWorkflowAdapter(adapter, { replace: true });
}

test("permission cancellation occurs after pure validation and before state ownership or child scheduling", { concurrency: false }, async () => {
	const f = fixture(false);
	assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control"]);
	let snapshots = 0; let controls = 0; let advances = 0; let domain = 0;
	register({
		id: "test", canHandle: (ref) => ref === "test:example",
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { snapshots++; return { ref, title: "Example", status: "ready", runtime: state() }; },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() { advances++; },
		async prepareWorkflow() { domain++; },
		async controlWorkflow() { domain++; },
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	const result = await f.tools.get("workflow_start").execute("call", { ref: "test:example" }, undefined, undefined, f.ctx);
	assert.equal(snapshots, 1, "topology/state validation is pure and precedes confirmation");
	assert.equal(f.confirmations(), 1);
	assert.equal(f.mode(), "enforce");
	assert.equal(controls, 0);
	assert.equal(advances, 0);
	assert.equal(domain, 0);
	assert.match(result.content[0].text, /cancelled/i);
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("preflight failure occurs before permission confirmation and ownership", { concurrency: false }, async () => {
	const f = fixture(true);
	let controls = 0;
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: false, detail: "Missing required command." }; },
		async snapshot(ref) { return { ref, title: "Example", status: "ready", runtime: state() }; },
		async advanceWorkflow() {},
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	const result = await f.tools.get("workflow_start").execute("call", { ref: "test:example" }, undefined, undefined, f.ctx);
	assert.match(result.content[0].text, /Missing required command/);
	assert.equal(f.confirmations(), 0);
	assert.equal(f.mode(), "enforce");
	assert.equal(controls, 0);
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("production runner uses stage-machine advancement, enters bypass before ownership, and quit does not detach", { concurrency: false }, async () => {
	const f = fixture(true);
	const order: string[] = [];
	let current = state();
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { order.push(`preflight:${f.mode()}`); return { ok: true }; },
		async snapshot(ref) { order.push(`snapshot:${f.mode()}`); return { ref, title: "Example", status: current.status === "completed" ? "done" : current.status === "running" ? "running" : "ready", runtime: structuredClone(current) }; },
		async controlExecution(ref, command) {
			order.push(`${command}:${f.mode()}`);
			if (command === "start") current = state("running");
			if (command === "complete") current = state("completed");
			return { workflowRef: ref, mode: command === "complete" ? "completed" : "running" };
		},
		async advanceWorkflow() { order.push(`advance:${f.mode()}`); current = state("completed"); },
		async prepareWorkflow() { order.push(`prepare:${f.mode()}`); },
		async completionPrompt() { return "complete"; },
		async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:example" }, undefined, undefined, f.ctx);
	assert.equal(f.mode(), "bypass");
	assert.deepEqual(order.slice(0, 4), ["preflight:enforce", "snapshot:enforce", "start:bypass", "prepare:bypass"]);
	assert.ok(order.includes("advance:bypass"));
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
	assert.equal(order.some((entry) => entry.startsWith("detach:")), false, "quit has crash semantics and does not manufacture settlement");
});

test("workflow_start returns after its initial pass while later lifecycle work remains background", { concurrency: false }, async () => {
	const f = fixture(true, { initialMode: "bypass" });
	let current = state();
	let advances = 0;
	let lifecycleListener: (() => void) | undefined;
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: current.status === "running" ? "running" : "ready", runtime: structuredClone(current) }; },
		async controlExecution(ref, command) {
			if (command === "start") current = state("running");
			return { workflowRef: ref, mode: "running" };
		},
		async advanceWorkflow() {
			advances++;
			if (advances === 1) { lifecycleListener?.(); return; }
			await new Promise<void>(() => undefined);
		},
		async prepareWorkflow() {}, async controlWorkflow() {},
		subscribeLifecycle(_ref, _ctx, listener) { lifecycleListener = listener; return () => { lifecycleListener = undefined; }; },
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	let timeout: NodeJS.Timeout | undefined;
	const result = await Promise.race([
		f.tools.get("workflow_start").execute("bounded-start", { ref: "test:example" }, undefined, undefined, f.ctx),
		new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("workflow_start waited for a later lifecycle pass")), 500); }),
	]).finally(() => { if (timeout) clearTimeout(timeout); });
	assert.match(result.content[0].text, /Started target workflow/);
	assert.equal((result as any).details?.runtime?.stages[0]?.tasks[0]?.status, "implementing");
	assert.ok(advances >= 1);
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("workflow widget subscribes to relevant shared child projections and discloses live slot progress", { concurrency: false }, async () => {
	const f = fixture(true, { initialMode: "bypass" });
	let current = state();
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: current.status === "running" ? "running" : "ready", runtime: structuredClone(current), stageTopology: [{ id: "delivery", mode: "concurrent" }] }; },
		async controlExecution(ref, command) { if (command === "start") current = state("running"); return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() {}, async prepareWorkflow() {}, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	await f.tools.get("workflow_start").execute("live-widget", { ref: "test:example" }, undefined, undefined, f.ctx);

	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const binding = f.subagentUi.bind(owner, "workflow-widget-events");
	const standalone = {
		agentId: "standalone", agent: "general-purpose", state: "running" as const, presentation: "background" as const,
		provider: "openai", model: "gpt", effort: "medium", fast: false,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
	};
	const beforeStandalone = f.dashboardRenderRequests();
	binding.publish([standalone]);
	assert.equal(f.dashboardRenderRequests(), beforeStandalone, "standalone footer activity does not invalidate the workflow widget");

	binding.publish([standalone, {
		agentId: "workflow-task", agent: "implementer", state: "running", presentation: "background",
		provider: "openai", model: "gpt", effort: "high", tier: "medium", fast: false,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:02.000Z",
		progress: { startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:00.100Z", lastEventAt: "2026-01-01T00:00:02.000Z", turns: 1, toolCalls: 1, toolErrors: 0, inputTokens: 10, outputTokens: 20, reasoningTokens: 0, activeTool: "read" },
		workflow: { storyId: "example", slotId: "task:task-a", action: "task-launch", taskId: "task-a" },
	}]);
	assert.ok(f.dashboardRenderRequests() > beforeStandalone, "workflow child projection requests an event-driven render");
	const lines = f.dashboardLines(120);
	assert.ok(lines.some((line) => line.includes("⇉ Stage 1 · delivery")));
	assert.ok(lines.some((line) => /implementer · Medium \(openai\/gpt#high\) · 1 turn · 1 tool/.test(line)));
	assert.equal(lines.some((line) => line.includes("general-purpose")), false);

	binding.release();
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("single widget renders every running or paused runner and every story child exactly once", { concurrency: false }, async () => {
	const f = fixture(true, { initialMode: "bypass" });
	const states = new Map<string, StoryRuntimeState>([
		["test:alpha", state("ready", "alpha")],
		["test:beta", state("ready", "beta")],
	]);
	register({
		id: "test", canHandle: (ref) => states.has(ref),
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) {
			const runtime = states.get(ref)!;
			return { ref, title: runtime.storyId === "alpha" ? "Alpha workflow" : "Beta workflow", status: runtime.status === "running" ? "running" : "ready", runtime: structuredClone(runtime), stageTopology: [{ id: "delivery", mode: "sequential" }] };
		},
		async controlExecution(ref, command) {
			if (command === "start") states.set(ref, state("running", states.get(ref)!.storyId));
			return { workflowRef: ref, mode: command === "pause" ? "paused" : command === "stop" ? "stopped" : "running" };
		},
		async advanceWorkflow() {}, async prepareWorkflow() {}, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	await f.tools.get("workflow_start").execute("alpha-start", { ref: "test:alpha" }, undefined, undefined, f.ctx);
	await f.tools.get("workflow_control").execute("alpha-pause", { ref: "test:alpha", action: "pause" }, undefined, undefined, f.ctx);
	await f.tools.get("workflow_start").execute("beta-start", { ref: "test:beta" }, undefined, undefined, f.ctx);

	const binding = f.subagentUi.bind({ sessionId: "session", processInstanceId: "process", activationId: "activation" }, "all-workflow-widget-events");
	binding.publish([{
		agentId: "alpha-child", agent: "implementer", state: "running", presentation: "background",
		provider: "openai", model: "alpha-model", effort: "high", fast: false,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
		workflow: { storyId: "alpha", slotId: "task:task-a", action: "task-launch", taskId: "task-a" },
	}, {
		agentId: "beta-child", agent: "implementer", state: "running", presentation: "background",
		provider: "openai", model: "beta-model", effort: "high", fast: false,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
		workflow: { storyId: "beta", slotId: "task:task-a", action: "task-launch", taskId: "task-a" },
	}]);
	const lines = f.dashboardLines(120);
	assert.equal(lines.filter((line) => line.includes("Workflow · Alpha workflow")).length, 1);
	assert.equal(lines.filter((line) => line.includes("Workflow · Beta workflow")).length, 1);
	assert.equal(lines.filter((line) => line.includes("openai/alpha-model")).length, 1, "paused non-selected workflow child remains visible once");
	assert.equal(lines.filter((line) => line.includes("openai/beta-model")).length, 1);

	await f.tools.get("workflow_control").execute("alpha-stop", { ref: "test:alpha", action: "stop" }, undefined, undefined, f.ctx);
	assert.equal(f.dashboardLines(120).some((line) => line.includes("Alpha workflow")), false);
	await f.tools.get("workflow_control").execute("beta-stop", { ref: "test:beta", action: "stop" }, undefined, undefined, f.ctx);
	assert.deepEqual(f.dashboardLines(120), [], "removing the final runner clears the widget");
	const renderRequestsAfterRemoval = f.dashboardRenderRequests();
	binding.publish([]);
	assert.equal(f.dashboardRenderRequests(), renderRequestsAfterRemoval, "removed widget retains no child-projection render state");

	binding.release();
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("attention resolution cancellation validates before confirmation and leaves state untouched", { concurrency: false }, async () => {
	const f = fixture(false);
	let dryRuns = 0; let commits = 0; let controls = 0;
	const attention = state("attention");
	attention.attention = { code: "critical", summary: "risk decision required" };
	attention.finalReview = { status: "attention", iteration: 1, repairCount: 0, currentFindings: [{ id: "risk", severity: "critical", code: "security", summary: "security risk" }] };
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: "attention", runtime: structuredClone(attention) }; },
		async resolveAttention(_ref, _decision, _ctx, options) { if (options?.dryRun) dryRuns++; else commits++; return structuredClone(attention); },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() {}, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	const result = await f.tools.get("workflow_control").execute("attention-resolution", { ref: "test:example", action: "approve", acceptedRisks: [{ findingId: "risk", rationale: "accepted by user" }] }, undefined, undefined, f.ctx);
	assert.match(result.content[0].text, /cancelled/i);
	assert.equal(dryRuns, 1);
	assert.equal(commits, 0);
	assert.equal(controls, 0);
	assert.equal(f.mode(), "enforce");
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("Critical approval requires explicit user confirmation even when permission mode is already bypass", { concurrency: false }, async () => {
	const f = fixture(true, { initialMode: "bypass", criticalConfirmed: false });
	let dryRuns = 0; let commits = 0; let controls = 0; let advances = 0; let preflights = 0;
	const attention = state("attention");
	attention.attention = { code: "critical", summary: "risk decision required" };
	attention.finalReview = { status: "attention", iteration: 1, repairCount: 0, currentFindings: [{ id: "critical-risk", severity: "critical", code: "security", summary: "security risk" }] };
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { preflights++; return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: "attention", runtime: structuredClone(attention) }; },
		async resolveAttention(_ref, _decision, _ctx, options) { if (options?.dryRun) dryRuns++; else commits++; return structuredClone(attention); },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() { advances++; }, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	const result = await f.tools.get("workflow_control").execute("critical-approval", { ref: "test:example", action: "approve", acceptedRisks: [{ findingId: "critical-risk", rationale: "explicit rationale" }] }, undefined, undefined, f.ctx);
	assert.match(result.content[0].text, /Critical risk was not accepted/i);
	assert.equal(dryRuns, 1, "domain validation precedes the user-owned confirmation");
	assert.equal(f.criticalConfirmations(), 1);
	assert.equal(f.confirmations(), 0, "bypass confirmation is not a substitute for Critical-risk confirmation");
	assert.equal(commits, 0); assert.equal(controls, 0); assert.equal(advances, 0); assert.equal(preflights, 0);
	assert.equal(f.mode(), "bypass");
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("non-reload activation startup reconciles durable ownership without control or launch", { concurrency: false }, async () => {
	const f = fixture(true);
	let reconciliations = 0; let controls = 0; let advances = 0;
	register({
		id: "test", canHandle: () => true,
		async snapshot(ref) { return { ref, title: "Example", status: "paused", runtime: state("paused") }; },
		async reconcileActivation() { reconciliations++; },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() { advances++; }, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	assert.equal(reconciliations, 1); assert.equal(controls, 0); assert.equal(advances, 0);
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("plain resume refuses unresolved attention before permission confirmation", { concurrency: false }, async () => {
	const f = fixture(true);
	const attention = state("paused");
	attention.finalReview = { status: "attention", iteration: 1, repairCount: 0, currentFindings: [{ id: "risk", severity: "critical", code: "security", summary: "risk decision required" }] };
	let controls = 0;
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: "paused", runtime: structuredClone(attention) }; },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() {}, async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	await assert.rejects(f.tools.get("workflow_control").execute("resume", { ref: "test:example", action: "resume" }, undefined, undefined, f.ctx), /request_changes|approve/);
	assert.equal(f.confirmations(), 0);
	assert.equal(controls, 0);
	assert.equal(f.mode(), "enforce");
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("resume cancellation leaves the authoritative workflow untouched", { concurrency: false }, async () => {
	const f = fixture(false);
	let controls = 0; let advances = 0;
	register({
		id: "test", canHandle: () => true,
		async preflightWorkflow() { return { ok: true }; },
		async snapshot(ref) { return { ref, title: "Example", status: "paused", runtime: state("paused") }; },
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running" }; },
		async advanceWorkflow() { advances++; },
		async controlWorkflow() {},
	});
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	const result = await f.tools.get("workflow_control").execute("resume", { ref: "test:example", action: "resume" }, undefined, undefined, f.ctx);
	assert.match(result.content[0].text, /cancelled/i);
	assert.equal(controls, 0);
	assert.equal(advances, 0);
	assert.equal(f.mode(), "enforce");
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});
