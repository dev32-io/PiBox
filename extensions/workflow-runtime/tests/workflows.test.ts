import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows from "../index.js";
import { WORKFLOW_LIFECYCLE_EVENT, type WorkflowAdapter, type WorkflowLifecycleEvent, type WorkflowRunResult, type WorkflowSnapshot } from "../api.js";
import { getWorkflowAdapterCapabilityRegistry, registerWorkflowAdapter } from "../capability-registry.js";
import { installPermissionRuntime } from "../../permissions/runtime.js";
import { WorkflowRunner, type WorkflowRunnerCommand } from "../runner.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";

function registerTestAdapter(adapter: WorkflowAdapter): void {
	let generation = 0;
	adapter.controlExecution ??= async (ref, command) => ({
		workflowRef: ref,
		mode: command === "pause" || command === "detach" ? "paused" : command === "stop" ? "stopped" : command === "complete" ? "completed" : "running",
		generation: ++generation,
		ownerSessionId: "test-session",
	});
	registerWorkflowAdapter(adapter, { replace: true });
}

function fixture(workflowConfirmed = true, standaloneSubagents = false) {
	const tools = new Map<string, any>();
	if (standaloneSubagents) for (const name of ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"]) tools.set(name, { name, owner: "standalone" });
	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const messages: any[] = [];
	const entries: any[] = [];
	let widget: unknown;
	const statuses = new Map<string, string>();
	const statusWrites: Array<{ id: string; value: string | undefined }> = [];
	let activeTools: string[] = [];
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerMessageRenderer() {},
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: {
			on(name: string, handler: (data: unknown) => void) { const current = bus.get(name) ?? []; current.push(handler); bus.set(name, current); },
			emit(name: string, data: unknown) { for (const handler of bus.get(name) ?? []) handler(data); },
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
		getActiveTools() { return activeTools; }, setActiveTools(names: string[]) { activeTools = names; },
		getAllTools() { return [...tools.values()]; },
	} as unknown as ExtensionAPI;
	getWorkflowAdapterCapabilityRegistry().clear();
	workflows(pi);
	let permissionMode = "enforce";
	installPermissionRuntime({
		getMode: () => permissionMode as "enforce" | "bypass",
		setMode: (next) => { permissionMode = next; },
		confirmWorkflowStart: async () => workflowConfirmed,
	});
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text },
			setWidget(_id: string, value: unknown) { widget = value; },
			setStatus(id: string, value: string | undefined) {
				statusWrites.push({ id, value });
				if (value === undefined) statuses.delete(id); else statuses.set(id, value);
			},
		},
		sessionManager: { getEntries: () => entries, getSessionId: () => "test-session" },
	};
	return { pi, tools, handlers, messages, entries, ctx, statuses, statusWrites, widget: () => widget, permissionMode: () => permissionMode };
}

