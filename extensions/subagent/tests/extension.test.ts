import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import subagentExtension, { STANDALONE_SUBAGENT_TOOL_NAMES, type SubagentExtensionDependencies } from "../index.js";
import type {
	ContinuationSpec,
	LaunchSpec,
	LogicalAgentHandle,
	LogicalAgentSnapshot,
	RuntimeOwner,
	SubagentEvent,
	SubagentEventListener,
	SubagentReplay,
	SubagentService,
	SubagentSubscription,
	TerminalResult,
	TerminalStatus,
} from "../api.js";
import { MODEL_TIER_PROFILE_EVENT } from "../../model-tier-list-profiles/policy.js";
import { BUILT_IN_AGENT_ROOT, DEFAULT_SUBAGENT_CATALOG_CONFIG } from "../catalog.js";
import { STANDALONE_CHILD_EXTENSION_PATHS } from "../child-extensions.js";
import { SubagentCapabilityRegistry } from "../registry.js";
import { PendingSubagentDeliveryRegistry } from "../pending-deliveries.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../tool-policy.js";
import { SubagentUiProjectionRegistry } from "../ui-projection.js";

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(message);
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

class FakeService implements SubagentService {
	readonly protocolVersion = 1;
	readonly snapshots = new Map<string, LogicalAgentSnapshot>();
	readonly listeners = new Set<SubagentEventListener>();
	readonly launches: LaunchSpec[] = [];
	readonly continuations: ContinuationSpec[] = [];
	readonly stops: string[] = [];
	teardownCount = 0;
	private readonly attempts = new Map<string, Deferred<TerminalResult>>();
	private readonly terminals = new Map<string, TerminalResult>();
	private cursor = 0;
	private id = 0;
	continuationStartGate: Promise<void> | undefined;
	readonly continuationSpawned = deferred<void>();

	constructor(readonly owner: RuntimeOwner) {}

