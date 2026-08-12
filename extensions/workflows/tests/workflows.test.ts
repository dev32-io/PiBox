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
			theme: { fg: (_c: string, text: string) => text, bold: (text: string) => text },
			setWidget(_id: string, value: unknown) { widget = value; },
		},
		sessionManager: { getEntries: () => entries },
	};
	return { pi, tools, handlers, messages, entries, ctx, widget: () => widget };
}

test("registers the generalized workflow and subagent surface", () => {
	const f = fixture();
	assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control", "subagent_spawn", "subagent_status", "subagent_control", "subagent_respond"]);
	assert.match(f.tools.get("subagent_spawn").description, /Background is the default/);
	assert.match(f.tools.get("workflow_control").description, /Stop terminates active attempts.*resume prepares incomplete stopped work/);
});

test("failed workflow start returns an error and leaves no dashboard", async () => {
	const f = fixture();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() { throw new Error("Workflow plan example is not approved. Use /harness approve example to approve the workflow plan first."); },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await assert.rejects(f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx), /\/harness approve example/);
	assert.equal(f.widget(), undefined);
	assert.equal(f.entries.length, 0);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("background spawning returns immediately and later emits a lifecycle message", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { await gate; return { ref, state: "completed", summary: "Background step completed." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; },
		async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const spawned = await f.tools.get("subagent_spawn").execute("call", { ref: "test:step" }, undefined, undefined, f.ctx);
	assert.match(spawned.content[0].text, /Spawned test:step in background/);
	assert.equal(f.messages.some((entry) => String(entry.message.content).includes("completed")), false);
	release();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(f.messages.some((entry) => String(entry.message.content).includes("Background step completed")), true);
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
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshots(); },
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
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});