test("explicit standalone child role prevents workflow-runtime registration", { concurrency: false }, () => {
	const previousRole = process.env[PIBOX_RUNTIME_ROLE_ENV];
	const previousId = process.env.PIBOX_SUBAGENT_ID;
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
	delete process.env.PIBOX_SUBAGENT_ID;
	try {
		const f = fixture(true, true);
		assert.deepEqual([...f.tools.keys()], ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"]);
		assert.equal(f.handlers.size, 0);
	} finally {
		if (previousRole === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previousRole;
		if (previousId === undefined) delete process.env.PIBOX_SUBAGENT_ID; else process.env.PIBOX_SUBAGENT_ID = previousId;
	}
});

test("managed identity metadata alone keeps the workflow runtime on its main surface", { concurrency: false }, async () => {
	const previousRole = process.env[PIBOX_RUNTIME_ROLE_ENV];
	const previousId = process.env.PIBOX_SUBAGENT_ID;
	delete process.env[PIBOX_RUNTIME_ROLE_ENV];
	process.env.PIBOX_SUBAGENT_ID = "managed-identity-only";
	try {
		const f = fixture();
		assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control", "workflow_checkpoint"]);
		await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
		await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
	} finally {
		if (previousRole === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previousRole;
		if (previousId === undefined) delete process.env.PIBOX_SUBAGENT_ID; else process.env.PIBOX_SUBAGENT_ID = previousId;
	}
});

test("does not override standalone generic subagent tools", async () => {
	const f = fixture(true, true);
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	for (const name of ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"]) assert.equal(f.tools.get(name).owner, "standalone");
	assert.ok(f.tools.has("workflow_start"));
	await f.handlers.get("session_shutdown")?.({ reason: "quit" }, f.ctx);
});

test("registers only the workflow runtime surface", async () => {
	const f = fixture();
	await f.handlers.get("session_start")?.({}, f.ctx);
	assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control", "workflow_checkpoint"]);
	assert.match(f.tools.get("workflow_start").description, /user explicitly asks to run.*TUI confirmation.*permission bypass mode/i);
	assert.match(f.tools.get("workflow_control").description, /Stop terminates active attempts.*resume prepares incomplete stopped work/);
	for (const name of ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"]) {
		assert.equal(f.tools.has(name), false, `${name} belongs to the standalone subagent extension`);
	}
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("failed workflow start returns an error and leaves no dashboard", async () => {
	const f = fixture();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() { throw new Error("Workflow plan example has invalid execution topology."); },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await assert.rejects(f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx), /invalid execution topology/);
	assert.equal(f.widget(), undefined);
	assert.equal(f.entries.length, 0);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("workflow start requires extension-owned bypass confirmation before adapter preparation", async () => {
	const f = fixture(false);
	let prepared = false;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async prepareWorkflow() { prepared = true; },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	const outcome = await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	assert.equal(prepared, false);
	assert.equal(f.permissionMode(), "enforce");
	assert.match(outcome.content[0].text, /cancelled/i);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("a fresh activation ignores historical Pi workflow entries and receives no old runtime events", async () => {
	const f = fixture();
	f.entries.push({ type: "custom", customType: "pibox-workflow", data: { ref: "test:old", state: "running" } });
	let controls = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(ref) { controls++; return { workflowRef: ref, mode: "running", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return []; },
		async snapshot(ref) { return { ref, title: "Old", status: "running", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "startup" }, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(controls, 0);
	assert.equal(f.widget(), undefined);
	assert.equal(f.messages.length, 0);
	await f.handlers.get("session_shutdown")?.({ reason: "shutdown" }, f.ctx);
});

test("reload restore establishes durable ownership from execution controls before ticking", async () => {
	const f = fixture();
	const controls: string[] = [];
	let owned = false;
	let snapshots = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(_ref, command) { controls.push(command); owned = true; return { workflowRef: "test:workflow", mode: "running", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: "test:workflow", mode: "running", generation: 1 }]; },
		async snapshot(ref) { assert.equal(owned, true, "restore must establish a fence before its first snapshot/tick"); snapshots++; return { ref, title: "Restored", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	assert.deepEqual(controls, ["attach"]);
	assert.ok(snapshots > 0);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("late capability registration restores through the same durable runner attach path", async () => {
	const f = fixture();
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	let restored!: () => void;
	const attached = new Promise<void>((resolve) => { restored = resolve; });
	const adapter: WorkflowAdapter = {
		id: "late", canHandle: (ref) => ref.startsWith("late:"),
		async controlExecution(ref, command) { if (command === "attach") restored(); return { workflowRef: ref, mode: "running", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: "late:workflow", mode: "running", generation: 1 }]; },
		async snapshot(ref) { return { ref, title: "Late", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await attached;
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(f.widget(), "late registration rebinds the pending dashboard without history-based adapter discovery");
	await f.handlers.get("session_shutdown")?.({ reason: "reload" }, f.ctx);
});

test("resume domain preparation occurs only after a successful durable ownership fence", async () => {
	const f = fixture();
	const order: string[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution() { order.push("fence"); throw new Error("ownership rejected"); },
		async controlWorkflow(_ref, action) { order.push(`domain:${action}`); },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await assert.rejects(f.tools.get("workflow_control").execute("call", { ref: "test:workflow", action: "resume" }, undefined, undefined, f.ctx), /ownership rejected/);
	assert.deepEqual(order, ["fence"]);
	assert.equal(f.entries.some((entry) => entry.data?.state === "running"), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("checkpoint mutation occurs only after a successful durable ownership fence", async () => {
	const f = fixture();
	const order: string[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution() { order.push("fence"); throw new Error("ownership rejected"); },
		async controlCheckpoint() { order.push("domain:checkpoint"); return { status: "passed" }; },
		async controlWorkflow() {},
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await assert.rejects(f.tools.get("workflow_checkpoint").execute("call", { ref: "test:workflow/evaluation:review", action: "approve" }, undefined, undefined, f.ctx), /ownership rejected/);
	assert.deepEqual(order, ["fence"]);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("rejected runner commands do not mutate domain or local workflow state", async () => {
	for (const command of ["start", "pause", "resume", "stop", "attach"] as WorkflowRunnerCommand[]) {
		const order: string[] = [];
		const projections: unknown[] = [];
		const adapter: WorkflowAdapter = {
			id: "test", canHandle: () => true,
			async controlExecution() { order.push(`fence:${command}`); throw new Error(`rejected ${command}`); },
			async prepareWorkflow() { order.push("domain:start"); },
			async controlWorkflow(_ref, action) { order.push(`domain:${action}`); },
			async snapshot(ref) { order.push("snapshot"); return { ref, title: "Test", status: "ready", steps: [] }; },
			async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		};
		const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
			onProjection(projection) { projections.push(projection); }, onNotice() {}, onLifecycle() {}, onComplete() {},
		});
		await assert.rejects(runner.command(command, `test:${command}`, { async mutateDomain() { order.push("domain:custom"); } }), new RegExp(`rejected ${command}`));
		assert.deepEqual(order, [`fence:${command}`], `${command} must not reach domain mutation or refresh`);
		assert.equal(runner.mode, "stopped");
		assert.equal(runner.generation, undefined);
		assert.deepEqual(projections, []);
		await runner.dispose();
	}
});

test("successful runner commands serialize the fence before domain mutation", async () => {
	const order: string[] = [];
	let generation = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command) { order.push(`fence:${command}`); return { workflowRef: ref, mode: command === "pause" ? "paused" : command === "stop" ? "stopped" : "running", generation: ++generation }; },
		async prepareWorkflow() { order.push("domain:start"); },
		async controlWorkflow(_ref, action) { order.push(`domain:${action}`); },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection() {}, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await runner.command("start", "start");
	await runner.command("pause", "pause");
	await runner.command("resume", "resume");
	await runner.command("stop", "stop");
	assert.deepEqual(order, ["fence:start", "domain:start", "fence:pause", "domain:pause", "fence:resume", "domain:resume", "fence:stop", "domain:stop"]);
	await runner.dispose();
});

test("failed start preparation compensates durably to stopped without launching ready work", async () => {
	const failure = new Error("prepare failed");
	const operations: Array<{ command: string; operationId: string }> = [];
	const projections: Array<{ mode: string }> = [];
	let durableMode = "stopped";
	let generation = 0;
	let runs = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command, operationId) {
			operations.push({ command, operationId });
			durableMode = command === "stop" ? "stopped" : command === "pause" ? "paused" : "running";
			return { workflowRef: ref, mode: durableMode as "running" | "paused" | "stopped", generation: ++generation };
		},
		async prepareWorkflow() { throw failure; },
		async controlWorkflow() {},
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [{ ref: `${ref}/step`, title: "Ready", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { runs++; return { ref, state: "completed", summary: "unexpected" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection(projection) { projections.push(projection); }, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await assert.rejects(runner.command("start", "start-op"), (error) => error === failure);
	await runner.advance();
	assert.deepEqual(operations, [
		{ command: "start", operationId: "start-op" },
		{ command: "stop", operationId: "start-op:compensate:stop" },
	]);
	assert.equal(durableMode, "stopped");
	assert.equal(runner.mode, "stopped");
	assert.equal(runner.generation, 2);
	assert.equal(runs, 0);
	assert.ok(projections.length > 0 && projections.every((projection) => projection.mode === "stopped"));
	await runner.dispose();
});

test("failed resume domain control compensates durably to paused without launching ready work", async () => {
	const failure = new Error("resume failed");
	const operations: Array<{ command: string; operationId: string }> = [];
	const projections: Array<{ mode: string }> = [];
	let durableMode = "paused";
	let generation = 0;
	let runs = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command, operationId) {
			operations.push({ command, operationId });
			durableMode = command === "pause" ? "paused" : "running";
			return { workflowRef: ref, mode: durableMode as "running" | "paused", generation: ++generation };
		},
		async controlWorkflow(_ref, action) { if (action === "resume") throw failure; },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [{ ref: `${ref}/step`, title: "Ready", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { runs++; return { ref, state: "completed", summary: "unexpected" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection(projection) { projections.push(projection); }, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await assert.rejects(runner.command("resume", "resume-op"), (error) => error === failure);
	await runner.advance();
	assert.deepEqual(operations, [
		{ command: "resume", operationId: "resume-op" },
		{ command: "pause", operationId: "resume-op:compensate:pause" },
	]);
	assert.equal(durableMode, "paused");
	assert.equal(runner.mode, "paused");
	assert.equal(runner.generation, 2);
	assert.equal(runs, 0);
	assert.ok(projections.length > 0 && projections.every((projection) => projection.mode === "paused"));
	await runner.dispose();
});

test("failed checkpoint mutation compensates durably to paused without launching ready work", async () => {
	const failure = new Error("checkpoint mutation failed");
	const operations: Array<{ command: string; operationId: string }> = [];
	const domainActions: string[] = [];
	let durableMode = "paused";
	let generation = 0;
	let runs = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command, operationId) {
			operations.push({ command, operationId });
			durableMode = command === "pause" ? "paused" : "running";
			return { workflowRef: ref, mode: durableMode as "running" | "paused", generation: ++generation };
		},
		async controlWorkflow(_ref, action) { domainActions.push(action); },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [{ ref: `${ref}/step`, title: "Ready", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { runs++; return { ref, state: "completed", summary: "unexpected" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection(projection) { assert.equal(projection.mode, "paused"); }, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await assert.rejects(runner.command("resume", "checkpoint-op", {
		invokeDomainControl: false,
		async mutateDomain() { throw failure; },
	}), (error) => error === failure);
	await runner.advance();
	assert.deepEqual(operations, [
		{ command: "resume", operationId: "checkpoint-op" },
		{ command: "pause", operationId: "checkpoint-op:compensate:pause" },
	]);
	assert.deepEqual(domainActions, []);
	assert.equal(durableMode, "paused");
	assert.equal(runner.mode, "paused");
	assert.equal(runner.generation, 2);
	assert.equal(runs, 0);
	await runner.dispose();
});

test("activation compensation reports its own failure without hiding the domain error", async () => {
	const domainFailure = new Error("resume failed");
	const compensationFailure = new Error("pause fence failed");
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command) {
			if (command === "pause") throw compensationFailure;
			return { workflowRef: ref, mode: "running", generation: 1 };
		},
		async controlWorkflow() { throw domainFailure; },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unexpected" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection(projection) { assert.equal(projection.mode, "paused"); }, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await assert.rejects(runner.command("resume", "resume-op"), (error) => {
		assert.ok(error instanceof AggregateError);
		assert.deepEqual(error.errors, [domainFailure, compensationFailure]);
		assert.equal(error.cause, domainFailure);
		assert.match(error.message, /resume failed.*pause fence failed/);
		return true;
	});
	assert.equal(runner.mode, "paused");
	await runner.dispose();
});

test("failed stop domain teardown remains durably and locally stopped", async () => {
	const failure = new Error("stop teardown failed");
	const operations: string[] = [];
	let durableMode = "running";
	let runs = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => true,
		async controlExecution(ref, command) {
			operations.push(command);
			durableMode = command === "stop" ? "stopped" : "running";
			return { workflowRef: ref, mode: durableMode as "running" | "stopped", generation: 1 };
		},
		async controlWorkflow(_ref, action) { if (action === "stop") throw failure; },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [{ ref: `${ref}/step`, title: "Ready", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { runs++; return { ref, state: "completed", summary: "unexpected" }; },
	};
	const runner = new WorkflowRunner("test:workflow", adapter, {} as any, {
		onProjection(projection) { assert.equal(projection.mode, "stopped"); }, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	await assert.rejects(runner.command("stop", "stop-op"), (error) => error === failure);
	await runner.advance();
	assert.deepEqual(operations, ["stop"]);
	assert.equal(durableMode, "stopped");
	assert.equal(runner.mode, "stopped");
	assert.equal(runs, 0);
	await runner.dispose();
});

test("late failed settlement after stop is inert", async () => {
	const f = fixture();
	let rejectRun!: (error: Error) => void;
	let runs = 0;
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Test", status: "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { runs++; return new Promise<never>((_resolve, reject) => { rejectRun = reject; }); }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 15));
	await f.tools.get("workflow_control").execute("stop", { ref: "test:workflow", action: "stop" }, undefined, undefined, f.ctx);
	rejectRun(new Error("late failure"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runs, 1);
	assert.equal(f.entries.some((entry) => (entry.data as any).state === "paused"), false);
	assert.equal(f.messages.length, 0);
	assert.equal(f.widget(), undefined);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("late successful settlement after stop is inert", async () => {
	const f = fixture();
	let resolveRun!: () => void;
	let runs = 0;
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Test", status: "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { runs++; return new Promise((resolve) => { resolveRun = () => resolve({ ref: "test:step", state: "completed", summary: "late success" }); }); }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 15));
	await f.tools.get("workflow_control").execute("stop", { ref: "test:workflow", action: "stop" }, undefined, undefined, f.ctx);
	resolveRun();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runs, 1);
	assert.equal(f.entries.some((entry) => (entry.data as any).state === "paused"), false);
	assert.equal(f.messages.length, 0);
	assert.equal(f.widget(), undefined);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("stopping one workflow does not invalidate another workflow settlement", async () => {
	const f = fixture();
	const done = new Map([["test:a", false], ["test:b", false]]);
	const settles = new Map<string, () => void>();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot(ref) {
			const workflowRef = ref.split("/step")[0]!;
			const settled = done.get(workflowRef) === true;
			return { ref: workflowRef, title: workflowRef, status: settled ? "done" : "ready", steps: [{ ref: `${workflowRef}/step`, title: `${workflowRef} step`, kind: "task", status: settled ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
		},
		async runStep(ref) {
			const workflowRef = ref.split("/step")[0]!;
			await new Promise<void>((resolve) => settles.set(workflowRef, resolve));
			done.set(workflowRef, true);
			return { ref, state: "completed", summary: `${workflowRef} settled` };
		},
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("start-a", { ref: "test:a" }, undefined, undefined, f.ctx);
	await f.tools.get("workflow_start").execute("start-b", { ref: "test:b" }, undefined, undefined, f.ctx);
	await f.tools.get("workflow_control").execute("stop-a", { ref: "test:a", action: "stop" }, undefined, undefined, f.ctx);
	settles.get("test:b")!();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(done.get("test:b"), true);
	assert.ok(f.messages.some(({ message }) => message.customType === "pibox-workflow-complete"), "workflow B completes after workflow A is stopped");
	assert.equal(f.entries.some((entry) => entry.data?.ref === "test:b" && entry.data?.state === "paused"), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("background step failure pauses instead of retrying unchanged state", async () => {
	const f = fixture();
	let runs = 0;
	const controls: string[] = [];
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Test", status: "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async controlExecution(ref, command) { controls.push(command); return { workflowRef: ref, mode: command === "pause" ? "paused" : "running", generation: controls.length, ownerSessionId: "test-session" }; },
		async runStep() { runs++; throw new Error("broken"); }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	assert.equal(f.permissionMode(), "bypass");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runs, 1);
	assert.ok(controls.includes("pause"));
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("a tick crossing a concurrent pause cannot launch a stale ready step", async () => {
	const f = fixture();
	let runs = 0;
	let done = false;
	let rejectFirst!: (error: Error) => void;
	let lifecycle!: () => void;
	let blockSnapshot = false;
	let releaseSnapshot!: () => void;
	let snapshotBlocked!: () => void;
	const controls: string[] = [];
	const blocked = new Promise<void>((resolve) => { snapshotBlocked = resolve; });
	const projection = (): WorkflowSnapshot => ({ ref: "test:workflow", title: "Test", status: done ? "done" : "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: done ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] });
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(ref, command) { controls.push(command); return { workflowRef: ref, mode: command === "pause" ? "paused" : "running", generation: controls.length, ownerSessionId: "test-session" }; },
		async subscribeLifecycle(_ref, _ctx, listener) { lifecycle = () => listener(); },
		async snapshot() {
			if (!blockSnapshot) return projection();
			blockSnapshot = false;
			snapshotBlocked();
			return new Promise((resolve) => { releaseSnapshot = () => resolve(projection()); });
		},
		async runStep() {
			runs++;
			if (runs === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
			done = true;
			return { ref: "test:step", state: "completed", summary: "stale retry" };
		},
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("start", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(runs, 1);
	blockSnapshot = true;
	lifecycle();
	await blocked;
	rejectFirst(new Error("post-repair check failed"));
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(controls.at(-1), "pause");
	releaseSnapshot();
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runs, 1, "a tick that began before pause cannot launch after the pause fence advances");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("does not emit completion feedback when a task contribution completes before merge", async () => {
	const f = fixture();
	let done = false;
	const feedback: WorkflowLifecycleEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() {
			return { ref: "test:workflow", title: "Feedback", status: done ? "done" : "ready", steps: [{ ref: "test:task", title: "Implement feedback", kind: "task", status: done ? "done" : "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }] };
		},
		async runStep(ref) { done = true; return { ref, state: "completed", summary: "Contribution completed." }; },
		async controlWorkflow() {},
	};
	f.pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (event: unknown) => feedback.push(event as WorkflowLifecycleEvent));
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(feedback, []);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("an individual merge does not emit completion before its stage review finishes", async () => {
	const f = fixture();
	let merged = false;
	const lifecycle: WorkflowLifecycleEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() {
			return {
				ref: "test:workflow", title: "Merge", status: "ready",
				steps: [
					{ ref: "test:workflow/task:task", title: "Merge task", kind: "merge", status: merged ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] },
					{ ref: "test:workflow/evaluation:stage-review", title: "Stage review", kind: "evaluation", checkpoint: "stage-review", status: "pending", dependsOn: ["test:workflow/task:task"], parallelism: "serial", resourceClaims: [] },
				],
				stages: [{ id: "delivery", index: 0, nodes: ["task:task", "evaluation:stage-review"], parallel: false, group: "planner" }],
			};
		},
		async runStep(ref) { merged = true; return { ref, state: "completed", summary: "Merged." }; },
		async controlWorkflow() {},
	};
	f.pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (event: unknown) => lifecycle.push(event as WorkflowLifecycleEvent));
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(lifecycle.some((event) => event.type === "stage-completed"), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("an adapter-owned semantic stage event emits one lifecycle completion and wakes the main session", async () => {
	const f = fixture();
	let done = false;
	let emitted = false;
	let semantic: ((update?: any) => void) | undefined;
	const lifecycle: WorkflowLifecycleEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		subscribeLifecycle(_ref, _ctx, listener) { semantic = listener; },
		async reconcileWorkflow() {
			if (!done || emitted) return;
			emitted = true;
			semantic?.({ workflowRef: "test:workflow", title: "Stage 1 · delivery", attention: false, kind: "stage", toStatus: "done", lifecycle: {
				type: "stage-completed", workflowRef: "test:workflow", stepRef: "test:workflow/evaluation:stage-review", kind: "evaluation",
				stageId: "delivery", stageIndex: 0, title: "Stage 1 · delivery", toStatus: "done", cause: "stage-settled", correlationId: "test:workflow:delivery",
			} });
		},
		async snapshot() {
			return {
				ref: "test:workflow", title: "Review boundary", status: done ? "done" : "ready",
				steps: [{ ref: "test:workflow/evaluation:stage-review", title: "Stage review", kind: "evaluation", checkpoint: "stage-review", status: done ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }],
				stages: [{ id: "delivery", index: 0, nodes: ["evaluation:stage-review"], parallel: false, group: "planner" }],
			};
		},
		async runStep(ref) { done = true; return { ref, state: "completed", summary: "Review passed." }; },
		async controlWorkflow() {},
	};
	f.pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (event: unknown) => lifecycle.push(event as WorkflowLifecycleEvent));
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(lifecycle.filter((event) => event.type === "stage-completed"), [{
		type: "stage-completed", workflowRef: "test:workflow", stepRef: "test:workflow/evaluation:stage-review", kind: "evaluation",
		stageId: "delivery", stageIndex: 0, title: "Stage 1 · delivery", toStatus: "done", cause: "stage-settled", correlationId: "test:workflow:delivery",
	}]);
	const workflowEvents = f.messages.filter(({ message, options }) => (message as any).customType === "pibox-workflow-event" && (options as any).deliverAs === "followUp" && (options as any).triggerTurn === true);
	assert.equal(workflowEvents.length, 1);
	assert.equal(workflowEvents[0]?.message.display, true);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("checkpoint approval publishes adapter-owned semantic stage completion", async () => {
	const f = fixture();
	let approved = false;
	let emitted = false;
	let semantic: ((update?: any) => void) | undefined;
	const lifecycle: WorkflowLifecycleEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		subscribeLifecycle(_ref, _ctx, listener) { semantic = listener; },
		async reconcileWorkflow() {
			if (!approved || emitted) return;
			emitted = true;
			semantic?.({ workflowRef: "test:workflow", title: "Stage 1 · delivery", attention: false, kind: "stage", toStatus: "done", lifecycle: { type: "stage-completed", workflowRef: "test:workflow", stepRef: "test:workflow/evaluation:stage-review", kind: "evaluation", stageId: "delivery", stageIndex: 0, title: "Stage 1 · delivery", toStatus: "done", cause: "stage-settled", correlationId: "test:workflow:delivery" } });
		},
		async snapshot() {
			return {
				ref: "test:workflow", title: "Approval boundary", status: approved ? "done" : "attention",
				steps: [{ ref: "test:workflow/evaluation:stage-review", title: "Stage review", kind: "evaluation", checkpoint: "stage-review", status: approved ? "done" : "attention", detail: approved ? "Approved" : "Needs attention · Approve or Request changes", dependsOn: [], parallelism: "serial", resourceClaims: [] }],
				stages: [{ id: "delivery", index: 0, nodes: ["evaluation:stage-review"], parallel: false, group: "planner" }],
			};
		},
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async controlExecution(ref, command) { return { workflowRef: ref, generation: 1, mode: command === "pause" || command === "detach" ? "paused" : command === "complete" ? "completed" : command === "stop" ? "stopped" : "running" }; }, async controlWorkflow() {},
		async controlCheckpoint() { approved = true; return { status: "passed" }; },
	};
	f.pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (event: unknown) => lifecycle.push(event as WorkflowLifecycleEvent));
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 20));
	await f.tools.get("workflow_checkpoint").execute("checkpoint", { ref: "test:workflow/evaluation:stage-review", action: "approve" }, undefined, undefined, f.ctx);
	assert.equal(lifecycle.filter((event) => event.type === "stage-completed" && event.stageId === "delivery").length, 1);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("emits workflow error feedback when a step pauses for attention", async () => {
	const f = fixture();
	const feedback: WorkflowLifecycleEvent[] = [];
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Feedback", status: "ready", steps: [{ ref: "test:task", title: "Blocked feedback", kind: "task", status: "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep(ref) { return { ref, state: "blocked", summary: "Needs user attention.", attention: true }; },
		async controlWorkflow() {},
	};
	f.pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (event: unknown) => feedback.push(event as WorkflowLifecycleEvent));
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(feedback, [{ type: "error", workflowRef: "test:workflow", stepRef: "test:task", kind: "task", title: "Blocked feedback", detail: "Needs user attention.", cause: "step-attention", nextAction: "Resolve the step and resume or decide at its checkpoint." }]);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("transient snapshot attention does not pause an in-flight step or block routine advancement", async () => {
	const f = fixture();
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	let firstRunning = false;
	let firstDone = false;
	let secondDone = false;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() {
			return {
				ref: "test:workflow", title: "Transient settlement", status: firstRunning && !firstDone ? "attention" : firstDone && secondDone ? "done" : "ready",
				steps: [
					{ ref: "test:first", title: "First", kind: "task", status: firstDone ? "done" : firstRunning ? "attention" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] },
					{ ref: "test:second", title: "Second", kind: "task", status: secondDone ? "done" : firstDone ? "ready" : "pending", dependsOn: ["test:first"], parallelism: "serial", resourceClaims: [] },
				],
			};
		},
		async runStep(ref) {
			if (ref === "test:first") { firstRunning = true; await firstGate; firstDone = true; return { ref, state: "completed", summary: "First settled." }; }
			secondDone = true; return { ref, state: "completed", summary: "Second settled." };
		},
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(f.entries.some((entry) => (entry.data as any).state === "paused"), false);
	releaseFirst();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(secondDone, true, "runner advances to the next ready step without orchestrator intervention");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("schedules an explicit sequential stage one serial repository task at a time before its next stage", async () => {
	const f = fixture();
	const statuses = new Map([["first", "ready"], ["second", "pending"], ["third", "pending"], ["review", "pending"], ["next", "pending"]]);
	const calls: string[] = [];
	let active = 0;
	let maximumActive = 0;
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
	const refs = (id: string) => `test:${id}`;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot(ref) {
			const steps = [...statuses].map(([id, status]) => ({
				ref: refs(id), title: id, kind: id === "review" ? "evaluation" as const : "task" as const,
				status: status as any, dependsOn: [], parallelism: "serial" as const, resourceClaims: id === "review" ? [] : ["working-branch"],
			}));
			return { ref, title: "Sequential stage", status: statuses.get("next") === "done" ? "done" : "ready", steps };
		},
		async runStep(ref) {
			const id = ref.slice("test:".length);
			calls.push(id); active++; maximumActive = Math.max(maximumActive, active);
			try {
				if (id === "first") await firstGate;
				statuses.set(id, "done");
				if (id === "first") statuses.set("second", "ready");
				if (id === "second") statuses.set("third", "ready");
				if (id === "third") statuses.set("review", "ready");
				if (id === "review") statuses.set("next", "ready");
				return { ref, state: "completed", summary: `${id} settled.` };
			} finally { active--; }
		},
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.deepEqual(calls, ["first"], "only the first sequential task starts initially");
	releaseFirst();
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.deepEqual(calls, ["first", "second", "third", "review", "next"]);
	assert.equal(maximumActive, 1, "serial scheduling never overlaps stage work or review");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("request_changes returns immediately while the runner starts Fix #2 in background", async () => {
	const f = fixture();
	let fixing = false;
	let repairStarts = 0;
	const neverSettles = new Promise<any>(() => {});
	const snapshot = (): WorkflowSnapshot => ({
		ref: "work-item:example", title: "Example", status: fixing ? "ready" : "attention",
		steps: [{ ref: "work-item:example/evaluation:review", title: "Review loop review", kind: "evaluation", status: fixing ? "ready" : "attention", detail: fixing ? "fixing · iteration 1" : "awaiting manager · iteration 1", dependsOn: [], parallelism: "serial", resourceClaims: [] }],
		stages: [{ id: "delivery", index: 0, nodes: ["evaluation:review"], parallel: false, group: "planner" }],
	});
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:example"), async snapshot() { return snapshot(); },
		async runStep() { repairStarts++; return neverSettles; },
		async controlCheckpoint() { fixing = true; return { loop: { state: "fixing", iteration: 1 } }; },
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	const result = await f.tools.get("workflow_checkpoint").execute("call", { ref: "work-item:example/evaluation:review", action: "request_changes", prompt: "Fix it" }, undefined, undefined, f.ctx);
	assert.match(result.content[0].text, /running in the background/i);
	assert.equal(repairStarts, 1);
	// Replaying/reconciling the same checkpoint while the persistent fixer is
	// already in flight must not reserve a second logical worker.
	await f.tools.get("workflow_checkpoint").execute("call-again", { ref: "work-item:example/evaluation:review", action: "request_changes", prompt: "Fix it" }, undefined, undefined, f.ctx);
	assert.equal(repairStarts, 1);
	const widget = f.widget() as ((...args: any[]) => any);
	const rendered = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	assert.equal(rendered.some((line) => line.includes("Fix #2")), true, "fix numbering describes the upcoming repair iteration");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("running step kinds use distinct icons without redundant state labels", async () => {
	const f = fixture();
	const snapshot: WorkflowSnapshot = {
		ref: "test:workflow", title: "Active states", status: "running",
		steps: [
			{ ref: "test:task", title: "Implement", kind: "task", status: "running", fast: true, dependsOn: [], parallelism: "allowed", resourceClaims: [], progress: { startedAt: new Date(Date.now() - 61_000).toISOString(), lastEventAt: new Date().toISOString(), turns: 3, toolCalls: 4, toolErrors: 0, outputTokens: 1450, reasoningTokens: 22 } },
			{ ref: "test:merge", title: "Merge", kind: "merge", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [] },
			{ ref: "test:evaluation", title: "Evaluate", kind: "evaluation", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [] },
		],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const widget = f.widget() as ((...args: any[]) => any);
	let invalidations = 0;
	const rendered = widget?.({ requestRender: () => { invalidations++; } }, f.ctx.ui.theme).render(120) as string[];
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.ok(invalidations > 0, "fast visual timer requests real TUI redraws");
	assert.equal(rendered.some((line) => /\b(running|merging)\b/.test(line)), false);
	assert.equal(rendered.some((line) => line.includes("↓ 1.5k")), true);
	const taskLine = rendered.findIndex((line) => line.includes("Implement"));
	assert.ok(taskLine > 0);
	assert.equal(rendered[taskLine]!.includes("Fast"), false, "the task title keeps the full row");
	assert.match(rendered[taskLine + 1]!.trimStart(), /^Fast ·/, "live subagent status moves to an aligned continuation row");
	assert.equal(rendered.filter((line) => line.includes("Fast")).length, 1, "Fast is omitted for ordinary workflow agents");
	assert.equal(rendered.some((line) => /\bout\b/i.test(line)), false);
	const icons = ["Implement", "Merge", "Evaluate"].map((title) => rendered.find((line) => line.includes(title))!.trimStart()[0]);
	assert.equal(new Set(icons).size, 3, "task, merge, and evaluation activity have distinct animated icon families");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("an in-flight ready step animates immediately before the adapter reports running", async () => {
	const f = fixture();
	const neverSettles = new Promise<WorkflowRunResult>(() => undefined);
	const progress = { startedAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 };
	const snapshot: WorkflowSnapshot = {
		ref: "test:workflow", title: "Starting implementation", status: "ready",
		steps: [{ ref: "test:workflow/task:one", title: "Add atomic this-and-following series deletion", kind: "task", status: "ready", fast: true, dependsOn: [], parallelism: "serial", resourceClaims: [], progress }],
		stages: [{ id: "delivery", index: 0, nodes: ["task:one"], parallel: false, group: "planner" }],
		metrics: { elapsedMs: 60_000, runningMs: 60_000, agentActiveMs: 8_000, verificationMs: 0, fixes: 0, retries: 0, agentCount: 1, verificationAttempts: 0, inputTokens: 500, outputTokens: 0, toolErrors: 0 },
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { return neverSettles; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const widget = f.widget() as ((...args: any[]) => any);
	const rendered = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	const activeLines = rendered.filter((line) => line.includes("Implementing"));
	assert.equal(activeLines.length, 2, "stage and task both render as implementing");
	assert.ok(activeLines.every((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)), "in-flight ready state uses animated task frames instead of a static ready diamond");
	assert.ok(activeLines.every((line) => !line.includes("◆")));
	const fastVisible = widget?.({}, f.ctx.ui.theme).render(160) as string[];
	const implementationLine = fastVisible.findIndex((line) => line.includes("Implementing · Add atomic this-and-following series deletion"));
	assert.ok(implementationLine > 0, "the complete task phase and title retain their own row");
	assert.match(fastVisible[implementationLine + 1]!.trimStart(), /^Fast ·/, "live subagent status starts on the next row aligned beneath the phase text");
	const firstDivider = rendered[0]!.indexOf("│");
	progress.turns = 12; progress.toolCalls = 34; progress.outputTokens = 152_000; progress.lastEventAt = new Date(Date.now() - 45_000).toISOString();
	const updated = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	assert.ok(firstDivider > 0, "wide layout shows the metrics pane");
	assert.equal(updated[0]!.indexOf("│"), firstDivider, "volatile progress does not move the responsive pane divider");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("wide metrics render role, deterministic, scheduling, and total clocks with a narrow fallback", async () => {
	const f = fixture();
	const snapshot: WorkflowSnapshot = {
		ref: "test:metrics", title: "Metrics", status: "paused",
		steps: [{ ref: "test:metrics/task:one", title: "Durable projection", kind: "task", status: "running", dependsOn: [], parallelism: "serial", resourceClaims: [] }],
		stages: [{ id: "delivery", index: 0, nodes: ["task:one"], parallel: false, group: "planner" }],
		metrics: { elapsedMs: 8_040_000, runningMs: 4_000_000, agentActiveMs: 4_640_000, implementerMs: 3_240_000, reviewerMs: 500_000, fixerMs: 600_000, e2eAgentMs: 300_000, deterministicMs: 740_000, harnessSchedulingMs: 90_000, implementationMs: 1_800_000, integrationMs: 600_000, verificationMs: 740_000, reviewMs: 500_000, e2eMs: 300_000, orchestrationMs: 60_000, fixes: 4, retries: 6, agentCount: 9, verificationAttempts: 12, inputTokens: 123_456, outputTokens: 78_900, toolErrors: 3 },
		repairLoop: { label: "Stage 4 fix loop", iteration: 1, maxIterations: 3, evaluationRef: "test:metrics/evaluation:stage-4-review" },
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "paused", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: snapshot.ref, mode: "paused" as const, generation: 1 }]; },
		async snapshot() { return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	const component = (f.widget() as any)?.({}, f.ctx.ui.theme);
	const wide = component.render(100) as string[];
	const rows = [["Total time", "1h 6m 40s"], ["Implementer", "54m 0s"], ["Reviewer", "8m 20s"], ["Fixer", "10m 0s"], ["E2E", "5m 0s"], ["Deterministic steps", "12m 20s"], ["Orchestrator", "1m 0s"], ["Harness scheduling", "1m 30s"], ["Stage 4 fix loop", "1 / 3"]] as const;
	assert.equal(wide.length, 9);
	const dividers = wide.map((line) => line.indexOf("│"));
	assert.ok(dividers[0]! > 0);
	assert.equal(new Set(dividers).size, 1, "every metrics row uses the stable structural divider");
	for (const [index, [label, value]] of rows.entries()) {
		assert.match(wide[index]!, new RegExp(`${label}\\s+${value.replace("/", "\\/")}`));
		assert.equal(wide[index]!.lastIndexOf(value) + value.length, wide[index]!.length - 1, "metric values align to the right pane edge");
	}
	assert.equal(wide.some((line) => /fixes|retries|tokens|agent count|tool errors/i.test(line)), false, "aggregate diagnostics stay out of the boundary-oriented widget");
	const narrow = component.render(60) as string[];
	assert.equal(narrow.some((line) => line.includes("│")), false);
	assert.equal(narrow.some((line) => rows.some(([label]) => line.includes(label))), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("open metric intervals advance locally without refreshing the durable snapshot", async () => {
	const f = fixture();
	let snapshotReads = 0;
	const sampledAtMs = Date.now();
	const snapshot: WorkflowSnapshot = {
		ref: "test:live-metrics", title: "Live metrics", status: "paused",
		steps: [{ ref: "test:live-metrics/task:one", title: "Waiting", kind: "task", status: "pending", dependsOn: [], parallelism: "serial", resourceClaims: [] }],
		metrics: {
			elapsedMs: 0, runningMs: 0, agentActiveMs: 0, implementerMs: 0, reviewerMs: 0, fixerMs: 0, e2eAgentMs: 0, deterministicMs: 0, harnessSchedulingMs: 0, implementationMs: 0, integrationMs: 0, verificationMs: 0, reviewMs: 0, e2eMs: 0, orchestrationMs: 0, fixes: 0, retries: 0,
			agentCount: 1, verificationAttempts: 0, inputTokens: 0, outputTokens: 0, toolErrors: 0,
			live: { sampledAtMs, elapsed: true, running: true, activeCategory: "implementation", activeAgents: 1, activeVerifications: 0, activeImplementers: 1, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: false },
		},
		repairLoop: { label: "Stage 1 fix loop", iteration: 0, maxIterations: 3, evaluationRef: "test:live-metrics/evaluation:stage-1-review" },
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "paused", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: snapshot.ref, mode: "paused" as const, generation: 1 }]; },
		async snapshot() { snapshotReads++; return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	let redraws = 0;
	const component = (f.widget() as any)?.({ requestRender: () => { redraws++; } }, f.ctx.ui.theme);
	const initial = component.render(100) as string[];
	const initialWorkflow = Number(/Total time\s+(\d+)s/.exec(initial[0]!)?.[1]);
	const initialImplementation = Number(/Implementer\s+(\d+)s/.exec(initial[1]!)?.[1]);
	assert.ok(Number.isFinite(initialWorkflow) && Number.isFinite(initialImplementation));
	const readsBeforeWait = snapshotReads;
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	const advanced = component.render(100) as string[];
	const advancedWorkflow = Number(/Total time\s+(\d+)s/.exec(advanced[0]!)?.[1]);
	const advancedImplementation = Number(/Implementer\s+(\d+)s/.exec(advanced[1]!)?.[1]);
	assert.ok(advancedWorkflow > initialWorkflow, "active workflow time advances between renders");
	assert.ok(advancedImplementation > initialImplementation, "open implementer process time advances locally");
	assert.equal(advancedWorkflow - initialWorkflow, advancedImplementation - initialImplementation, "one active implementer advances at wall-clock speed");
	assert.ok(redraws >= 1 && redraws <= 2, `clock-only display redraws at second cadence, observed ${redraws} redraws`);
	assert.equal(snapshotReads, readsBeforeWait, "visual time interpolation performs no repository snapshot reads");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("renders final validation as distinct E2E and whole-branch fix loops", async () => {
	const f = fixture();
	const progress = { startedAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), turns: 4, toolCalls: 13, toolErrors: 0, outputTokens: 2285, reasoningTokens: 1082, processStartedAt: new Date().toISOString() };
	const snapshot: WorkflowSnapshot = {
		ref: "work-item:calendar", title: "Calendar", status: "running",
		steps: [
			{ ref: "work-item:calendar/evaluation:final-branch-review", title: "Whole-branch review/fix loop · Reviewing whole branch", kind: "evaluation", checkpoint: "final-review", status: "running", fast: true, progress, dependsOn: [], parallelism: "serial", resourceClaims: [] },
			{ ref: "work-item:calendar/evaluation:final-e2e", title: "E2E journey/fix loop · Journey run queued", kind: "evaluation", checkpoint: "final-e2e", status: "pending", dependsOn: ["work-item:calendar/evaluation:final-branch-review"], parallelism: "serial", resourceClaims: [] },
		],
		stages: [{ id: "runtime-verification", index: 8, nodes: ["evaluation:final-branch-review", "evaluation:final-e2e"], parallel: false, group: "runtime" }],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "paused", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: snapshot.ref, mode: "paused" as const, generation: 1 }]; },
		async snapshot() { return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(140) as string[];
	assert.ok(rendered.some((line) => line.includes("Final validation · Whole-branch review/fix loop · 2 gates")));
	const review = rendered.findIndex((line) => line.includes("Whole-branch review/fix loop · Reviewing whole branch"));
	assert.ok(review > 0);
	assert.match(rendered[review + 1]!.trimStart(), /^Fast · .*4 turns · 13 tools/, "stage-aware review detail puts live agent status on its own continuation row");
	assert.ok(rendered.some((line) => line.includes("E2E journey/fix loop · Journey run queued")));
	assert.equal(rendered.some((line) => line.includes("Runtime verification") || line.includes("0 tasks")), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("renders durable integration and verification phases instead of generic ready-to-merge labels", async () => {
	const f = fixture();
	const snapshot: WorkflowSnapshot = {
		ref: "work-item:calendar", title: "Calendar", status: "ready",
		steps: [
			{ ref: "work-item:calendar/task:android", title: "Android calendar", kind: "merge", status: "ready", phase: "verification-failed", dependsOn: [], parallelism: "serial", resourceClaims: ["working-branch"] },
			{ ref: "work-item:calendar/task:ios", title: "iOS calendar", kind: "merge", status: "pending", phase: "contribution-ready", dependsOn: [], parallelism: "serial", resourceClaims: ["working-branch"] },
		],
		stages: [{ id: "mobile-platform", index: 0, nodes: ["task:android", "task:ios"], parallel: true, group: "planner" }],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "paused", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: snapshot.ref, mode: "paused" as const, generation: 1 }]; },
		async snapshot() { return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(120) as string[];
	assert.ok(rendered.some((line) => line.includes("Verification failed") && line.includes("2 tasks")));
	assert.ok(rendered.some((line) => line.includes("⚠ Verification failed · Android calendar")));
	assert.ok(rendered.some((line) => line.includes("◆ Contribution ready · iOS calendar")));
	assert.equal(rendered.some((line) => line.includes("Ready to merge")), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("communicates every contribution participating in an active concurrent merge barrier", async () => {
	const f = fixture();
	const snapshot: WorkflowSnapshot = {
		ref: "work-item:calendar", title: "Calendar", status: "running",
		steps: [
			{ ref: "work-item:calendar/task:android", title: "Android calendar", kind: "merge", status: "running", phase: "ready-to-integrate", dependsOn: [], parallelism: "serial", resourceClaims: ["working-branch"] },
			{ ref: "work-item:calendar/task:ios", title: "iOS calendar", kind: "merge", status: "pending", phase: "contribution-ready", detail: "waiting for stage merge barrier", dependsOn: [], parallelism: "serial", resourceClaims: ["working-branch"] },
		],
		stages: [{ id: "mobile-platform", index: 0, nodes: ["task:android", "task:ios"], parallel: true, group: "planner" }],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "paused", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: snapshot.ref, mode: "paused" as const, generation: 1 }]; },
		async snapshot() { return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(120) as string[];
	const owner = rendered.find((line) => line.includes("Assembling candidate · Android calendar"));
	const sibling = rendered.find((line) => line.includes("Waiting for shared merge barrier · iOS calendar"));
	assert.ok(owner);
	assert.ok(sibling);
	assert.match(owner!, /[⇢→⇒]/);
	assert.match(sibling!, /[⇢→⇒]/, "waiting contributions share the active barrier animation without becoming separately runnable");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("animates candidate verification from the semantic verification phase", async () => {
	const f = fixture();
	const neverSettles = new Promise<WorkflowRunResult>(() => undefined);
	const snapshot: WorkflowSnapshot = {
		ref: "work-item:calendar", title: "Calendar", status: "ready",
		steps: [{ ref: "work-item:calendar/task:android", title: "Android calendar", kind: "merge", status: "ready", phase: "verifying-candidate", dependsOn: [], parallelism: "serial", resourceClaims: ["working-branch"] }],
		stages: [{ id: "mobile-platform", index: 0, nodes: ["task:android"], parallel: false, group: "planner" }],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		async snapshot() { return snapshot; }, async runStep() { return neverSettles; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "work-item:calendar" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(120) as string[];
	const verifying = rendered.filter((line) => line.includes("Verifying candidate"));
	assert.equal(verifying.length, 2);
	assert.ok(verifying.every((line) => /[◐◓◑◒]/.test(line)));
	assert.equal(rendered.some((line) => /\b(starting|active)\b/.test(line)), false, "a harness merge/verification step has no synthetic subagent process status");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("a recovered reviewer settlement wakes the main session at the canonical manager checkpoint", async () => {
	const f = fixture();
	let phase: "running" | "awaiting-manager" = "running";
	let lifecycle!: () => void;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		async controlExecution(ref) { return { workflowRef: ref, mode: "running", generation: 1, ownerSessionId: "test-session" }; },
		async listExecutionControls() { return [{ workflowRef: "work-item:review", mode: "running", generation: 1 }]; },
		subscribeLifecycle(_ref, _ctx, listener) { lifecycle = listener; return () => undefined; },
		async snapshot(ref) {
			const attention = phase === "awaiting-manager";
			return {
				ref, title: "Recovered review", status: attention ? "attention" : "running",
				steps: [{
					ref: `${ref}/evaluation:stage-review`, title: attention ? "Review loop · Needs attention · Approve or Request changes" : "Review loop · Reviewing",
					kind: "evaluation", checkpoint: "stage-review", status: attention ? "attention" : "running",
					detail: attention ? "Needs attention · Approve or Request changes" : "Reviewing", dependsOn: [], parallelism: "serial", resourceClaims: [],
				}],
			};
		},
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({ reason: "reload" }, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	phase = "awaiting-manager";
	lifecycle();
	await new Promise((resolve) => setTimeout(resolve, 30));
	const notice = f.messages.find(({ message }) => (message as any).customType === "pibox-workflow-event" && String(message.content).includes("Approve or Request changes"));
	assert.ok(notice, "reload recovery must deliver the canonical checkpoint even without the original in-flight settlement callback");
	assert.equal(notice?.options.deliverAs, "steer");
	assert.equal(notice?.options.triggerTurn, true);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("lifecycle callbacks refresh a queued review into its active dashboard state", async () => {
	const f = fixture();
	let phase: "queued" | "running" = "queued";
	let notify!: () => void;
	const refreshed = new Promise<void>((resolve) => { notify = resolve; });
	let lifecycle!: () => void;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"),
		subscribeLifecycle(_ref, _ctx, listener) { lifecycle = listener; return () => undefined; },
		async snapshot(ref) {
			if (phase === "running") notify();
			return { ref, title: "Review lifecycle", status: "ready", steps: [{ ref: `${ref}/evaluation:review`, title: phase === "running" ? "Review · Re-reviewing #1" : "Review · Re-review requested", kind: "evaluation", status: phase === "running" ? "running" : "pending", detail: phase, dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
		},
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "work-item:review" }, undefined, undefined, f.ctx);
	phase = "running";
	lifecycle!();
	await refreshed;
	await new Promise((resolve) => setImmediate(resolve));
	const widget = f.widget() as ((...args: any[]) => any);
	const rendered = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	assert.ok(rendered.some((line) => line.includes("Re-reviewing #1")));
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("duplicate lifecycle callbacks coalesce behind one in-flight refresh", async () => {
	const f = fixture();
	let lifecycle!: () => void;
	let refreshing = false;
	let snapshots = 0;
	let entered!: () => void;
	const enteredRefresh = new Promise<void>((resolve) => { entered = resolve; });
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	let followUp!: () => void;
	const completedFollowUp = new Promise<void>((resolve) => { followUp = resolve; });
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		subscribeLifecycle(_ref, _ctx, listener) { lifecycle = listener; return () => undefined; },
		async snapshot(ref) {
			snapshots++;
			if (!refreshing) return { ref, title: "Coalesced", status: "ready", steps: [{ ref: `${ref}/step`, title: "Queued", kind: "task", status: "pending", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
			entered();
			await barrier;
			refreshing = false;
			followUp();
			return { ref, title: "Coalesced", status: "ready", steps: [{ ref: `${ref}/step`, title: "Active", kind: "task", status: "running", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
		},
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:coalesced" }, undefined, undefined, f.ctx);
	refreshing = true;
	lifecycle!();
	await enteredRefresh;
	lifecycle!(); lifecycle!();
	release();
	await completedFollowUp;
	assert.equal(snapshots, 4, "start validation, initial runner snapshot, and exactly one coalesced lifecycle refresh");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("stopping during asynchronous lifecycle setup prevents late listener installation", async () => {
	const f = fixture();
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => { release = resolve; });
	let installed = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		subscribeLifecycle(_ref, _ctx, listener, signal) {
			return barrier.then(() => {
				if (signal?.aborted) return () => undefined;
				installed++;
				return () => undefined;
			});
		},
		async snapshot(ref) { return { ref, title: "Cancellation", status: "ready", steps: [{ ref: `${ref}/step`, title: "Queued", kind: "task", status: "pending", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:cancel" }, undefined, undefined, f.ctx);
	await f.tools.get("workflow_control").execute("stop", { ref: "test:cancel", action: "stop" }, undefined, undefined, f.ctx);
	release();
	await barrier;
	await Promise.resolve();
	assert.equal(installed, 0);
	assert.equal(f.widget(), undefined);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("workflow runner refreshes and freezes terminal metrics before rendering completion", async () => {
	const f = fixture();
	const sampledAtMs = Date.now();
	let taskDone = false;
	let completedAt: number | undefined;
	let snapshotReads = 0;
	const snapshots = (): WorkflowSnapshot => ({
		ref: "test:workflow", title: "Example", status: taskDone ? "done" : "ready",
		steps: [{ ref: "test:task", title: "Implement example", kind: "task", status: taskDone ? "done" : "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }],
		metrics: {
			elapsedMs: completedAt === undefined ? 0 : completedAt - sampledAtMs,
			runningMs: completedAt === undefined ? 0 : completedAt - sampledAtMs,
			agentActiveMs: 500, verificationMs: 0, fixes: 0, retries: 0, agentCount: 1, verificationAttempts: 0, inputTokens: 100, outputTokens: 50, toolErrors: 0,
			live: { sampledAtMs: completedAt ?? sampledAtMs, elapsed: completedAt === undefined, running: completedAt === undefined, activeAgents: 0, activeVerifications: 0 },
		},
	});
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async completionPrompt() { return "Read outcome.md and brief the user."; }, async snapshot() { snapshotReads++; return snapshots(); },
		async controlExecution(ref, command) { if (command === "complete") completedAt = Date.now(); return { workflowRef: ref, mode: command === "complete" ? "completed" : "running", generation: 1, ownerSessionId: "test-session" }; },
		async runStep(ref) { taskDone = true; return { ref, state: "completed", summary: "Implementation done." }; },
		async controlWorkflow() {},
	};
	registerTestAdapter(adapter);
	await f.handlers.get("session_start")?.({}, f.ctx);
	const started = await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	assert.match(started.content[0].text, /Started workflow/);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(taskDone, true);
	assert.ok(completedAt, "the runtime records its terminal control boundary");
	assert.ok(snapshotReads >= 3, "completion refreshes the snapshot after recording the terminal boundary");
	assert.ok(f.widget());
	assert.equal(f.entries.length, 0, "workflow lifecycle is not duplicated into Pi session history");
	const completion = f.messages.find((entry) => entry.message.customType === "pibox-workflow-complete");
	assert.equal(completion?.message.display, false);
	assert.equal(completion?.options.triggerTurn, true);
	assert.match(completion?.message.content ?? "", /outcome\.md.*brief the user/i);
	const widget = f.widget() as ((...args: any[]) => any);
	const component = widget?.({}, f.ctx.ui.theme);
	const rendered = component.render(100) as string[];
	assert.ok(rendered.every((line: string) => line.startsWith(" ") && line.endsWith(" ")));
	assert.ok(rendered.every((line: string) => line.includes(" │ ")), "wide dashboards visibly separate tasks from workflow metrics");
	assert.ok(rendered.every((line: string) => line.indexOf(" │ ") < 65), "the metrics pane starts near the task content instead of at the far right");
	await new Promise((resolve) => setTimeout(resolve, 1_100));
	assert.deepEqual(component.render(100), rendered, "every displayed metric stays frozen after workflow completion");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});