	async launch(spec: LaunchSpec) {
		this.launches.push(spec);
		const agentId = `agent-${++this.id}`;
		const handle = this.handle(agentId, `cap-${this.id}`);
		const attemptId = `attempt-${this.id}`;
		const now = new Date().toISOString();
		this.snapshots.set(agentId, {
			handle, agent: spec.agent, state: "running", attemptId,
			provider: spec.provider, model: spec.model, effort: spec.effort, fast: spec.fast,
			startedAt: now, updatedAt: now,
			progress: { startedAt: now, processStartedAt: now, lastEventAt: now, turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
		});
		const pending = deferred<TerminalResult>();
		this.attempts.set(agentId, pending);
		this.emit(agentId, attemptId, "attempt_started");
		return { handle, result: pending.promise };
	}

	async continue(spec: ContinuationSpec) {
		this.continuations.push(spec);
		const current = this.snapshots.get(spec.handle.agentId);
		if (!current || current.handle.continuationCapability !== spec.handle.continuationCapability) throw new Error("stale handle");
		const attemptId = `attempt-${++this.id}`;
		const now = new Date().toISOString();
		this.snapshots.set(spec.handle.agentId, { ...current, state: "running", attemptId, startedAt: now, updatedAt: now });
		const pending = deferred<TerminalResult>();
		this.attempts.set(spec.handle.agentId, pending);
		this.emit(spec.handle.agentId, attemptId, "attempt_started");
		this.continuationSpawned.resolve(undefined);
		await this.continuationStartGate;
		return { handle: spec.handle, result: pending.promise };
	}

	async wait(_owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<TerminalResult> {
		const pending = this.attempts.get(handle.agentId);
		if (pending) return pending.promise;
		const terminal = this.terminals.get(handle.agentId);
		if (!terminal) throw new Error("unknown handle");
		return terminal;
	}

	inspect(_owner: RuntimeOwner): readonly LogicalAgentSnapshot[] {
		return [...this.snapshots.values()].map((agent) => structuredClone(agent));
	}

	async stop(_owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		this.stops.push(handle.agentId);
		this.finish(handle.agentId, "cancelled", "stopped");
	}

	async release(_owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void> {
		const snapshot = this.snapshots.get(handle.agentId);
		if (!snapshot || ["launching", "running", "stopping"].includes(snapshot.state)) throw new Error("unknown or active handle");
		this.snapshots.delete(handle.agentId);
		this.terminals.delete(handle.agentId);
	}

	replay(_owner: RuntimeOwner): SubagentReplay {
		return { snapshot: { owner: this.owner, cursor: this.cursor, agents: [...this.snapshots.values()].map((agent) => structuredClone(agent)) }, events: [], reset: false };
	}

	subscribe(_owner: RuntimeOwner, _afterCursor: number, listener: SubagentEventListener): SubagentSubscription {
		this.listeners.add(listener);
		return { initial: this.replay(this.owner), unsubscribe: () => this.listeners.delete(listener) };
	}

	teardown(): void {
		this.teardownCount++;
		for (const [agentId, snapshot] of this.snapshots) if (["launching", "running", "stopping"].includes(snapshot.state)) this.finish(agentId, "cancelled", "owner ended");
		this.listeners.clear();
	}

	activity(agentId: string): void {
		const snapshot = this.snapshots.get(agentId)!;
		const progress = { ...snapshot.progress!, turns: 1, toolCalls: 2, cacheReadTokens: 120, cacheWriteTokens: 30, activeTool: "read", lastEventAt: new Date().toISOString() };
		this.snapshots.set(agentId, { ...snapshot, progress, updatedAt: progress.lastEventAt });
		this.emit(agentId, snapshot.attemptId!, "usage");
	}

	finish(agentId: string, status: TerminalStatus = "completed", text = "done"): void {
		const snapshot = this.snapshots.get(agentId);
		const pending = this.attempts.get(agentId);
		if (!snapshot || !pending) return;
		const handle = this.handle(agentId, `cap-${++this.id}`);
		const now = new Date().toISOString();
		this.snapshots.set(agentId, { ...snapshot, handle, state: status, updatedAt: now, summary: text });
		this.emit(agentId, snapshot.attemptId!, "terminal", { status });
		this.attempts.delete(agentId);
		const terminal = { owner: this.owner, handle, attemptId: snapshot.attemptId!, status, exitCode: status === "completed" ? 0 : null, text } as TerminalResult;
		this.terminals.set(agentId, terminal);
		pending.resolve(terminal);
	}

	private handle(agentId: string, continuationCapability: string): LogicalAgentHandle {
		return { owner: this.owner, agentId, continuationCapability };
	}

	private emit(agentId: string, attemptId: string, type: SubagentEvent["type"], data?: Record<string, unknown>): void {
		const event: SubagentEvent = { owner: this.owner, cursor: ++this.cursor, agentId, attemptId, sequence: this.cursor, type, at: new Date().toISOString(), ...(data ? { data } : {}) };
		for (const listener of this.listeners) listener(event);
	}
}

function model(provider = "openai-codex", id = "gpt-5.6-sol"): Model<Api> {
	return { provider, id, reasoning: true, api: "openai-codex-responses" } as unknown as Model<Api>;
}

function catalog() {
	const config = structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG);
	config.agents = {
		"general-purpose": {
			description: "General",
			prompt: `${BUILT_IN_AGENT_ROOT}/general-purpose.md`,
			tier: "medium",
			tools: ["*"],
		},
	};
	return { config, digest: "test", sources: ["test"], diagnostics: [] };
}

function harness(options: {
	registry?: SubagentCapabilityRegistry;
	uiRegistry?: SubagentUiProjectionRegistry;
	pendingDeliveries?: PendingSubagentDeliveryRegistry;
	processInstanceId?: string;
	env?: NodeJS.ProcessEnv;
	sessionId?: string;
	trusted?: boolean;
	availableModels?: Model<Api>[];
	scopedModels?: Array<{ model: Model<Api> }>;
	loadCatalog?: SubagentExtensionDependencies["loadCatalog"];
} = {}) {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const bus = new Map<string, Array<(value: unknown) => void>>();
	const sent: any[] = [];
	const notices: string[] = [];
	const services: FakeService[] = [];
	const catalogOptions: any[] = [];
	let sessionId = options.sessionId ?? "session-1";
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (value: unknown) => void) { bus.set(name, [...(bus.get(name) ?? []), handler]); },
			emit(name: string, value: unknown) { for (const handler of bus.get(name) ?? []) handler(value); },
		},
		getAllTools() { return [...tools.values()].map((tool) => ({ name: tool.name })); },
		sendMessage(message: unknown, delivery: unknown) { sent.push({ message, delivery }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: { getAvailable: () => options.availableModels ?? [model()] },
		scopedModels: options.scopedModels ?? [],
		ui: { notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionContext;
	const dependencies: SubagentExtensionDependencies = {
		env: options.env ?? {},
		registry: options.registry ?? new SubagentCapabilityRegistry(),
		uiRegistry: options.uiRegistry ?? new SubagentUiProjectionRegistry(),
		pendingDeliveries: options.pendingDeliveries ?? new PendingSubagentDeliveryRegistry(0),
		processInstanceId: options.processInstanceId ?? "process-1",
		idFactory: () => randomUUID(),
		loadCatalog: options.loadCatalog ?? ((_root, loadOptions) => { catalogOptions.push(loadOptions); return catalog(); }),
		createService(owner) { const service = new FakeService(owner); services.push(service); return service; },
	};
	subagentExtension(pi, dependencies);
	const fire = async (name: string, event: unknown = {}) => {
		let returned: unknown;
		for (const handler of handlers.get(name) ?? []) returned = await handler(event, ctx) ?? returned;
		return returned;
	};
	return { pi, ctx, tools, handlers, sent, notices, services, catalogOptions, dependencies, fire, setSessionId(value: string) { sessionId = value; } };
}

async function settleForeground(f: ReturnType<typeof harness>, operation: Promise<any>, text = "done") {
	await new Promise((resolve) => setImmediate(resolve));
	const service = f.services.at(-1)!;
	const agentId = [...service.snapshots.keys()].at(-1)!;
	service.finish(agentId, "completed", text);
	return { agentId, result: await operation };
}

test("runtime role alone selects the standalone main or child surface", () => {
	for (const env of [{}, { PIBOX_SUBAGENT_ID: "managed-identity-only" }]) {
		const main = harness({ env: env as NodeJS.ProcessEnv });
		assert.deepEqual([...main.tools.keys()], STANDALONE_SUBAGENT_TOOL_NAMES);
	}
	const child = harness({ env: { [PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE } as NodeJS.ProcessEnv });
	assert.deepEqual([...child.tools.keys()], []);
	assert.equal(child.handlers.size, 0);
});

test("loads trusted catalog policy, resolves the active tier profile, prompt, route, tools, and foreground updates", async () => {
	const f = harness({ trusted: true });
	f.pi.events.emit(MODEL_TIER_PROFILE_EVENT, { profile: "token-conservative" });
	await f.fire("session_start", { reason: "startup" });
	const updates: any[] = [];
	const pending = f.tools.get("subagent_spawn").execute("call", { agent: "general-purpose", task: "Inspect the bounded surface" }, undefined, (update: any) => updates.push(update), f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const service = f.services[0]!;
	const agentId = [...service.snapshots.keys()][0]!;
	service.activity(agentId);
	service.finish(agentId, "completed", "foreground report");
	const settled = await pending;
	assert.equal(settled.content[0].text, "foreground report");
	assert.ok(updates.length >= 2);
	assert.equal(f.catalogOptions[0].includeProject, true);
	assert.equal(f.catalogOptions[0].modelTierProfile, "token-conservative");
	assert.equal(service.launches[0]?.stableSystemContext.includes("General-Purpose Agent"), true);
	assert.deepEqual(service.launches[0]?.tools, ["*"]);
	assert.equal(service.launches[0]?.model, "gpt-5.6-sol");
	assert.deepEqual(service.launches[0]?.extensionPaths, [...STANDALONE_CHILD_EXTENSION_PATHS]);
	assert.deepEqual(service.launches[0]?.extensionPaths.map((path) => path.match(/extensions\/([^/]+)\/index\.ts$/)?.[1]), ["memory-adapter", "distill", "fast-mode"]);
	assert.equal(service.launches[0]?.extensionPaths.some((path) => /workflow\/index\.ts$/.test(path)), false);
});

test("background returns immediately and steers one terminal batch to the same binding", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const spawned = await f.tools.get("subagent_spawn").execute("call", { agent: "general-purpose", task: "Background work", mode: "background" }, undefined, undefined, f.ctx);
	assert.match(spawned.content[0].text, /background as agent-1/);
	assert.match(spawned.content[0].text, /Do not sleep or poll/);
	assert.deepEqual(spawned.details.uiRef, { owner: f.services[0]!.owner, agentId: "agent-1" }, "the immutable launch receipt carries an owner-fenced UI correlation, not mutable lifecycle state");
	f.services[0]!.finish("agent-1", "completed", "background report");
	await waitUntil(() => f.sent.length === 1, "background completion was not delivered");
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /background report/);
	assert.deepEqual(f.sent[0].delivery, { deliverAs: "steer", triggerTurn: true });
});

test("near-simultaneous background settlements are steered in one message", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("one", { agent: "general-purpose", task: "One", mode: "background" }, undefined, undefined, f.ctx);
	await f.tools.get("subagent_spawn").execute("two", { agent: "general-purpose", task: "Two", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish("agent-1", "completed", "first report");
	f.services[0]!.finish("agent-2", "completed", "second report");
	await waitUntil(() => f.sent.length === 1, "background completion batch was not delivered");
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /first report/);
	assert.match(f.sent[0].message.content, /second report/);
	assert.equal(f.sent[0].message.details.settlements.length, 2);
});

test("large completion sets are chunked without consuming model-invisible settlements", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	for (let index = 1; index <= 10; index++) {
		await f.tools.get("subagent_spawn").execute(`spawn-${index}`, { agent: "general-purpose", task: `Task ${index}`, mode: "background" }, undefined, undefined, f.ctx);
	}
	for (let index = 1; index <= 10; index++) {
		f.services[0]!.finish(`agent-${index}`, "completed", `report-${index}-${"x".repeat(2_000)}`);
	}
	await waitUntil(() => f.sent.length === 2, "chunked background completions were not delivered");
	assert.equal(f.sent.length, 2);
	const delivered = f.sent.map((entry) => entry.message.content).join("\n");
	for (let index = 1; index <= 10; index++) assert.match(delivered, new RegExp(`report-${index}-`));
	assert.ok(f.sent.every((entry) => Buffer.byteLength(entry.message.content, "utf8") < 48 * 1024));
});

test("wait supports elapsed time and abort without shell sleep", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const elapsed = await f.tools.get("wait").execute("time", { durationMs: 1 }, undefined, undefined, f.ctx);
	assert.equal(elapsed.content[0].text, "Waited 1 ms.");
	assert.deepEqual(elapsed.details, { kind: "time", durationMs: 1 });

	const controller = new AbortController();
	const waiting = f.tools.get("wait").execute("abort", { durationMs: 60_000 }, controller.signal, undefined, f.ctx);
	controller.abort(new Error("cancel wait"));
	await assert.rejects(waiting, /cancel wait/);
});

test("wait subscribes once to background settlement and consumes automatic delivery", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
	const waiting = f.tools.get("wait").execute("wait", { event: "subagent_settled" }, undefined, undefined, f.ctx);
	f.services[0]!.finish("agent-1", "completed", "dependency report");
	const settled = await waiting;
	assert.match(settled.content[0].text, /dependency report/);
	assert.deepEqual(settled.details, {
		kind: "event",
		event: "subagent_settled",
		settlements: [{ agent: "general-purpose", agentId: "agent-1", status: "completed", summary: "dependency report" }],
	});
	assert.equal(f.sent.length, 0, "the wait result is the sole model-visible delivery");
});

