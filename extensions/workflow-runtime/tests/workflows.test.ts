import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflows from "../index.js";
import { inferDynamicSubagentTier, WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_FEEDBACK_EVENT, type WorkflowAdapter, type WorkflowFeedbackEvent, type WorkflowRunResult, type WorkflowSnapshot } from "../api.js";
import { installPermissionRuntime } from "../../permissions/runtime.js";

function fixture(workflowConfirmed = true) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, (...args: any[]) => any>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const messages: any[] = [];
	const entries: any[] = [];
	let widget: unknown;
	const statuses = new Map<string, string>();
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
			setStatus(id: string, value: string | undefined) { if (value === undefined) statuses.delete(id); else statuses.set(id, value); },
		},
		sessionManager: { getEntries: () => entries, getSessionId: () => "test-session" },
	};
	return { pi, tools, handlers, messages, entries, ctx, statuses, widget: () => widget, permissionMode: () => permissionMode };
}

test("infers local routing only for an explicit local-llm provider", () => {
	assert.equal(inferDynamicSubagentTier(undefined, "local-llm/qwen3.8-27b-uncensored#medium"), "local");
	assert.equal(inferDynamicSubagentTier(undefined, "openai-codex/gpt-5.6-luna"), "medium");
	assert.equal(inferDynamicSubagentTier(undefined, undefined), "medium");
	assert.equal(inferDynamicSubagentTier("high", "local-llm/qwen3.8-27b-uncensored"), "high");
});

