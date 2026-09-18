import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
import { formatSubagentFooterProjection } from "../display.js";
import { WorkflowSubagentLauncher } from "../../workflow-runtime/subagent-launcher.js";
import { createE2eEvaluation, createE2eWorkspace, readE2eWorkspaceHandoff, retainE2eEvidence, submitE2eWorkspaceReport } from "../../e2e-workspace/workspace.js";

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
			...(spec.title ? { title: spec.title } : {}),
			...(spec.routing ? { routing: structuredClone(spec.routing) } : {}),
			provider: spec.provider, model: spec.model, effort: spec.effort, fast: spec.fast,
			...(spec.continuationKey ? { continuationKey: spec.continuationKey } : {}),
			...(spec.workflowMetadata ? { workflowMetadata: spec.workflowMetadata } : {}),
			...(spec.attemptMetadata ? { attemptMetadata: spec.attemptMetadata } : {}),
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
		this.snapshots.set(spec.handle.agentId, { ...current, state: "running", attemptId, ...(spec.attemptMetadata ? { attemptMetadata: spec.attemptMetadata } : {}), startedAt: now, updatedAt: now });
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

	finish(agentId: string, status: TerminalStatus = "completed", text = "done", reportPath?: string, stderr?: string): void {
		const snapshot = this.snapshots.get(agentId);
		const pending = this.attempts.get(agentId);
		if (!snapshot || !pending) return;
		const handle = this.handle(agentId, `cap-${++this.id}`);
		const now = new Date().toISOString();
		this.snapshots.set(agentId, { ...snapshot, handle, state: status, updatedAt: now, summary: text });
		this.emit(agentId, snapshot.attemptId!, "terminal", { status });
		this.attempts.delete(agentId);
		const terminal = {
			owner: this.owner, handle, attemptId: snapshot.attemptId!, status,
			reason: status === "completed" ? "completed" : status === "cancelled" ? "explicit_stop" : "failure",
			exitCode: status === "completed" ? 0 : null, text,
			...(stderr ? { stderr } : {}),
			...(reportPath ? {
				reportPath,
				reportBytes: Buffer.byteLength(text),
				reportCharacters: Array.from(text).length,
				reportSha256: createHash("sha256").update(text, "utf8").digest("hex"),
			} : {}),
		} as TerminalResult;
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

function model(provider = "openai-codex", id = "gpt-5.6-sol", reasoning = true): Model<Api> {
	return { provider, id, reasoning, api: "openai-codex-responses" } as unknown as Model<Api>;
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

function tierContractCatalog() {
	const loaded = catalog();
	loaded.config.modelTierProfile = "runtime-contract";
	loaded.config.modelTierListProfiles.profiles["runtime-contract"] = {
		low: ["provider/low#off"],
		medium: ["provider/medium#off", "provider/pinned#off"],
		high: ["provider/high#off"],
		max: ["provider/max#off"],
		local: ["local-llm/local#off"],
	};
	const base = loaded.config.agents["general-purpose"]!;
	loaded.config.agents = {
		"low-default": { ...base, tier: "low" },
		"medium-default": { ...base, tier: "medium" },
		"high-default": { ...base, tier: "high" },
		pinned: { ...base, tier: "medium", model: "provider/pinned" },
	};
	return loaded;
}

const TIER_CONTRACT_MODELS = ["low", "medium", "high", "max", "pinned", "replacement"]
	.map((id) => model("provider", id, false));

function harness(options: {
	registry?: SubagentCapabilityRegistry;
	uiRegistry?: SubagentUiProjectionRegistry;
	pendingDeliveries?: PendingSubagentDeliveryRegistry;
	processInstanceId?: string;
	env?: NodeJS.ProcessEnv;
	sessionId?: string;
	trusted?: boolean;
	availableModels?: Model<Api>[];
	refreshedModels?: Model<Api>[];
	scopedModels?: Array<{ model: Model<Api> }>;
	loadCatalog?: SubagentExtensionDependencies["loadCatalog"];
	waitForIdle?: () => Promise<void>;
} = {}) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const bus = new Map<string, Array<(value: unknown) => void>>();
	const sent: any[] = [];
	const commandDispatches: string[] = [];
	const userMessages: string[] = [];
	const notices: string[] = [];
	const services: FakeService[] = [];
	const catalogOptions: any[] = [];
	const modelRefreshes: unknown[] = [];
	let availableModels = options.availableModels ?? [model()];
	let sessionId = options.sessionId ?? "session-1";
	const pi = {
		registerTool(definition: any) { tools.set(definition.name, definition); },
		registerCommand(name: string, definition: any) { commands.set(name, definition); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		events: {
			on(name: string, handler: (value: unknown) => void) { bus.set(name, [...(bus.get(name) ?? []), handler]); },
			emit(name: string, value: unknown) { for (const handler of bus.get(name) ?? []) handler(value); },
		},
		getAllTools() { return [...tools.values()].map((tool) => ({ name: tool.name })); },
		sendMessage(message: unknown, delivery: unknown) { sent.push({ message, delivery }); },
		sendUserMessage(content: string, delivery: { expandPromptTemplates?: boolean } = {}) {
			if (delivery.expandPromptTemplates && content.startsWith("/")) {
				const name = content.slice(1).split(" ", 1)[0]!;
				const command = commands.get(name);
				if (command) {
					commandDispatches.push(content);
					void Promise.resolve().then(() => command.handler("", { ...ctx, waitForIdle: options.waitForIdle ?? (async () => undefined) })).catch(() => undefined);
					return;
				}
			}
			userMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		mode: "tui",
		isProjectTrusted: () => options.trusted ?? true,
		sessionManager: { getSessionId: () => sessionId },
		modelRegistry: {
			getAvailable: () => availableModels,
			async refresh(request: unknown) {
				modelRefreshes.push(request);
				if (options.refreshedModels) availableModels = options.refreshedModels;
				return { aborted: false, errors: new Map() };
			},
		},
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
	return { pi, ctx, tools, commands, handlers, sent, commandDispatches, userMessages, notices, services, catalogOptions, modelRefreshes, dependencies, fire, setSessionId(value: string) { sessionId = value; } };
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

test("spawn schema requires a descriptive title without hard length limits", () => {
	const spawn = harness().tools.get("subagent_spawn");
	assert.equal(spawn.parameters.required.includes("title"), true);
	assert.match(spawn.parameters.properties.title.description, /Required descriptive display label \(prefer 3–7 words\)/);
	assert.equal(spawn.parameters.properties.title.maxLength, undefined, "display heading length does not reject a logical label");
	assert.match(spawn.parameters.properties.tier.description, /override the agent default up or down/i);
	assert.match(spawn.parameters.properties.tier.description, /does not replace an agent's configured model/i);
	assert.match(spawn.parameters.properties.tier.description, /Local never uses paid providers/);
	assert.match(spawn.parameters.properties.model.description, /Overrides an agent's configured model/);
	assert.match(spawn.parameters.properties.model.description, /Strict by default/);
	assert.equal(spawn.parameters.required.includes("tier"), false);
});

test("spawn execution rejects missing or normalized-blank titles", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	for (const title of [undefined, " \n\t", "\u001b[31m\u001b[0m"]) {
		await assert.rejects(
			f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", ...(title === undefined ? {} : { title }), task: "Do not launch" }, undefined, undefined, f.ctx),
			/Subagent title is required and must contain visible text/,
		);
	}
	assert.equal(f.services[0]!.launches.length, 0);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("assignment legibility guidance stays scoped to spawn and continue task arguments", async () => {
	const f = harness();
	const checkGuidance = () => {
		for (const name of ["subagent_spawn", "subagent_continue"]) {
			const tool = f.tools.get(name);
			assert.match(tool.parameters.properties.task.description, /Use readable prose with normal word spacing\./);
			assert.doesNotMatch(tool.description, /normal word spacing/);
			assert.doesNotMatch((tool.promptGuidelines ?? []).join("\n"), /normal word spacing/);
		}
	};
	checkGuidance();
	await f.fire("session_start", { reason: "startup" });
	checkGuidance();
	await f.fire("session_shutdown", { reason: "quit" });
});

test("loads trusted catalog policy, resolves the active tier profile, prompt, route, tools, and foreground updates", async () => {
	const f = harness({ trusted: true });
	f.pi.events.emit(MODEL_TIER_PROFILE_EVENT, { profile: "token-conservative" });
	await f.fire("session_start", { reason: "startup" });
	const updates: any[] = [];
	const pending = f.tools.get("subagent_spawn").execute("call", { agent: "general-purpose", title: "Test bounded assignment", task: "Inspect the bounded surface" }, undefined, (update: any) => updates.push(update), f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const service = f.services[0]!;
	const agentId = [...service.snapshots.keys()][0]!;
	service.activity(agentId);
	service.finish(agentId, "completed", "foreground report");
	const settled = await pending;
	assert.match(settled.content[0].text, /general-purpose.*completed\nforeground report/);
	assert.ok(updates.length >= 2);
	assert.equal(f.catalogOptions[0].includeProject, true);
	assert.equal(f.catalogOptions[0].modelTierProfile, "token-conservative");
	assert.equal(service.launches[0]?.stableSystemContext.includes("General-Purpose Agent"), true);
	assert.deepEqual(service.launches[0]?.tools, ["*"]);
	assert.equal(service.launches[0]?.model, "gpt-5.6-sol");
	assert.deepEqual(service.launches[0]?.extensionPaths, [...STANDALONE_CHILD_EXTENSION_PATHS]);
	assert.deepEqual(service.launches[0]?.extensionPaths.map((path) => path.match(/extensions\/([^/]+)\/index\.ts$/)?.[1]), ["memory-adapter", "distill", "fast-mode", "e2e-workspace"]);
	assert.equal(service.launches[0]?.extensionPaths.some((path) => /workflow\/index\.ts$/.test(path)), false);
});

test("background returns immediately and steers one terminal batch to the same binding", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const spawned = await f.tools.get("subagent_spawn").execute("call", { agent: "general-purpose", title: "Test bounded assignment", task: "Background work", mode: "background" }, undefined, undefined, f.ctx);
	assert.match(spawned.content[0].text, /background as agent-1/);
	assert.match(spawned.content[0].text, /Do not sleep or poll/);
	assert.deepEqual(spawned.details.uiRef, { owner: f.services[0]!.owner, agentId: "agent-1" }, "the immutable launch receipt carries an owner-fenced UI correlation, not mutable lifecycle state");
	f.services[0]!.finish("agent-1", "completed", "background report");
	await waitUntil(() => f.sent.length === 1, "background completion was not delivered");
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /background report/);
	assert.deepEqual(f.sent[0].delivery, { deliverAs: "steer", triggerTurn: true });
});

test("foreground and background results advertise the harness report and subagent_read reads that same file", async (t) => {
	const root = await mkdtemp(join("/tmp", "pibox-extension-reports-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const f = harness();
	await f.fire("session_start", { reason: "startup" });

	const foregroundText = "small foreground report";
	const foregroundPath = join(root, "foreground.md");
	await writeFile(foregroundPath, foregroundText, { mode: 0o600 });
	const foregroundPending = f.tools.get("subagent_spawn").execute("foreground", { agent: "general-purpose", title: "Test bounded assignment", task: "Foreground" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	f.services[0]!.finish("agent-1", "completed", foregroundText, foregroundPath);
	const foreground = await foregroundPending;
	assert.match(foreground.content[0].text, new RegExp(`Report: ${foregroundPath}`));
	assert.match(foreground.content[0].text, /small foreground report/);
	assert.equal(foreground.details.terminal.reportPath, foregroundPath);
	const compatibilityRead = await f.tools.get("subagent_read").execute("read", { agentId: "agent-1" }, undefined, undefined, f.ctx);
	assert.equal(compatibilityRead.details.reportPath, foregroundPath);
	assert.ok(compatibilityRead.content[0].text.endsWith(foregroundText));
	await rm(foregroundPath);
	await assert.rejects(f.tools.get("subagent_read").execute("missing", { agentId: "agent-1" }, undefined, undefined, f.ctx), /report file is missing/i);

	const backgroundText = "🙂".repeat(20_000);
	const backgroundPath = join(root, "background.md");
	await writeFile(backgroundPath, backgroundText, { mode: 0o600 });
	const background = await f.tools.get("subagent_spawn").execute("background", { agent: "general-purpose", title: "Test bounded assignment", task: "Background", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(background.details.agentId, "completed", backgroundText, backgroundPath);
	await waitUntil(() => f.sent.length === 1, "background report was not delivered");
	assert.match(f.sent[0].message.content, new RegExp(`Report: ${backgroundPath}`));
	assert.ok(Buffer.byteLength(f.sent[0].message.content) < 48 * 1024);
	assert.equal(f.sent[0].message.details.settlements[0].reportPath, backgroundPath);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone E2E delivery uses deterministic validated receipts and reads report.json on demand", async (t) => {
	const attempt = await mkdtemp("/tmp/pibox-e2e-standalone-"); await chmod(attempt, 0o700);
	const workspace = await createE2eWorkspace({ sessionId: "child-session" });
	t.after(() => Promise.all([rm(attempt, { recursive: true, force: true }), rm(workspace.root, { recursive: true, force: true })]));
	const loaded = catalog();
	loaded.config.agents["e2e-tester"] = { ...loaded.config.agents["general-purpose"]!, prompt: `${BUILT_IN_AGENT_ROOT}/e2e-tester.md` };
	const f = harness({ loadCatalog: () => loaded }); await f.fire("session_start", { reason: "startup" });

	const evaluation = await createE2eEvaluation({ workspace });
	await writeFile(join(evaluation.outputDirectory, "proof.txt"), "bounded proof", { mode: 0o600 });
	const evidence = await retainE2eEvidence({ evaluation, sourcePath: "proof.txt", reason: "receipt count" });
	const nativeReportPath = join(attempt, "report.md");
	const findingProse = "PRIVATE-FINDING-PROSE";
	const submitted = await submitE2eWorkspaceReport({ evaluation, nativeReportPath, submission: {
		cases: [
			{ case: "E2E-001", verdict: "passed", evidence: [evidence.reference] },
			{ case: "E2E-002", verdict: "failed" },
			{ case: "E2E-003", verdict: "blocked" },
		],
		findings: [
			{ summary: findingProse, severity: "critical" },
			{ summary: "default-major" },
			{ summary: "major", severity: "major" },
			{ summary: "minor", severity: "minor" },
		],
	} });
	const nativeProse = `NATIVE-CONTRADICTORY-PASS-${"x".repeat(30_000)}`;
	const pending = f.tools.get("subagent_spawn").execute("e2e", { agent: "e2e-tester", title: "Test bounded assignment", task: "Evaluate" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	f.services[0]!.finish("agent-1", "completed", nativeProse, nativeReportPath);
	const foreground = await pending;
	const foregroundText = foreground.content[0].text;
	assert.match(foregroundText, /completed · attempt attempt-1/);
	assert.match(foregroundText, /E2E outcome: failed \(critical\)/);
	assert.match(foregroundText, /Cases: 1 passed · 1 failed · 1 blocked/);
	assert.match(foregroundText, /Findings: 1 critical · 2 major · 1 minor/);
	assert.match(foregroundText, new RegExp(`Report: ${submitted.reportPath}`));
	assert.match(foregroundText, new RegExp(`Evidence: 1 retained · ${join(evaluation.root, "evidence")}`));
	assert.match(foregroundText, new RegExp(`Use read/grep on ${submitted.reportPath}`));
	assert.doesNotMatch(foregroundText, /NATIVE-CONTRADICTORY|PRIVATE-FINDING-PROSE|default-major/);
	assert.ok(Buffer.byteLength(foregroundText) < 2_000);
	assert.equal(JSON.stringify(foreground.details).includes(findingProse), false);
	assert.equal(foreground.details.terminal.e2eWorkspaceReportPath, submitted.reportPath);
	assert.deepEqual(foreground.details.terminal.e2eWorkspaceReport, submitted.reference);

	const read = await f.tools.get("subagent_read").execute("read", { agentId: "agent-1" }, undefined, undefined, f.ctx);
	assert.equal(read.details.reportPath, submitted.reportPath);
	assert.ok(read.content[0].text.endsWith(submitted.serializedJsonText));

	const nextEvaluation = await createE2eEvaluation({ workspace });
	const nextAttempt = join(attempt, "continued"); await mkdir(nextAttempt, { mode: 0o700 });
	const nextNativePath = join(nextAttempt, "report.md");
	const nextSubmitted = await submitE2eWorkspaceReport({ evaluation: nextEvaluation, nativeReportPath: nextNativePath, submission: { cases: [{ case: "E2E-004", verdict: "passed" }] } });
	const continuation = f.tools.get("subagent_continue").execute("continue", { agentId: "agent-1", task: "Evaluate latest" }, undefined, undefined, f.ctx);
	await f.services[0]!.continuationSpawned.promise;
	f.services[0]!.finish("agent-1", "completed", "", nextNativePath);
	const continued = await continuation;
	assert.match(continued.content[0].text, /completed · attempt attempt-3/);
	assert.match(continued.content[0].text, /E2E outcome: passed/);
	assert.match(continued.content[0].text, new RegExp(nextSubmitted.reportPath));
	assert.doesNotMatch(continued.content[0].text, new RegExp(submitted.reportPath));
	await assert.rejects(f.tools.get("subagent_read").execute("stale", { agentId: "agent-1", attemptId: read.details.attemptId }, undefined, undefined, f.ctx), /Report attempt changed/);

	const backgroundEvaluation = await createE2eEvaluation({ workspace });
	const backgroundAttempt = join(attempt, "background"); await mkdir(backgroundAttempt, { mode: 0o700 });
	const backgroundNativeReportPath = join(backgroundAttempt, "report.md");
	const backgroundSubmitted = await submitE2eWorkspaceReport({ evaluation: backgroundEvaluation, nativeReportPath: backgroundNativeReportPath, submission: { cases: [{ case: "E2E-005", verdict: "failed" }], findings: [{ summary: "major background" }] } });
	const background = await f.tools.get("subagent_spawn").execute("e2e-background", { agent: "e2e-tester", title: "Test bounded assignment", task: "Evaluate", mode: "background" }, undefined, undefined, f.ctx);
	const batchedEvaluation = await createE2eEvaluation({ workspace });
	const batchedAttempt = join(attempt, "batched"); await mkdir(batchedAttempt, { mode: 0o700 });
	const batchedNativeReportPath = join(batchedAttempt, "report.md");
	const largeReportProse = `LARGE-REPORT-PRIVATE-${"z".repeat(30_000)}`;
	const batchedSubmitted = await submitE2eWorkspaceReport({ evaluation: batchedEvaluation, nativeReportPath: batchedNativeReportPath, submission: { cases: [{ case: "E2E-006", verdict: "passed" }], summary: largeReportProse } });
	const batched = await f.tools.get("subagent_spawn").execute("e2e-batched", { agent: "e2e-tester", title: "Test batched receipt", task: "Evaluate", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(background.details.agentId, "completed", "", backgroundNativeReportPath);
	f.services[0]!.finish(batched.details.agentId, "completed", "", batchedNativeReportPath);
	// Async workspace reads may settle outside the same delivery batching window.
	await waitUntil(() => f.sent.flatMap((sent) => sent.message.details.settlements).length === 2, "background E2E reports were delivered");
	const deliveredText = f.sent.map((sent) => sent.message.content).join("\n");
	const settlements = f.sent.flatMap((sent) => sent.message.details.settlements);
	assert.match(deliveredText, /E2E outcome: failed/);
	assert.match(deliveredText, /Cases: 0 passed · 1 failed · 0 blocked/);
	assert.match(deliveredText, new RegExp(batchedSubmitted.reportPath));
	assert.doesNotMatch(deliveredText, /major background|LARGE-REPORT-PRIVATE/);
	assert.doesNotMatch(deliveredText, new RegExp(backgroundNativeReportPath));
	assert.ok(Buffer.byteLength(deliveredText) < 4_000);
	const backgroundSettlement = settlements.find((settlement) => settlement.e2eWorkspaceReportPath === backgroundSubmitted.reportPath);
	assert.ok(backgroundSettlement);
	assert.deepEqual(backgroundSettlement.e2eWorkspaceReport, backgroundSubmitted.reference);
	assert.equal(JSON.stringify(settlements).includes(largeReportProse), false);
});

test("standalone E2E delivery reports unavailable and invalid handoffs without inventing verdicts", async (t) => {
	const attempt = await mkdtemp("/tmp/pibox-e2e-invalid-"); await chmod(attempt, 0o700);
	const workspace = await createE2eWorkspace({ sessionId: "invalid-child" });
	t.after(() => Promise.all([rm(attempt, { recursive: true, force: true }), rm(workspace.root, { recursive: true, force: true })]));
	const loaded = catalog();
	loaded.config.agents["e2e-tester"] = { ...loaded.config.agents["general-purpose"]!, prompt: `${BUILT_IN_AGENT_ROOT}/e2e-tester.md` };
	const f = harness({ loadCatalog: () => loaded }); await f.fire("session_start", { reason: "startup" });

	const unavailable = f.tools.get("subagent_spawn").execute("missing", { agent: "e2e-tester", title: "Missing E2E report", task: "Evaluate" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const missingPath = join(attempt, "report.md");
	f.services[0]!.finish("agent-1", "completed", "PASSED according to native prose", missingPath);
	const missing = await unavailable;
	assert.match(missing.content[0].text, /E2E report: unavailable\./);
	assert.doesNotMatch(missing.content[0].text, /outcome|PASSED according/);
	await assert.rejects(f.tools.get("subagent_read").execute("missing-read", { agentId: "agent-1" }, undefined, undefined, f.ctx), /no submitted handoff/);

	const evaluation = await createE2eEvaluation({ workspace });
	const corruptAttempt = join(attempt, "corrupt"); await mkdir(corruptAttempt, { mode: 0o700 });
	const corruptNativePath = join(corruptAttempt, "report.md");
	const submitted = await submitE2eWorkspaceReport({ evaluation, nativeReportPath: corruptNativePath, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] } });
	await writeFile(submitted.reportPath, "{}\n", { mode: 0o600 });
	const invalid = f.tools.get("subagent_spawn").execute("invalid", { agent: "e2e-tester", title: "Invalid E2E report", task: "Evaluate" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	const corruptAgentId = [...f.services[0]!.snapshots.keys()].at(-1)!;
	f.services[0]!.finish(corruptAgentId, "completed", "native says passed", corruptNativePath);
	const corrupt = await invalid;
	assert.match(corrupt.content[0].text, /E2E report: error\./);
	assert.doesNotMatch(corrupt.content[0].text, /outcome|native says passed/);
	await assert.rejects(f.tools.get("subagent_read").execute("invalid-read", { agentId: corruptAgentId }, undefined, undefined, f.ctx), /validation failed/);
});

test("wait returns same bounded standalone E2E receipt", async (t) => {
	const attempt = await mkdtemp("/tmp/pibox-e2e-wait-"); await chmod(attempt, 0o700);
	const workspace = await createE2eWorkspace({ sessionId: "wait-child" });
	t.after(() => Promise.all([rm(attempt, { recursive: true, force: true }), rm(workspace.root, { recursive: true, force: true })]));
	const evaluation = await createE2eEvaluation({ workspace });
	const nativeReportPath = join(attempt, "report.md");
	const submitted = await submitE2eWorkspaceReport({ evaluation, nativeReportPath, submission: { cases: [{ case: "E2E-001", verdict: "blocked" }] } });
	const loaded = catalog(); loaded.config.agents["e2e-tester"] = { ...loaded.config.agents["general-purpose"]!, prompt: `${BUILT_IN_AGENT_ROOT}/e2e-tester.md` };
	const f = harness({ loadCatalog: () => loaded }); await f.fire("session_start", { reason: "startup" });
	const spawned = await f.tools.get("subagent_spawn").execute("spawn", { agent: "e2e-tester", title: "Wait E2E result", task: "Evaluate", mode: "background" }, undefined, undefined, f.ctx);
	const waiting = f.tools.get("wait").execute("wait", { event: "subagent_settled" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(spawned.details.agentId, "completed", "", nativeReportPath);
	const settled = await waiting;
	assert.match(settled.content[0].text, /Subagent completed · attempt attempt-1/);
	assert.match(settled.content[0].text, /E2E outcome: blocked/);
	assert.match(settled.content[0].text, new RegExp(submitted.reportPath));
	assert.doesNotMatch(settled.content[0].text, new RegExp(nativeReportPath));
	assert.equal(f.sent.length, 0);
});

test("pre-change process-global track protocol retains bounded E2E receipt across reload", async (t) => {
	const attempt = await mkdtemp("/tmp/pibox-e2e-reload-"); await chmod(attempt, 0o700);
	const workspace = await createE2eWorkspace({ sessionId: "reload-child" });
	t.after(() => Promise.all([rm(attempt, { recursive: true, force: true }), rm(workspace.root, { recursive: true, force: true })]));
	const evaluation = await createE2eEvaluation({ workspace });
	const nativeReportPath = join(attempt, "report.md");
	const submitted = await submitE2eWorkspaceReport({ evaluation, nativeReportPath, submission: { cases: [{ case: "E2E-001", verdict: "passed" }] } });
	const loaded = catalog(); loaded.config.agents["e2e-tester"] = { ...loaded.config.agents["general-purpose"]!, prompt: `${BUILT_IN_AGENT_ROOT}/e2e-tester.md` };
	const registry = new SubagentCapabilityRegistry();
	const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
	const legacyTrack = pendingDeliveries.track.bind(pendingDeliveries);
	pendingDeliveries.track = ((delivery, terminalResult) => legacyTrack(delivery, terminalResult.then((terminal) => {
		assert.equal("terminal" in terminal, false, "pre-change registry receives flat TerminalResult");
		assert.equal((terminal as TerminalResult & { e2eReceipt?: { state: string } }).e2eReceipt?.state, "validated");
		return terminal;
	}))) as typeof pendingDeliveries.track;
	const dependencies = { registry, pendingDeliveries, processInstanceId: "e2e-reload", loadCatalog: () => loaded };
	const first = harness(dependencies); await first.fire("session_start", { reason: "startup" });
	const spawned = await first.tools.get("subagent_spawn").execute("spawn", { agent: "e2e-tester", title: "Reload E2E result", task: "Evaluate", mode: "background" }, undefined, undefined, first.ctx);
	const service = first.services[0]!;
	await first.fire("session_shutdown", { reason: "reload" });
	service.finish(spawned.details.agentId, "failed", "native failure prose", nativeReportPath);
	await new Promise((resolve) => setImmediate(resolve));

	const second = harness(dependencies); await second.fire("session_start", { reason: "reload" });
	await waitUntil(() => second.sent.length === 1, "reload did not deliver E2E receipt");
	assert.match(second.sent[0].message.content, /\[Subagent failed · attempt attempt-1\]/);
	assert.match(second.sent[0].message.content, /E2E outcome: passed/);
	assert.match(second.sent[0].message.content, new RegExp(submitted.reportPath));
	assert.doesNotMatch(second.sent[0].message.content, /native failure prose/);
	assert.equal(second.sent[0].message.details.settlements[0].status, "failed");
	assert.equal(second.sent[0].message.details.settlements[0].e2eReceipt.state, "validated");
});

test("late background E2E receipt is delivered once as historical after continuation", async (t) => {
	const attempt = await mkdtemp("/tmp/pibox-e2e-race-"); await chmod(attempt, 0o700);
	const workspace = await createE2eWorkspace({ sessionId: "race-child" });
	t.after(() => Promise.all([rm(attempt, { recursive: true, force: true }), rm(workspace.root, { recursive: true, force: true })]));
	const firstEvaluation = await createE2eEvaluation({ workspace });
	const firstNativePath = join(attempt, "report.md");
	const firstReport = await submitE2eWorkspaceReport({ evaluation: firstEvaluation, nativeReportPath: firstNativePath, submission: { cases: [{ case: "E2E-OLD", verdict: "failed" }] } });
	const nextEvaluation = await createE2eEvaluation({ workspace });
	const nextAttempt = join(attempt, "next"); await mkdir(nextAttempt, { mode: 0o700 });
	const nextNativePath = join(nextAttempt, "report.md");
	const nextReport = await submitE2eWorkspaceReport({ evaluation: nextEvaluation, nativeReportPath: nextNativePath, submission: { cases: [{ case: "E2E-NEW", verdict: "passed" }] } });
	const loaded = catalog(); loaded.config.agents["e2e-tester"] = { ...loaded.config.agents["general-purpose"]!, prompt: `${BUILT_IN_AGENT_ROOT}/e2e-tester.md` };
	const f = harness({ loadCatalog: () => loaded, pendingDeliveries: new PendingSubagentDeliveryRegistry(30) });
	await f.fire("session_start", { reason: "startup" });
	const spawned = await f.tools.get("subagent_spawn").execute("spawn", { agent: "e2e-tester", title: "Race E2E result", task: "Evaluate old", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(spawned.details.agentId, "completed", "", firstNativePath);
	const continuation = f.tools.get("subagent_continue").execute("continue", { agentId: spawned.details.agentId, task: "Evaluate new" }, undefined, undefined, f.ctx);
	await f.services[0]!.continuationSpawned.promise;
	f.services[0]!.finish(spawned.details.agentId, "completed", "", nextNativePath);
	const continued = await continuation;
	assert.match(continued.content[0].text, /attempt attempt-3/);
	assert.match(continued.content[0].text, new RegExp(nextReport.reportPath));
	await waitUntil(() => f.sent.length === 1, "historical background receipt was not delivered");
	const historical = f.sent[0].message.content;
	assert.match(historical, /attempt attempt-1 · historical completion; current attempt attempt-3/);
	assert.match(historical, new RegExp(firstReport.reportPath));
	assert.doesNotMatch(historical, new RegExp(nextReport.reportPath));
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(f.sent.length, 1, "historical obligation delivers exactly once");
	assert.equal((await readE2eWorkspaceHandoff(firstNativePath))?.reportPath, firstReport.reportPath);
	assert.equal((await readE2eWorkspaceHandoff(nextNativePath))?.reportPath, nextReport.reportPath);
});

test("tool transcript details retain terminal metadata without complete reports or diagnostics", async (t) => {
	const root = await mkdtemp(join("/tmp", "pibox-extension-detail-bounds-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const sentinel = "PRIVATE-OVERSIZED-TERMINAL-SENTINEL";
	const oversized = `${"x".repeat(24_000)}${sentinel}`;

	const foregroundPath = join(root, "foreground.md");
	await writeFile(foregroundPath, oversized, { mode: 0o600 });
	const foregroundPending = f.tools.get("subagent_spawn").execute("foreground", { agent: "general-purpose", title: "Test bounded assignment", task: "Foreground" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	f.services[0]!.finish("agent-1", "completed", oversized, foregroundPath, `diagnostic-${sentinel}`);
	const foreground = await foregroundPending;
	assert.equal(JSON.stringify(foreground.details).includes(sentinel), false);
	assert.deepEqual(Object.keys(foreground.details.terminal).sort(), ["attemptId", "exitCode", "reason", "reportBytes", "reportCharacters", "reportPath", "status"]);
	assert.equal(foreground.details.terminal.status, "completed", "the TUI terminal-state metadata remains available");

	const continuationPath = join(root, "continuation.md");
	await writeFile(continuationPath, oversized, { mode: 0o600 });
	const continuing = f.tools.get("subagent_continue").execute("continue", { agentId: "agent-1", task: "Continue" }, undefined, undefined, f.ctx);
	await f.services[0]!.continuationSpawned.promise;
	f.services[0]!.finish("agent-1", "completed", oversized, continuationPath, `diagnostic-${sentinel}`);
	const continued = await continuing;
	assert.equal(JSON.stringify(continued.details).includes(sentinel), false);
	assert.equal(continued.details.terminal.attemptId, "attempt-3");

	const backgroundPath = join(root, "background.md");
	await writeFile(backgroundPath, oversized, { mode: 0o600 });
	const background = await f.tools.get("subagent_spawn").execute("background", { agent: "general-purpose", title: "Test bounded assignment", task: "Background", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(background.details.agentId, "completed", oversized, backgroundPath, `diagnostic-${sentinel}`);
	await waitUntil(() => f.sent.length === 1, "background report was not delivered");
	assert.equal(JSON.stringify(f.sent[0].message.details).includes(sentinel), false);
	assert.equal("summary" in f.sent[0].message.details.settlements[0], false);
	assert.equal(f.sent[0].message.details.settlements[0].reportBytes, Buffer.byteLength(oversized));
	await f.fire("session_shutdown", { reason: "quit" });
});

test("production workflow launch projects whitelisted provenance and configured tier without duplicating the footer", async () => {
	const uiRegistry = new SubagentUiProjectionRegistry();
	const f = harness({ uiRegistry });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("standalone", { agent: "general-purpose", title: "Test bounded assignment", task: "Standalone work", mode: "background" }, undefined, undefined, f.ctx);
	const service = f.services[0]!;
	const launcher = new WorkflowSubagentLauncher(service);
	const launched = launcher.launch({
		storyId: "story-one",
		slotId: "task:task-one",
		attemptToken: "workflow-token",
		action: "task-launch",
		role: "implementer",
		tier: "high",
		cwd: process.cwd(),
		stableSystemContext: "stable workflow context",
		attemptUserPrompt: "implement the task",
		provider: "provider",
		model: "model",
		effort: "high",
		tools: ["read"],
		taskId: "task-one",
	});
	await waitUntil(() => service.launches.length === 2, "workflow service launch was not published");

	assert.deepEqual(uiRegistry.project()?.agents.map((agent) => agent.agentId), ["agent-1"]);
	const workflow = uiRegistry.projectWorkflow("story-one");
	assert.deepEqual(workflow?.agents.map((agent) => agent.agentId), ["agent-2"]);
	assert.equal(workflow?.agents[0]?.tier, "high");
	assert.deepEqual(workflow?.agents[0]?.workflow, {
		storyId: "story-one",
		slotId: "task:task-one",
		action: "task-launch",
		taskId: "task-one",
	});
	assert.equal("PIBOX_WORKFLOW_ATTEMPT_TOKEN" in (workflow?.agents[0]?.workflow ?? {}), false);
	assert.match(formatSubagentFooterProjection(workflow!.agents[0]!, Date.now()), /implementer · High \(provider\/model#high\)/, "the shared workflow row renderer receives the production tier projection");

	service.finish("agent-2", "completed", "workflow complete");
	await launched;
});

test("near-simultaneous background settlements are steered in one message", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("one", { agent: "general-purpose", title: "Test bounded assignment", task: "One", mode: "background" }, undefined, undefined, f.ctx);
	await f.tools.get("subagent_spawn").execute("two", { agent: "general-purpose", title: "Test bounded assignment", task: "Two", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish("agent-1", "completed", "first report");
	f.services[0]!.finish("agent-2", "completed", "second report");
	await waitUntil(() => f.sent.length === 1, "background completion batch was not delivered");
	assert.equal(f.sent.length, 1);
	assert.match(f.sent[0].message.content, /first report/);
	assert.match(f.sent[0].message.content, /second report/);
	assert.equal(f.sent[0].message.details.settlements.length, 2);
});

for (const outcome of [
	{ label: "success", event: "session_compact", data: {} },
	{ label: "failure", event: "session_compact_failed", data: { aborted: false, errorMessage: "failed" } },
	{ label: "cancellation", event: "session_compact_failed", data: { aborted: true } },
] as const) {
	test(`background results wait for compaction ${outcome.label} and flush once`, async () => {
		const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
		const idle = deferred<void>();
		const f = harness({ pendingDeliveries, waitForIdle: () => idle.promise });
		await f.fire("session_start", { reason: "startup" });
		await f.tools.get("subagent_spawn").execute("one", { agent: "general-purpose", title: "First compacted result", task: "One", mode: "background" }, undefined, undefined, f.ctx);
		await f.tools.get("subagent_spawn").execute("two", { agent: "general-purpose", title: "Second compacted result", task: "Two", mode: "background" }, undefined, undefined, f.ctx);
		await f.fire("session_before_compact", { reason: "manual" });
		f.services[0]!.finish("agent-1", "completed", "first compacted report");
		f.services[0]!.finish("agent-2", "completed", "second compacted report");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.sent.length, 0, "compaction must not receive a competing turn");
		assert.equal(pendingDeliveries.count(f.services[0]!.owner), 2);
		await f.fire(outcome.event, outcome.data);
		await f.fire(outcome.event, outcome.data);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.commandDispatches.length, 1, "one bridge command is dispatched per compaction generation");
		assert.equal(f.sent.length, 0, "compaction bridge must wait for real idle");
		assert.equal(f.userMessages.length, 0, "internal command is handled, not submitted as a user message");
		idle.resolve(undefined);
		await waitUntil(() => f.sent.length === 1, `results did not flush after compaction ${outcome.label}`);
		assert.match(f.sent[0].message.content, /first compacted report/);
		assert.match(f.sent[0].message.content, /second compacted report/);
		assert.equal(f.sent[0].message.details.settlements.length, 2);
		await f.fire("agent_settled");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.sent.length, 1);
		assert.equal(pendingDeliveries.count(), 0);
	});
}

test("pre-batch process-global registry rebinds through legacy delivery after compaction", async () => {
	const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
	Object.defineProperties(pendingDeliveries, { retry: { value: undefined }, bindBatched: { value: undefined } });
	const idle = deferred<void>();
	const f = harness({ pendingDeliveries, waitForIdle: () => idle.promise });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Legacy compacted result", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	await f.fire("session_before_compact", { reason: "manual" });
	f.services[0]!.finish("agent-1", "completed", "legacy compacted report");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(f.sent.length, 0);
	await f.fire("session_compact", { reason: "manual" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(f.sent.length, 0);
	idle.resolve(undefined);
	await waitUntil(() => f.sent.length === 1, "legacy registry did not flush after compaction");
	assert.match(f.sent[0].message.content, /legacy compacted report/);
});

for (const settledBeforeResume of [false, true]) {
	test(`post-compaction context releases wait without parent idle (already settled: ${settledBeforeResume})`, { timeout: 2_000 }, async () => {
		const idle = deferred<void>();
		const f = harness({ pendingDeliveries: new PendingSubagentDeliveryRegistry(0), waitForIdle: () => idle.promise });
		await f.fire("session_start", { reason: "startup" });
		await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Compacted dependency", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
		await f.fire("session_before_compact", { reason: "threshold" });
		if (settledBeforeResume) f.services[0]!.finish("agent-1", "completed", "compacted dependency report");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(f.sent.length, 0);
		await f.fire("session_compact", { reason: "threshold" });
		await f.fire("context");
		const waiting = f.tools.get("wait").execute("wait", { event: "subagent_settled" }, undefined, undefined, f.ctx);
		if (!settledBeforeResume) f.services[0]!.finish("agent-1", "completed", "compacted dependency report");
		const settled = await waiting;
		assert.match(settled.content[0].text, /compacted dependency report/);
		assert.equal(f.sent.length, 0, "wait result remains sole model-visible delivery");
		idle.resolve(undefined); // Real parent idle is possible only after wait resolves.
	});
}

test("post-compaction context flushes automatic delivery before parent idle", async () => {
	const idle = deferred<void>();
	const f = harness({ pendingDeliveries: new PendingSubagentDeliveryRegistry(0), waitForIdle: () => idle.promise });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Compacted result", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
	await f.fire("session_before_compact", { reason: "threshold" });
	f.services[0]!.finish("agent-1", "completed", "retained report");
	await new Promise((resolve) => setTimeout(resolve, 10));
	await f.fire("session_compact_failed", { reason: "threshold", aborted: true });
	await f.fire("context");
	await waitUntil(() => f.sent.length === 1, "resumed context did not release retained report");
	idle.resolve(undefined);
	await f.fire("context");
	await f.fire("agent_settled");
	assert.equal(f.sent.length, 1);
});

test("reload adopts a compaction-delayed result only for the same owner", async () => {
	const registry = new SubagentCapabilityRegistry();
	const pendingDeliveries = new PendingSubagentDeliveryRegistry(0);
	const dependencies = { registry, pendingDeliveries, processInstanceId: "compact-reload" };
	const oldIdle = deferred<void>();
	const first = harness({ ...dependencies, waitForIdle: () => oldIdle.promise });
	await first.fire("session_start", { reason: "startup" });
	await first.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Reload compacted result", task: "Wait", mode: "background" }, undefined, undefined, first.ctx);
	await first.fire("session_before_compact", { reason: "manual" });
	const service = first.services[0]!;
	service.finish("agent-1", "completed", "reload compacted report");
	await first.fire("session_compact", { reason: "manual" });
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(first.sent.length, 0);
	await first.fire("session_shutdown", { reason: "reload" });
	oldIdle.resolve(undefined);

	let staleDeliveries = 0;
	const stale = pendingDeliveries.bind({ ...service.owner, sessionId: "other-session" }, "stale", () => { staleDeliveries++; return true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(staleDeliveries, 0);
	stale.release();

	const second = harness(dependencies);
	await second.fire("session_start", { reason: "reload" });
	await waitUntil(() => second.sent.length === 1, "same-owner reload did not adopt compacted result");
	assert.match(second.sent[0].message.content, /reload compacted report/);
	assert.equal(pendingDeliveries.count(service.owner), 0);
	await second.fire("session_shutdown", { reason: "quit" });
});

test("large completion sets are chunked without consuming model-invisible settlements", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	for (let index = 1; index <= 10; index++) {
		await f.tools.get("subagent_spawn").execute(`spawn-${index}`, { agent: "general-purpose", title: "Test bounded assignment", task: `Task ${index}`, mode: "background" }, undefined, undefined, f.ctx);
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

test("wait supports elapsed time, live timer metadata, and abort without shell sleep", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const updates: any[] = [];
	const elapsed = await f.tools.get("wait").execute("time", { durationMs: 1 }, undefined, (update: any) => updates.push(update), f.ctx);
	assert.equal(elapsed.content[0].text, "Waited 1 ms.");
	assert.equal(updates.length, 1);
	assert.equal(updates[0].details.kind, "time");
	assert.equal(updates[0].details.durationMs, 1);
	assert.equal(typeof updates[0].details.startedAt, "number");
	assert.equal(elapsed.details.kind, "time");
	assert.equal(elapsed.details.durationMs, 1);
	assert.equal(elapsed.details.startedAt, updates[0].details.startedAt);
	assert.equal(typeof elapsed.details.finishedAt, "number");
	assert.equal(typeof elapsed.details.elapsedMs, "number");

	const controller = new AbortController();
	const waiting = f.tools.get("wait").execute("abort", { durationMs: 60_000 }, controller.signal, undefined, f.ctx);
	controller.abort(new Error("cancel wait"));
	await assert.rejects(waiting, /cancel wait/);
});

test("wait subscribes once to background settlement and consumes automatic delivery", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
	const updates: any[] = [];
	const waiting = f.tools.get("wait").execute("wait", { event: "subagent_settled" }, undefined, (update: any) => updates.push(update), f.ctx);
	f.services[0]!.finish("agent-1", "completed", "dependency report");
	const settled = await waiting;
	assert.match(settled.content[0].text, /dependency report/);
	assert.equal(updates.length, 1);
	assert.equal(updates[0].details.event, "subagent_settled");
	assert.equal(updates[0].details.pendingCount, 1);
	assert.equal(settled.details.kind, "event");
	assert.equal(settled.details.event, "subagent_settled");
	assert.equal(settled.details.startedAt, updates[0].details.startedAt);
	assert.equal(typeof settled.details.finishedAt, "number");
	assert.equal(typeof settled.details.elapsedMs, "number");
	assert.equal(settled.details.pendingCount, 1);
	assert.deepEqual(settled.details.settlements, [
		{ agent: "general-purpose", agentId: "agent-1", title: "Test bounded assignment", attemptId: "attempt-1", reason: "completed", routing: f.services[0]!.launches[0]!.routing, status: "completed" },
	]);
	assert.equal(f.sent.length, 0, "the wait result is the sole model-visible delivery");
});

test("an aborted event wait consumes nothing and automatic steering remains armed", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Dependency", mode: "background" }, undefined, undefined, f.ctx);
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
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Legacy", mode: "background" }, undefined, undefined, f.ctx);
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
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "First" }, undefined, undefined, f.ctx));
	const firstHandle = f.services[0]!.snapshots.get(initial.agentId)!.handle;
	const continuation = f.tools.get("subagent_continue").execute("continue", { agentId: initial.agentId, task: "Second" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.services[0]!.continuations[0]?.handle.continuationCapability, firstHandle.continuationCapability);
	f.services[0]!.finish(initial.agentId, "completed", "second report");
	const settled = await continuation;
	assert.match(settled.content[0].text, /general-purpose.*completed\nsecond report/);
	assert.notEqual(f.services[0]!.snapshots.get(initial.agentId)!.handle.continuationCapability, firstHandle.continuationCapability);
});

test("subagent_control exposes stop only and confirms terminal cancellation", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
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
	await first.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Wait", mode: "background" }, undefined, undefined, first.ctx);
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

test("omitted tier uses the configured agent default", async () => {
	const f = harness({ availableModels: TIER_CONTRACT_MODELS, loadCatalog: tierContractCatalog });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("default", {
		agent: "high-default",
		title: "Test bounded assignment",
		task: "Use the agent default",
		mode: "background",
	}, undefined, undefined, f.ctx);
	assert.equal(f.services[0]!.launches[0]!.model, "high");
	assert.equal(f.services[0]!.launches[0]!.routing?.requested.tier, "high");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("explicit tiers downshift medium and high defaults and upshift a low default", async () => {
	const f = harness({ availableModels: TIER_CONTRACT_MODELS, loadCatalog: tierContractCatalog });
	await f.fire("session_start", { reason: "startup" });
	for (const agent of ["medium-default", "high-default"]) {
		await f.tools.get("subagent_spawn").execute(`downshift-${agent}`, {
			agent,
			title: "Test bounded assignment",
			task: "Use Low",
			tier: "low",
			mode: "background",
		}, undefined, undefined, f.ctx);
	}
	await f.tools.get("subagent_spawn").execute("upshift", {
		agent: "low-default",
		title: "Test bounded assignment",
		task: "Use High",
		tier: "high",
		mode: "background",
	}, undefined, undefined, f.ctx);
	assert.deepEqual(f.services[0]!.launches.map((launch) => launch.model), ["low", "low", "high"]);
	assert.deepEqual(f.services[0]!.launches.map((launch) => launch.routing?.requested.tier), ["low", "low", "high"]);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("a pinned agent model survives a differing tier and an explicit spawn model replaces it", async () => {
	const f = harness({ availableModels: TIER_CONTRACT_MODELS, loadCatalog: tierContractCatalog });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("pinned", {
		agent: "pinned",
		title: "Test bounded assignment",
		task: "Keep the pinned model",
		tier: "high",
		mode: "background",
	}, undefined, undefined, f.ctx);
	await f.tools.get("subagent_spawn").execute("replacement", {
		agent: "pinned",
		title: "Test bounded assignment",
		task: "Replace the pinned model",
		tier: "high",
		model: "provider/replacement#off",
		mode: "background",
	}, undefined, undefined, f.ctx);
	assert.equal(f.services[0]!.launches[0]!.model, "pinned");
	assert.equal(f.services[0]!.launches[0]!.routing?.requested.tier, "high");
	assert.equal(f.services[0]!.launches[1]!.model, "replacement");
	assert.equal(f.services[0]!.launches[1]!.routing?.requested.model, "provider/replacement");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone user model override launches an unconfigured registered model", async () => {
	const f = harness({ availableModels: [model(), model("ollama-cloud", "glm-5.3-flash")] });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", {
		agent: "general-purpose",
		title: "Test bounded assignment",
		task: "Override",
		mode: "background",
		model: "ollama-cloud/glm-5.3-flash#off",
	}, undefined, undefined, f.ctx);
	assert.equal(f.services[0]!.launches[0]!.provider, "ollama-cloud");
	assert.equal(f.services[0]!.launches[0]!.model, "glm-5.3-flash");
	assert.equal(f.services[0]!.launches[0]!.effort, "off");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone user model override ignores a stale scoped-model snapshot", async () => {
	const current = model("ollama-cloud", "glm-5.3-flash", true);
	const stale = model("ollama-cloud", "glm-5.3-flash", false);
	const f = harness({ availableModels: [model(), current], scopedModels: [{ model: stale }] });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", {
		agent: "general-purpose",
		title: "Test bounded assignment",
		task: "Override",
		mode: "background",
		model: "ollama-cloud/glm-5.3-flash#high",
	}, undefined, undefined, f.ctx);
	assert.equal(f.services[0]!.launches[0]!.provider, "ollama-cloud");
	assert.equal(f.services[0]!.launches[0]!.effort, "high");
	assert.equal(f.modelRefreshes.length, 0);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone user model override refreshes stale provider metadata before fallback", async () => {
	const stale = model("ollama-cloud", "glm-5.3-flash", false);
	const refreshed = model("ollama-cloud", "glm-5.3-flash", true);
	const f = harness({ availableModels: [model(), stale], refreshedModels: [model(), refreshed] });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", {
		agent: "general-purpose",
		title: "Test bounded assignment",
		task: "Refresh",
		mode: "background",
		model: "ollama-cloud/glm-5.3-flash#high",
	}, undefined, undefined, f.ctx);
	assert.deepEqual(f.modelRefreshes, [{ providers: ["ollama-cloud"] }]);
	assert.equal(f.services[0]!.launches[0]!.provider, "ollama-cloud");
	assert.equal(f.services[0]!.launches[0]!.effort, "high");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone user model override falls back to the configured same-tier list", async () => {
	const f = harness({ availableModels: [model()] });
	await f.fire("session_start", { reason: "startup" });
	await f.tools.get("subagent_spawn").execute("spawn", {
		agent: "general-purpose",
		title: "Test bounded assignment",
		task: "Fallback",
		allowFallback: true,
		mode: "background",
		model: "ollama-cloud/missing#off",
	}, undefined, undefined, f.ctx);
	assert.equal(f.services[0]!.launches[0]!.provider, "openai-codex");
	assert.equal(f.services[0]!.launches[0]!.model, "gpt-5.6-sol");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone model resolution treats nonempty scoped models as the complete available set", async () => {
	const f = harness({
		availableModels: [model()],
		scopedModels: [{ model: model("other", "unconfigured") }],
	});
	await f.fire("session_start", { reason: "startup" });
	await assert.rejects(
		f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Scoped" }, undefined, undefined, f.ctx),
		/No available subagent model could satisfy the request/,
	);
	assert.equal(f.services[0]!.launches.length, 0);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("an already-aborted continuation is rejected before service spawn", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "First" }, undefined, undefined, f.ctx));
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
	const initial = await settleForeground(f, f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "First" }, undefined, undefined, f.ctx));
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
	await first.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Wait", mode: "background" }, undefined, undefined, first.ctx);
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
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	await f.fire("session_shutdown", { reason: "resume" });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(f.sent.length, 0);
});

test("tree navigation is cancelled only while this activation has active processes", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	assert.equal(await f.fire("session_before_tree"), undefined);
	await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Test bounded assignment", task: "Wait", mode: "background" }, undefined, undefined, f.ctx);
	assert.deepEqual(await f.fire("session_before_tree"), { cancel: true });
	assert.match(f.notices.at(-1) ?? "", /unavailable while subagents are active/);
	f.services[0]!.finish("agent-1");
	assert.equal(await f.fire("session_before_tree"), undefined);
});

test("spawn exposes the loaded Markdown catalog and refreshes custom descriptions on reload", async () => {
	let description = "Trace custom widget contracts without editing";
	const f = harness({ loadCatalog: () => {
		const loaded = catalog();
		loaded.config.agents["custom-scout"] = { ...loaded.config.agents["general-purpose"]!, description };
		return loaded;
	} });
	await f.fire("session_start", { reason: "startup" });
	assert.match(f.tools.get("subagent_spawn").description, /custom-scout \[default tier: medium\]: Trace custom widget contracts without editing/);
	assert.match(f.tools.get("subagent_spawn").description, /general-purpose \[default tier: medium\]: General/);
	await f.fire("session_shutdown", { reason: "reload" });
	description = "Inspect revised local widgets";
	await f.fire("session_start", { reason: "reload" });
	assert.match(f.tools.get("subagent_spawn").description, /custom-scout \[default tier: medium\]: Inspect revised local widgets/);
	assert.doesNotMatch(f.tools.get("subagent_spawn").description, /Trace custom/);
	const receipt = await f.tools.get("subagent_spawn").execute("custom", { agent: "custom-scout", title: "Test bounded assignment", task: "Look up widget", mode: "background" }, undefined, undefined, f.ctx);
	assert.equal(receipt.details.agent, "custom-scout");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("standalone model selection is strict by default, including shorthand aliases and invalid combinations", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	for (const routing of [{ model: "luna#max" }, { model: "ollama-cloud/missing#off" }, { model: "gpt-5.6-sol#high", effort: "low" }, { allowFallback: true }]) {
		await assert.rejects(f.tools.get("subagent_spawn").execute("bad", { agent: "general-purpose", title: "Test bounded assignment", task: "Do not launch", ...routing }, undefined, undefined, f.ctx), /exact model IDs|Conflicting model efforts|requires an explicit model/);
	}
	assert.equal(f.services[0]!.launches.length, 0);
	const receipt = await f.tools.get("subagent_spawn").execute("fallback", { agent: "general-purpose", title: "Test bounded assignment", task: "Fallback permitted", model: "luna#max", allowFallback: true, mode: "background" }, undefined, undefined, f.ctx);
	assert.match(receipt.content[0].text, /Fallback luna#max → openai-codex\/gpt-5.6-sol#medium \(model unavailable\)/);
	assert.equal(receipt.details.routing.fallbackUsed, true);
	assert.equal(receipt.details.routing.requested.model, "luna");
	assert.equal(receipt.details.resolved.effort, "medium");
	await f.fire("session_shutdown", { reason: "quit" });
});

test("tier effort preserves configured fallback effort rather than pinning the unavailable primary", async () => {
	const f = harness({ availableModels: [model("ollama-cloud", "fallback", false)], loadCatalog: () => {
		const loaded = catalog();
		loaded.config.modelTierListProfiles.profiles.performance!.high = ["openai-codex/missing#medium", "ollama-cloud/fallback#off"];
		return loaded;
	} });
	await f.fire("session_start", { reason: "startup" });
	const receipt = await f.tools.get("subagent_spawn").execute("effort", { agent: "general-purpose", title: "Test bounded assignment", task: "Inspect", tier: "high", effort: "xhigh", mode: "background" }, undefined, undefined, f.ctx);
	assert.equal(receipt.details.resolved.model, "fallback");
	assert.equal(receipt.details.resolved.effort, "off");
	assert.equal(receipt.details.routing.requested.effort, "xhigh");
	assert.match(receipt.content[0].text, /Fallback openai-codex\/missing#xhigh → ollama-cloud\/fallback#off/);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("titles, routing and existing reports survive reload and continuation without prompt contamination", async () => {
	const f = harness({ availableModels: [{ ...model(), thinkingLevelMap: { high: "high", xhigh: "xhigh" } }] });
	await f.fire("session_start", { reason: "startup" });
	const receipt = await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "\u001b[31mFix RTL\n bubble corners\u001b[0m", task: "Original assignment", tier: "high", effort: "xhigh", mode: "background" }, undefined, undefined, f.ctx);
	const id = receipt.details.agentId;
	assert.equal(receipt.details.title, "Fix RTL bubble corners");
	const status = await f.tools.get("subagent_status").execute("status", { agentId: id }, undefined, undefined, f.ctx);
	assert.equal(status.details.agents[0].title, receipt.details.title);
	assert.deepEqual(status.details.agents[0].routing, receipt.details.routing);
	assert.equal(f.services[0]!.launches[0]!.attemptUserPrompt, "Original assignment");
	assert.doesNotMatch(f.services[0]!.launches[0]!.stableSystemContext, /Fix RTL bubble corners/);
	const read = (args: Record<string, unknown>) => f.tools.get("subagent_read").execute("read", { agentId: id, ...args }, undefined, undefined, f.ctx);
	await assert.rejects(read({}), /still active/);
	f.services[0]!.finish(id, "completed", "🙂αβγ".repeat(4_000));
	await f.fire("session_shutdown", { reason: "reload" });
	await f.fire("session_start", { reason: "reload" });
	const page = await read({ limit: 3 });
	assert.equal(page.details.title, "Fix RTL bubble corners");
	assert.equal(page.details.count, 3);
	assert.equal(page.details.totalCharacters, 16_000);
	assert.equal(page.details.nextOffset, 3);
	assert.ok(page.content[0].text.endsWith("🙂αβ"));
	const next = await read({ offset: page.details.nextOffset, attemptId: page.details.attemptId, limit: 3 });
	assert.ok(next.content[0].text.endsWith("γ🙂α"));
	assert.equal(f.services[0]!.continuations.length, 0);
	assert.equal(f.services.length, 1, "reload rebinds the service rather than launching or restoring from disk");
	f.pi.events.emit(MODEL_TIER_PROFILE_EVENT, { profile: "token-conservative" });
	const continued = f.tools.get("subagent_continue").execute("continue", { agentId: id, task: "New assignment" }, undefined, undefined, f.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	f.services[0]!.finish(id, "completed", "New report");
	const settled = await continued;
	assert.equal(settled.details.title, "Fix RTL bubble corners");
	assert.equal(settled.details.tier, "high");
	assert.equal(settled.details.resolved.effort, "xhigh");
	assert.deepEqual(settled.details.routing, receipt.details.routing);
	await assert.rejects(read({ attemptId: page.details.attemptId }), /Report attempt changed/);
	await f.services[0]!.release(f.services[0]!.owner, f.services[0]!.snapshots.get(id)!.handle);
	await assert.rejects(read({}), /Unknown standalone/);
	await f.fire("session_shutdown", { reason: "quit" });
});

test("background truncation directs report reads and failed reports remain readable without continuation", async () => {
	const f = harness();
	await f.fire("session_start", { reason: "startup" });
	const spawned = await f.tools.get("subagent_spawn").execute("spawn", { agent: "general-purpose", title: "Inspect failure", task: "Inspect", mode: "background" }, undefined, undefined, f.ctx);
	f.services[0]!.finish(spawned.details.agentId, "failed", "Failure report\n" + "x".repeat(5_000));
	await waitUntil(() => f.sent.length > 0, "background result did not arrive");
	assert.match(f.sent[0].message.content, /Inspect failure/);
	assert.match(f.sent[0].message.content, /subagent_read/);
	assert.match(f.sent[0].message.content, /attemptId/);
	const report = await f.tools.get("subagent_read").execute("read", { agentId: spawned.details.agentId }, undefined, undefined, f.ctx);
	assert.equal(report.details.state, "failed");
	assert.equal(report.details.totalCharacters, 5_015);
	assert.ok(report.content[0].text.endsWith("x".repeat(5_000)));
	assert.equal(f.services[0]!.continuations.length, 0);
	const oldId = spawned.details.agentId;
	await f.fire("session_shutdown", { reason: "quit" });
	await f.fire("session_start", { reason: "startup" });
	await assert.rejects(f.tools.get("subagent_read").execute("old", { agentId: oldId }, undefined, undefined, f.ctx), /Unknown standalone/);
	await f.fire("session_shutdown", { reason: "quit" });
});