test("an aborted event wait consumes nothing and automatic steering remains armed", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
	const controller = new AbortController();
	const waiting = f.tools.get("wait").execute("wait", { event: "subagent_settled" }, controller.signal, undefined, f.ctx);
	controller.abort(new Error("stop waiting"));
	await assert.rejects(waiting, /stop waiting/);
	f.services[0]!.finish("agent-1", "completed", "later report");
	await waitUntil(() => f.sent.length === 1, "completion was not delivered after the event wait aborted");
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /later report/);
});

test("a pre-batch process-global registry falls back to exact-once steering", async () => {
	const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
	Object.defineProperty(pendingDeliveries, "bindBatched", { value: undefined });
	const f = harness({ pendingDeliveries });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Legacy", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish("agent-1", "completed", "legacy report");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /legacy report/);
	assert.deepEqual(f.sent[0].delivery, { deliverAs: "steer", triggerTurn: true });
	assert.equal(pendingDeliveries.count(), 0);
});

test("wait rejects ambiguous calls and event waits without a pending source", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await assert.rejects(f.tools.get("wait").execute("none", {}, undefined, undefined, f.ctx), /exactly one/);
	await assert.rejects(f.tools.get("wait").execute("both", { durationMs: 1, event: "subagent_settled" }, undefined, undefined, f.ctx), /exactly one/);
	await assert.rejects(f.tools.get("wait").execute("event", { event: "subagent_settled" }, undefined, undefined, f.ctx), /No background subagent settlement is pending/);
});

