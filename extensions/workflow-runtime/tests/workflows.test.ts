import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installPermissionRuntime } from "../../permissions/runtime.js";
import { emptyWorkflowMetrics, type StoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { WorkflowAdapter } from "../api.js";
import { getWorkflowAdapterCapabilityRegistry, registerWorkflowAdapter } from "../capability-registry.js";
import workflows from "../index.js";

function state(status: StoryRuntimeState["status"] = "ready"): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId: "example",
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
			setWidget() {}, setStatus() {},
		},
		sessionManager: { getSessionId: () => "session", getEntries: () => [] },
	};
	return { tools, handlers, ctx, mode: () => mode, confirmations: () => confirmations, criticalConfirmations: () => criticalConfirmations };
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
