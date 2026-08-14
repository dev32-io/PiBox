import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows from "../index.js";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, type WorkflowAdapter, type WorkflowSnapshot } from "../api.js";

function fixture() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const messages: any[] = [];
	const entries: any[] = [];
	let widget: unknown;
	let activeTools: string[] = [];
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		events: {
			on(name: string, handler: (data: unknown) => void) { const current = bus.get(name) ?? []; current.push(handler); bus.set(name, current); },
			emit(name: string, data: unknown) { for (const handler of bus.get(name) ?? []) handler(data); },
		},
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		sendMessage(message: unknown, options: unknown) { messages.push({ message, options }); },
		getActiveTools() { return activeTools; }, setActiveTools(names: string[]) { activeTools = names; },
	} as unknown as ExtensionAPI;
	workflows(pi);
	const ctx: any = {
		hasUI: true,
		ui: {
			theme: { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text },
			setWidget(_id: string, value: unknown) { widget = value; },
		},
		sessionManager: { getEntries: () => entries },
	};
	return { pi, tools, handlers, messages, entries, ctx, widget: () => widget };
}

test("registers the generalized workflow and subagent surface", () => {
	const f = fixture();
	assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control", "workflow_checkpoint", "subagent_spawn", "subagent_status", "subagent_control", "subagent_respond"]);
	assert.match(f.tools.get("subagent_spawn").description, /subagent.*configured generic agent definition and task prompt.*Background is the default/i);
	assert.match(JSON.stringify(f.tools.get("subagent_spawn").parameters), /agent.*task.*background.*foreground/);
	assert.match(f.tools.get("workflow_start").description, /user explicitly asks to run.*No separate approval command/i);
	assert.match(f.tools.get("workflow_control").description, /Stop terminates active attempts.*resume prepares incomplete stopped work/);
});

test("failed workflow start returns an error and leaves no dashboard", async () => {
	const f = fixture();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() { throw new Error("Workflow plan example has invalid execution topology."); },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await assert.rejects(f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx), /invalid execution topology/);
	assert.equal(f.widget(), undefined);
	assert.equal(f.entries.length, 0);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("background step failure pauses instead of retrying unchanged state", async () => {
	const f = fixture();
	let runs = 0;
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Test", status: "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { runs++; throw new Error("broken"); }, async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runs, 1);
	assert.ok(f.entries.some((entry) => (entry.data as any).state === "paused"));
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
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 550));
	assert.equal(f.entries.some((entry) => (entry.data as any).state === "paused"), false);
	releaseFirst();
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(secondDone, true, "runner advances to the next ready step without orchestrator intervention");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("background spawning delegates a role and prompt and later emits a lifecycle message", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let request: any;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async spawnSubagent(input) { request = input; await gate; return { ref: "agent:one", agentId: "one", state: "completed", summary: "Background critic completed." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; },
		async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const spawned = await f.tools.get("subagent_spawn").execute("call", { agent: "plan-critic", task: "Review it" }, undefined, undefined, f.ctx);
	assert.match(spawned.content[0].text, /Spawned plan-critic in background/);
	assert.deepEqual({ operationId: request.operationId, agent: request.agent, task: request.task }, { operationId: "call", agent: "plan-critic", task: "Review it" });
	assert.equal(f.messages.some((entry) => String(entry.message.content).includes("completed")), false);
	release();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(f.messages.some((entry) => String(entry.message.content).includes("Background critic completed")), true);
	assert.equal(f.messages.find((entry) => String(entry.message.content).includes("Background critic completed"))?.message.display, false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("foreground spawning waits for the delegated subagent result", async () => {
	const f = fixture();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => false,
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async spawnSubagent(request) { return { ref: "agent:critic", agentId: "critic", state: "completed", summary: `${request.agent}: ready` }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const settled = await f.tools.get("subagent_spawn").execute("call", { agent: "plan-critic", task: "Review", mode: "foreground" }, undefined, undefined, f.ctx);
	assert.equal(settled.content[0].text, "plan-critic: ready");
	assert.equal(settled.details.agentId, "critic");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("running step kinds use distinct icons without redundant state labels", async () => {
	const f = fixture();
	const snapshot: WorkflowSnapshot = {
		ref: "test:workflow", title: "Active states", status: "running",
		steps: [
			{ ref: "test:task", title: "Implement", kind: "task", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [] },
			{ ref: "test:merge", title: "Merge", kind: "merge", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [] },
			{ ref: "test:evaluation", title: "Evaluate", kind: "evaluation", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [] },
		],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 10));
	const widget = f.widget() as ((...args: any[]) => any);
	const rendered = widget?.({}, f.ctx.ui.theme).render(70) as string[];
	assert.equal(rendered.some((line) => /\b(running|merging)\b/.test(line)), false);
	const icons = rendered.slice(1).map((line) => line.trimStart()[0]);
	assert.equal(new Set(icons).size, 3, "task, merge, and evaluation activity have distinct animated icon families");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("workflow runner derives ready steps from refreshed adapter snapshots and renders the widget", async () => {
	const f = fixture();
	let taskDone = false;
	const snapshots = (): WorkflowSnapshot => ({
		ref: "test:workflow", title: "Example", status: taskDone ? "done" : "ready",
		steps: [{ ref: "test:task", title: "Implement example", kind: "task", status: taskDone ? "done" : "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }],
	});
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async completionPrompt() { return "Read outcome.md and brief the user."; }, async snapshot() { return snapshots(); },
		async runStep(ref) { taskDone = true; return { ref, state: "completed", summary: "Implementation done." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; },
		async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const started = await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	assert.match(started.content[0].text, /Started workflow/);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(taskDone, true);
	assert.ok(f.widget());
	assert.equal(f.entries.some((entry) => entry.data.ref === "test:workflow"), true);
	const completion = f.messages.find((entry) => entry.message.customType === "pibox-workflow-complete");
	assert.equal(completion?.message.display, false);
	assert.equal(completion?.options.triggerTurn, true);
	assert.match(completion?.message.content ?? "", /outcome\.md.*brief the user/i);
	const widget = f.widget() as ((...args: any[]) => any);
	const component = widget?.({}, f.ctx.ui.theme);
	const rendered = component.render(100) as string[];
	assert.ok(rendered.every((line: string) => line.startsWith(" ") && line.endsWith(" ")));
	assert.ok(rendered.every((line: string) => line.includes(" │ ")), "wide dashboards visibly separate tasks from workflow events");
	assert.ok(rendered.every((line: string) => line.indexOf(" │ ") < 65), "the event pane starts near the task content instead of at the far right");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});