test("subagent tools give explicit no-sleep and no-poll guidance", () => {
	const f = harness();
	assert.match(JSON.stringify(f.tools.get("subagent_spawn")), /Never use bash sleep/);
	assert.match(JSON.stringify(f.tools.get("subagent_status")), /Never call repeatedly/);
	assert.match(JSON.stringify(f.tools.get("wait")), /never as a polling loop/);
});

test("continues only a settled same-activation transcript and rotates its internal handle", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "First" }, undefined, undefined, f.ctx));
	const firstHandle = f.services[0]!.snapshots.get(initial.agentId)!.handle;
	const continuation = f.tools.get("subagent_continue").execute("continue", { agentId: initial.agentId, task: "Second" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.services[0]!.continuations[0]?.handle.continuationCapability, firstHandle.continuationCapability);
	f.services[0]!.finish(initial.agentId, "completed", "second report");
	const settled = await continuation;
	assert.equal(settled.content[0].text, "second report");
	assert.notEqual(f.services[0]!.snapshots.get(initial.agentId)!.handle.continuationCapability, firstHandle.continuationCapability);
});

test("subagent_control exposes stop only and confirms terminal cancellation", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	assert.doesNotMatch(JSON.stringify(f.tools.get("subagent_control").parameters), /pause/);
	const stopped = await f.tools.get("subagent_control").execute("stop", { agentId: "agent-1", action: "stop" }, undefined, undefined, f.ctx);
	assert.match(stopped.content[0].text, /Stop confirmed/);
	assert.deepEqual(f.services[0]!.stops, ["agent-1"]);
	assert.equal(f.services[0]!.snapshots.get("agent-1")?.state, "cancelled");
});