test("registers the generalized workflow and subagent surface", async () => {
	const f = fixture();
	await f.handlers.get("session_start")?.({}, f.ctx);
	assert.deepEqual([...f.tools.keys()], ["workflow_start", "workflow_control", "workflow_checkpoint", "subagent_status", "subagent_control", "subagent_respond", "subagent_spawn"]);
	assert.match(f.tools.get("subagent_spawn").description, /subagent.*configured agent definition.*complete task prompt.*Background is the default/i);
	assert.match(JSON.stringify(f.tools.get("subagent_spawn").parameters), /agent.*task.*background.*foreground/);
	const spawnSchema = JSON.stringify(f.tools.get("subagent_spawn").parameters);
	assert.match(spawnSchema, /tier.*local.*model.*effort/);
	assert.doesNotMatch(spawnSchema, /tierJustification|strict/);
	assert.match(f.tools.get("workflow_start").description, /user explicitly asks to run.*TUI confirmation.*permission bypass mode/i);
	assert.match(f.tools.get("workflow_control").description, /Stop terminates active attempts.*resume prepares incomplete stopped work/);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("refreshes subagent_spawn with the adapter's validated agent catalog", async () => {
	const f = fixture();
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => false,
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async spawnSubagent(request) { return { ref: `agent:${request.agent}`, state: "completed", summary: "done" }; },
		async listSpawnableAgents() { return [{ name: "project-scout", description: "Project-specific reconnaissance", tier: "low", source: "project" }]; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	assert.match(f.tools.get("subagent_spawn").description, /project-scout \(project, low\).*Project-specific reconnaissance/);
	assert.match(JSON.stringify(f.tools.get("subagent_spawn").parameters), /Available agents: project-scout/);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
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

test("workflow start requires extension-owned bypass confirmation before adapter preparation", async () => {
	const f = fixture(false);
	let prepared = false;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async prepareWorkflow() { prepared = true; },
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const outcome = await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	assert.equal(prepared, false);
	assert.equal(f.permissionMode(), "enforce");
	assert.match(outcome.content[0].text, /cancelled/i);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("session restore establishes durable ownership before ticking a legacy running workflow", async () => {
	const f = fixture();
	f.entries.push({ type: "custom", customType: "pibox-workflow", data: { ref: "test:workflow", state: "running" } });
	const controls: string[] = [];
	let owned = false;
	let snapshots = 0;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async controlExecution(_ref, command) { controls.push(command); owned = true; return { workflowRef: "test:workflow", mode: "running", generation: 1, ownerSessionId: "session" }; },
		async snapshot(ref) { assert.equal(owned, true, "restore must establish a fence before its first snapshot/tick"); snapshots++; return { ref, title: "Restored", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	assert.deepEqual(controls, ["resume"]);
	assert.ok(snapshots > 0);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("late failed settlement after stop is inert", async () => {
	const f = fixture();
	let rejectRun!: (error: Error) => void;
	let runs = 0;
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Test", status: "ready", steps: [{ ref: "test:step", title: "Step", kind: "test", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { runs++; return new Promise<never>((_resolve, reject) => { rejectRun = reject; }); }, async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
		async runStep() { runs++; return new Promise((resolve) => { resolveRun = () => resolve({ ref: "test:step", state: "completed", summary: "late success" }); }); }, async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
	assert.equal(f.permissionMode(), "bypass");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(runs, 1);
	assert.ok(f.entries.some((entry) => (entry.data as any).state === "paused"));
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("does not emit completion feedback when a task contribution completes before merge", async () => {
	const f = fixture();
	let done = false;
	const feedback: WorkflowFeedbackEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() {
			return { ref: "test:workflow", title: "Feedback", status: done ? "done" : "ready", steps: [{ ref: "test:task", title: "Implement feedback", kind: "task", status: done ? "done" : "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }] };
		},
		async runStep(ref) { done = true; return { ref, state: "completed", summary: "Contribution completed." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_FEEDBACK_EVENT, (event: unknown) => feedback.push(event as WorkflowFeedbackEvent));
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(feedback, []);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("emits one completion feedback after a merge settles", async () => {
	const f = fixture();
	let done = false;
	const feedback: WorkflowFeedbackEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() { return { ref: "test:workflow", title: "Merge", status: done ? "done" : "ready", steps: [{ ref: "test:merge", title: "Merge task", kind: "merge", status: done ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { done = true; return { ref, state: "completed", summary: "Merged." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_FEEDBACK_EVENT, (event: unknown) => feedback.push(event as WorkflowFeedbackEvent));
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(feedback.filter((event) => event.type === "task-completed").length, 1);
	assert.equal(feedback.find((event) => event.type === "task-completed")?.toStatus, "merged");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("a completed review wakes the main session and emits success feedback", async () => {
	const f = fixture();
	let done = false;
	const feedback: WorkflowFeedbackEvent[] = [];
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot() { return { ref: "test:workflow", title: "Review boundary", status: done ? "done" : "ready", steps: [{ ref: "test:evaluation", title: "Stage review", kind: "evaluation", status: done ? "done" : "ready", dependsOn: [], parallelism: "serial", resourceClaims: [] }] }; },
		async runStep(ref) { done = true; return { ref, state: "completed", summary: "Review passed." }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_FEEDBACK_EVENT, (event: unknown) => feedback.push(event as WorkflowFeedbackEvent));
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(feedback.filter((event) => event.type === "task-completed" && event.toStatus === "approved").length, 1);
	assert.equal(f.messages.filter(({ message, options }) => (message as any).customType === "pibox-workflow-event" && (options as any).deliverAs === "followUp" && (options as any).triggerTurn === true).length, 1);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("emits workflow error feedback when a step pauses for attention", async () => {
	const f = fixture();
	const feedback: WorkflowFeedbackEvent[] = [];
	const snapshot: WorkflowSnapshot = { ref: "test:workflow", title: "Feedback", status: "ready", steps: [{ ref: "test:task", title: "Blocked feedback", kind: "task", status: "ready", dependsOn: [], parallelism: "allowed", resourceClaims: [] }] };
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep(ref) { return { ref, state: "blocked", summary: "Needs user attention.", attention: true }; },
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_FEEDBACK_EVENT, (event: unknown) => feedback.push(event as WorkflowFeedbackEvent));
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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

test("background spawning returns its report to the main agent and shows running status", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let request: any;
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"),
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async spawnSubagent(input, _ctx, _signal, _onText, onStarted, onProgress) {
			request = input;
			const startedAt = new Date().toISOString();
			onStarted?.({ agentId: "one", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", startedAt });
			onProgress?.({ startedAt, lastEventAt: startedAt, turns: 2, toolCalls: 3, toolErrors: 0, outputTokens: 1234, reasoningTokens: 50 });
			await gate;
			return { ref: "agent:one", agentId: "one", state: "completed", summary: "Background critic completed." };
		},
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; },
		async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const spawned = await f.tools.get("subagent_spawn").execute("call", { agent: "plan-critic", task: "Review it", tier: "high", model: "gpt-5.6-sol", effort: "high" }, undefined, undefined, f.ctx);
	assert.match(spawned.content[0].text, /Spawned plan-critic in background/);
	assert.deepEqual({ operationId: request.operationId, agent: request.agent, task: request.task, model: request.model, effort: request.effort }, { operationId: "call", agent: "plan-critic", task: "Review it", model: "gpt-5.6-sol", effort: "high" });
	assert.match(f.statuses.get("subagent-dashboard") ?? "", /plan-critic High \(openai-codex\/gpt-5\.6-sol#high\) · \d+s · 2 turns · 3 tools · ↓ 1\.2k · active/);
	assert.doesNotMatch(f.statuses.get("subagent-dashboard") ?? "", /background/);
	assert.equal(f.messages.some((entry) => String(entry.message.content).includes("Background critic completed")), false);
	release();
	await new Promise((resolve) => setTimeout(resolve, 20));
	const completion = f.messages.find((entry) => String(entry.message.content).includes("Background critic completed"));
	assert.equal(completion?.message.customType, "pibox-subagent-result");
	assert.equal(completion?.message.display, false);
	assert.equal(completion?.options.deliverAs, "followUp");
	assert.equal(completion?.options.triggerTurn, true);
	assert.match(completion?.message.content ?? "", /Respond to the user now/);
	assert.equal(f.statuses.has("subagent-dashboard"), false);
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("foreground spawning waits for the delegated result without using the background footer", async () => {
	const f = fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: () => false,
		async snapshot(ref) { return { ref, title: "Test", status: "ready", steps: [] }; },
		async runStep(ref) { return { ref, state: "completed", summary: "unused" }; },
		async spawnSubagent(request, _ctx, _signal, _onText, onStarted, onProgress) {
			const startedAt = new Date().toISOString();
			onStarted?.({ agentId: "critic", provider: "openai-codex", model: "gpt-5.6-luna", effort: "max", startedAt });
			onProgress?.({ startedAt, lastEventAt: startedAt, turns: 1, toolCalls: 2, toolErrors: 0, outputTokens: 800, reasoningTokens: 10 });
			await gate;
			return { ref: "agent:critic", agentId: "critic", state: "completed", summary: `${request.agent}: ready` };
		},
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const updates: any[] = [];
	const pending = f.tools.get("subagent_spawn").execute("call", { agent: "plan-critic", task: "Review", mode: "foreground", tier: "medium" }, undefined, (update: any) => updates.push(update), f.ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(f.statuses.has("subagent-dashboard"), false);
	assert.deepEqual(
		{ agent: updates.at(-1)?.details.agent, tier: updates.at(-1)?.details.tier, provider: updates.at(-1)?.details.resolved?.provider, model: updates.at(-1)?.details.resolved?.model, effort: updates.at(-1)?.details.resolved?.effort },
		{ agent: "plan-critic", tier: "medium", provider: "openai-codex", model: "gpt-5.6-luna", effort: "max" },
	);
	assert.equal(updates.at(-1)?.details.progress.outputTokens, 800);
	release();
	const settled = await pending;
	assert.equal(settled.content[0].text, "plan-critic: ready");
	assert.equal(settled.details.agentId, "critic");
	assert.equal(f.statuses.has("subagent-dashboard"), false);
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
		async controlWorkflow() {}, async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
			{ ref: "test:task", title: "Implement", kind: "task", status: "running", dependsOn: [], parallelism: "allowed", resourceClaims: [], progress: { startedAt: new Date(Date.now() - 61_000).toISOString(), lastEventAt: new Date().toISOString(), turns: 3, toolCalls: 4, toolErrors: 0, outputTokens: 1450, reasoningTokens: 22 } },
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
	let invalidations = 0;
	const rendered = widget?.({ requestRender: () => { invalidations++; } }, f.ctx.ui.theme).render(120) as string[];
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.ok(invalidations > 0, "fast visual timer requests real TUI redraws");
	assert.equal(rendered.some((line) => /\b(running|merging)\b/.test(line)), false);
	assert.equal(rendered.some((line) => line.includes("↓ 1.5k")), true);
	assert.equal(rendered.some((line) => /\bout\b/i.test(line)), false);
	const icons = rendered.slice(1).map((line) => line.trimStart()[0]);
	assert.equal(new Set(icons).size, 3, "task, merge, and evaluation activity have distinct animated icon families");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("an in-flight ready step animates immediately before the adapter reports running", async () => {
	const f = fixture();
	const neverSettles = new Promise<WorkflowRunResult>(() => undefined);
	const progress = { startedAt: new Date().toISOString(), lastEventAt: new Date().toISOString(), turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 };
	const snapshot: WorkflowSnapshot = {
		ref: "test:workflow", title: "Starting implementation", status: "ready",
		steps: [{ ref: "test:workflow/task:one", title: "Build the feature", kind: "task", status: "ready", dependsOn: [], parallelism: "serial", resourceClaims: [], progress }],
		stages: [{ id: "delivery", index: 0, nodes: ["task:one"], parallel: false, group: "planner" }],
	};
	const adapter: WorkflowAdapter = {
		id: "test", canHandle: (ref) => ref.startsWith("test:"), async snapshot() { return snapshot; },
		async runStep() { return neverSettles; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() { return {}; }, async respondSubagent() { return {}; },
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:workflow" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const widget = f.widget() as ((...args: any[]) => any);
	const rendered = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	const activeLines = rendered.filter((line) => line.includes("Implementing"));
	assert.equal(activeLines.length, 2, "stage and task both render as implementing");
	assert.ok(activeLines.every((line) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)), "in-flight ready state uses animated task frames instead of a static ready diamond");
	assert.ok(activeLines.every((line) => !line.includes("◆")));
	const firstDivider = rendered[0]!.indexOf("│");
	progress.turns = 12; progress.toolCalls = 34; progress.outputTokens = 152_000; progress.lastEventAt = new Date(Date.now() - 45_000).toISOString();
	const updated = widget?.({}, f.ctx.ui.theme).render(100) as string[];
	assert.ok(firstDivider > 0, "wide layout shows the event pane");
	assert.equal(updated[0]!.indexOf("│"), firstDivider, "volatile progress does not move the responsive pane divider");
	await f.handlers.get("session_shutdown")?.({}, f.ctx);
});

test("renders durable integration and verification phases instead of generic ready-to-merge labels", async () => {
	const f = fixture();
	f.entries.push({ type: "custom", customType: "pibox-workflow", data: { ref: "work-item:calendar", state: "paused" } });
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
		async snapshot() { return snapshot; }, async runStep(ref) { return { ref, state: "completed", summary: "unused" }; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(120) as string[];
	assert.ok(rendered.some((line) => line.includes("Verification failed") && line.includes("2 tasks")));
	assert.ok(rendered.some((line) => line.includes("⚠ Verification failed · Android calendar")));
	assert.ok(rendered.some((line) => line.includes("◆ Contribution ready · iOS calendar")));
	assert.equal(rendered.some((line) => line.includes("Ready to merge")), false);
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
		id: "test", canHandle: (ref) => ref.startsWith("work-item:"), async snapshot() { return snapshot; }, async runStep() { return neverSettles; }, async controlWorkflow() {},
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "work-item:calendar" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = (f.widget() as any)?.({}, f.ctx.ui.theme).render(120) as string[];
	const verifying = rendered.filter((line) => line.includes("Verifying candidate"));
	assert.equal(verifying.length, 2);
	assert.ok(verifying.every((line) => /[◐◓◑◒]/.test(line)));
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
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
	await f.handlers.get("session_start")?.({}, f.ctx);
	await f.tools.get("workflow_start").execute("call", { ref: "test:coalesced" }, undefined, undefined, f.ctx);
	refreshing = true;
	lifecycle!();
	await enteredRefresh;
	lifecycle!(); lifecycle!();
	release();
	await completedFollowUp;
	assert.equal(snapshots, 3, "initial snapshot and exactly one coalesced refresh after the in-flight startup tick");
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
		async listSubagents() { return []; }, async listMessages() { return []; }, async controlSubagent() {}, async respondSubagent() {},
	};
	f.pi.events.on(WORKFLOW_ADAPTER_DISCOVERY_EVENT, (event: any) => event.register(adapter));
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