test("reload rebinds the same manager and adopts one pending terminal delivery", async () => {
	const registry = new SubagentCapabilityRegistry();
	const uiRegistry = new SubagentUiProjectionRegistry();
	const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
	const first = harness({ registry, uiRegistry, pendingDeliveries, processInstanceId: "process" });
	await first.fire("session_start", { reason: "startup" });
	await first.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Wait", mode: "background" }, undefined, undefined, first.ctx);
	const service = first.services[0]!;
	const owner = service.owner;
	await first.fire("session_shutdown", { reason: "reload" });
	assert.equal(service.teardownCount, 0);
	service.finish("agent-1", "completed", "late report");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(first.sent.length, 0);

	const second = harness({ registry, uiRegistry, pendingDeliveries, processInstanceId: "process" });
	await second.fire("session_start", { reason: "reload" });
	await waitUntil(() => second.sent.length === 1, "reload did not adopt the pending completion");
	assert.equal(second.services.length, 0, "reload does not construct a replacement manager");
	assert.deepEqual(registry.resolve(owner), service);
	assert.deepEqual(uiRegistry.project()?.owner, owner, "reload reconstructs the structured projection binding");
	assert.equal(second.sent.length, 1, "the reload binding adopts the process-global obligation");
	assert.match(second.sent[0].message.content, /late report/);
	assert.equal(pendingDeliveries.count(owner), 0, "accepted delivery is consumed exactly once");
	await second.fire("session_shutdown", { reason: "quit" });
	assert.equal(service.teardownCount, 1);
});

test("reload with no prior manager starts a fresh activation", async () => {
	const registry = new SubagentCapabilityRegistry();
	const f = harness({ registry, processInstanceId: "process" });
	await f.fire("session_start", { reason: "reload" });
	assert.equal(f.services.length, 1);
	assert.equal(f.services[0]!.owner.sessionId, "session-1");
	assert.equal(f.services[0]!.owner.processInstanceId, "process");
	assert.ok(f.services[0]!.owner.activationId);
	await f.fire("session_shutdown", { reason: "quit" });
	assert.equal(f.services[0]!.teardownCount, 1);
});

test("reload recovers when the process-global registry still has the pre-fallback acquire method", async () => {
	const registry = new SubagentCapabilityRegistry();
	const acquire = registry.acquire.bind(registry);
	let legacyReloadCalls = 0;
	registry.acquire = ((request, create) => {
		if (request.lifecycle === "reload" && legacyReloadCalls++ === 0) {
			return Promise.reject(new Error("Reload has no manager in this session and process to rebind"));
		}
		return acquire(request, create);
	}) as typeof registry.acquire;
	const f = harness({ registry, processInstanceId: "process" });
	await f.fire("session_start", { reason: "reload" });
	assert.equal(legacyReloadCalls, 1);
	assert.equal(f.services.length, 1);
	assert.ok(f.services[0]!.owner.activationId);
	await f.fire("session_shutdown", { reason: "quit" });
});

for (const lifecycle of ["new", "resume", "fork"] as const) {
	test(`${lifecycle} creates a fresh activation and tears down the prior manager`, async () => {
		const registry = new SubagentCapabilityRegistry();
		const first = harness({ registry, processInstanceId: "process", sessionId: "old" });
		await first.fire("session_start", { reason: "startup" });
		const old = first.services[0]!;
		await first.fire("session_shutdown", { reason: lifecycle });
		assert.equal(old.teardownCount, 1);
		const second = harness({ registry, processInstanceId: "process", sessionId: "new" });
		await second.fire("session_start", { reason: lifecycle });
		assert.notEqual(second.services[0]!.owner.activationId, old.owner.activationId);
		assert.equal(second.services[0]!.owner.processInstanceId, old.owner.processInstanceId);
		await second.fire("session_shutdown", { reason: "quit" });
	});
}

test("standalone model resolution treats nonempty scoped models as the complete available set", async () => {
	const f = harness({
		availableModels: [model()],
		scopedModels: [{ model: model("other", "unconfigured") }],
	});
	await f.fire("session_start", { reason: "startup" });
	await assert.rejects(
		f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Scoped" }, undefined, undefined, f.ctx),
		/No configured subagent model is available/,
	);
	assert.equal(f.services[0]!.launches.length, 0);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("an already-aborted continuation is rejected before service spawn", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "First" }, undefined, undefined, f.ctx));
	const controller = new AbortController();
	controller.abort(new Error("cancel before start"));
	await assert.rejects(
		f.tools.get("subagent_continue").execute("continue", { agentId: initial.agentId, task: "Second" }, controller.signal, undefined, f.ctx),
		/cancel before start/,
	);
	assert.equal(f.services[0]!.continuations.length, 0);
});

test("an abort crossing continuation startup stops the atomically returned handle", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "First" }, undefined, undefined, f.ctx));
	const service = f.services[0]!;
	const gate = deferred<void>();
	service.continuationStartGate = gate.promise;
	const controller = new AbortController();
	const continuing = f.tools.get("subagent_continue").execute("continue", { agentId: initial.agentId, task: "Second" }, controller.signal, undefined, f.ctx);
	await service.continuationSpawned.promise;
	controller.abort(new Error("cancel launch race"));
	gate.resolve(undefined);
	const settled = await continuing;
	assert.match(settled.content[0].text, /stopped/);
	assert.deepEqual(service.stops, [initial.agentId]);
});

test("reload catalog failure tears down the rebound manager and pending children", async () => {
	const registry = new SubagentCapabilityRegistry();
	const pendingDeliveries = new PendingSubagentDeliveryRegistry();
	const first = harness({ registry, pendingDeliveries, processInstanceId: "process" });
	await first.fire("session_start", { reason: "startup" });
	await first.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Wait", mode: "background" }, undefined, undefined, first.ctx);
	const service = first.services[0]!;
	await first.fire("session_shutdown", { reason: "reload" });
	const second = harness({
		registry,
		pendingDeliveries,
		processInstanceId: "process",
		loadCatalog() { throw new Error("catalog unavailable"); },
	});
	await assert.rejects(second.fire("session_start", { reason: "reload" }), /catalog unavailable/);
	assert.equal(service.teardownCount, 1);
	assert.equal(registry.resolve(service.owner), undefined);
	assert.equal(pendingDeliveries.count(service.owner), 0);
});

test("replacement-session teardown suppresses stale background completion", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	await f.fire("session_shutdown", { reason: "resume" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.length, 0);
});

test("tree navigation is cancelled only while this activation has active processes", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	assert.equal(await f.fire("session_before_tree"), undefined);
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	assert.deepEqual(await f.fire("session_before_tree"), { cancel: true });
	assert.match(f.notices.at(-1) ?? "", /unavailable while subagents are active/);
	f.services[0]!.finish("agent-1");
	assert.equal(await f.fire("session_before_tree"), undefined);
});
