import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	DEFAULT_FAST_MODE_POLICY,
	FAST_MODE_POLICY_EVENT,
	isChatGptFastRoute,
	normalizeFastModePolicy,
	subagentFastEnabled,
	type FastModePolicy,
} from "../fast-mode/policy.js";
import { MODEL_TIER_PROFILE_EVENT, normalizeModelTierProfilePolicy } from "../model-tier-list-profiles/policy.js";
import { assertTreeNavigationAllowed, type ActivationLifecycle } from "./activation.js";
import type { LogicalAgentHandle, LogicalAgentSnapshot, RuntimeOwner, SubagentService, TerminalResult } from "./api.js";
import { loadSubagentCatalog, type LoadSubagentCatalogOptions } from "./catalog.js";
import { STANDALONE_CHILD_EXTENSION_PATHS } from "./child-extensions.js";
import { assemblePromptContext } from "./prompt-context.js";
import { mcpLaunchEnvironment } from "./mcp-capabilities.js";
import { normalizeExplicitModelOverride, resolveSubagentModel } from "./model-resolver.js";
import { SubagentProcessManager } from "./process-manager.js";
import {
	getPendingSubagentDeliveryRegistry,
	type PendingBackgroundDelivery,
	type PendingBackgroundOutcome,
	type PendingDeliveryBinding,
	type PendingSubagentDeliveryRegistry,
} from "./pending-deliveries.js";
import { getSubagentProcessInstanceId } from "./process-instance.js";
import { getSubagentCapabilityRegistry, type SubagentCapabilityRegistry, type SubagentRegistration } from "./registry.js";
import {
	DEFAULT_SUBAGENT_TOOLS,
	isSubagentRuntime,
	resolveSubagentToolSelectors,
} from "./tool-policy.js";
import type { HarnessEffort, LoadedSubagentCatalog, ModelTier } from "./types.js";
import {
	getSubagentUiProjectionRegistry,
	type SubagentUiAgentProjection,
	type SubagentUiProjectionBinding,
	type SubagentUiProjectionRegistry,
} from "./ui-projection.js";

const MAX_STATUS_AGENTS = 20;
const MAX_TOOL_OUTPUT_BYTES = 48 * 1024;
const ACTIVE_STATES = new Set(["launching", "running", "stopping"]);

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

type CatalogLoader = (repositoryRoot: string, options?: LoadSubagentCatalogOptions) => LoadedSubagentCatalog;

export interface SubagentExtensionDependencies {
	readonly env?: NodeJS.ProcessEnv;
	readonly registry?: SubagentCapabilityRegistry;
	readonly uiRegistry?: SubagentUiProjectionRegistry;
	readonly pendingDeliveries?: PendingSubagentDeliveryRegistry;
	readonly processInstanceId?: string;
	readonly idFactory?: () => string;
	readonly loadCatalog?: CatalogLoader;
	readonly createService?: (owner: RuntimeOwner, ctx: ExtensionContext) => SubagentService | Promise<SubagentService>;
}

interface SessionBinding {
	readonly owner: RuntimeOwner;
	readonly registration: SubagentRegistration;
	readonly service: SubagentService;
	readonly ctx: ExtensionContext;
	readonly repositoryRoot: string;
	readonly catalog: LoadedSubagentCatalog;
	readonly presentations: Map<string, "foreground" | "background">;
	readonly tiers: Map<string, string>;
	readonly ui: SubagentUiProjectionBinding;
	delivery: PendingDeliveryBinding;
	unsubscribe: () => void;
	active: boolean;
}

/** Complete standalone generic subagent tool surface. */
export const STANDALONE_SUBAGENT_TOOL_NAMES = ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"] as const;

export default function subagentExtension(pi: ExtensionAPI, dependencies: SubagentExtensionDependencies = {}): void {
	const env = dependencies.env ?? process.env;
	if (isSubagentRuntime(env)) return;

	const registry = dependencies.registry ?? getSubagentCapabilityRegistry();
	const uiRegistry = dependencies.uiRegistry ?? getSubagentUiProjectionRegistry();
	const pendingDeliveries = dependencies.pendingDeliveries ?? getPendingSubagentDeliveryRegistry();
	const processInstanceId = dependencies.processInstanceId ?? getSubagentProcessInstanceId();
	const idFactory: () => string = dependencies.idFactory ?? (() => randomUUID());
	const catalogLoader = dependencies.loadCatalog ?? loadSubagentCatalog;
	let selectedModelTierProfile: string | undefined;
	let fastModePolicy: FastModePolicy = { ...DEFAULT_FAST_MODE_POLICY };
	let binding: SessionBinding | undefined;

	pi.events.on(MODEL_TIER_PROFILE_EVENT, (value: unknown) => {
		const policy = normalizeModelTierProfilePolicy(value);
		if (!policy) return;
		selectedModelTierProfile = policy.profile;
		if (binding?.catalog.config.modelTierListProfiles.profiles[policy.profile]) binding.catalog.config.modelTierProfile = policy.profile;
	});
	pi.events.on(FAST_MODE_POLICY_EVENT, (value: unknown) => {
		const policy = normalizeFastModePolicy(value);
		if (policy) fastModePolicy = policy;
	});

	const requireBinding = (): SessionBinding => {
		if (!binding?.active) throw new Error("The standalone subagent service is not bound to the current session activation");
		return binding;
	};

	const publishProjection = (current: SessionBinding, snapshot = current.service.replay(current.owner).snapshot): void => {
		if (!current.active || binding !== current) return;
		const agents: SubagentUiAgentProjection[] = snapshot.agents.map((agent) => {
			const tier = current.tiers.get(agent.handle.agentId);
			return {
			agentId: agent.handle.agentId,
			agent: agent.agent,
			state: agent.state,
			presentation: current.presentations.get(agent.handle.agentId) ?? "background",
			provider: agent.provider,
			model: agent.model,
			effort: agent.effort,
			...(tier ? { tier } : {}),
			fast: agent.fast,
			startedAt: agent.startedAt,
			updatedAt: agent.updatedAt,
			...(agent.progress ? { progress: agent.progress } : {}),
		};
		});
		current.ui.publish(agents);
	};

	const agentSnapshot = (current: SessionBinding, agentId: string): LogicalAgentSnapshot | undefined =>
		current.service.replay(current.owner).snapshot.agents.find((agent) => agent.handle.agentId === agentId);

	const toolDetails = (current: SessionBinding, agentId: string, terminal?: TerminalResult) => {
		const snapshot = agentSnapshot(current, agentId);
		return {
			agentId,
			uiRef: { owner: structuredClone(current.owner), agentId },
			...(current.tiers.get(agentId) ? { tier: current.tiers.get(agentId) } : {}),
			...(snapshot ? {
				agent: snapshot.agent,
				state: snapshot.state,
				resolved: { provider: snapshot.provider, model: snapshot.model, effort: snapshot.effort, fast: snapshot.fast, startedAt: snapshot.startedAt },
				...(snapshot.progress ? { progress: snapshot.progress } : {}),
				processStatus: ACTIVE_STATES.has(snapshot.state) ? (snapshot.progress?.processStartedAt ? "active" : "starting") : undefined,
			} : {}),
			...(terminal ? { terminal } : {}),
		};
	};

	const subscribeToolUpdates = (
		current: SessionBinding,
		agentId: string,
		onUpdate: ((update: ReturnType<typeof result>) => void) | undefined,
	): (() => void) => {
		if (!onUpdate) return () => undefined;
		const afterCursor = current.service.replay(current.owner).snapshot.cursor;
		const subscription = current.service.subscribe(current.owner, afterCursor, (event) => {
			if (!current.active || binding !== current || event.agentId !== agentId) return;
			onUpdate(result("", toolDetails(current, agentId)));
		});
		onUpdate(result("", toolDetails(current, agentId)));
		return () => subscription.unsubscribe();
	};

	const stopOnAbort = (signal: AbortSignal | undefined, current: SessionBinding, handle: LogicalAgentHandle): (() => void) => {
		if (!signal) return () => undefined;
		const stop = () => { void current.service.stop(current.owner, handle).catch(() => undefined); };
		if (signal.aborted) stop();
		else signal.addEventListener("abort", stop, { once: true });
		return () => signal.removeEventListener("abort", stop);
	};

	const terminalResult = (current: SessionBinding, agentId: string, terminal: TerminalResult) => {
		const text = boundedUtf8(terminal.text || terminal.stderr || `Subagent ${terminal.status}.`, MAX_TOOL_OUTPUT_BYTES);
		if (terminal.status === "failed") throw new Error(text);
		return result(text, toolDetails(current, agentId, terminal));
	};

	const deliverBackground = (current: SessionBinding, delivery: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome): boolean => {
		if (!current.active || binding !== current) return false;
		const status = "terminal" in outcome ? outcome.terminal.status : "failed";
		const summary = boundedUtf8("terminal" in outcome
			? outcome.terminal.text || outcome.terminal.stderr || `Subagent ${status}.`
			: outcome.error, 1_200);
		try {
			pi.sendMessage({
				customType: "pibox-subagent-result",
				content: `[Subagent ${status}]\n${delivery.agent} (${delivery.agentId})\n${summary}`,
				display: false,
				details: { agent: delivery.agent, agentId: delivery.agentId, status, summary },
			}, { deliverAs: "followUp", triggerTurn: true });
			return true;
		} catch {
			return false;
		}
	};

	pi.registerTool({
		name: "subagent_spawn",
		label: "Spawn Subagent",
		description: "Launch one configured standalone subagent with a self-contained bounded assignment. Foreground waits and streams semantic progress; background returns immediately and sends one terminal follow-up only to the same live session activation.",
		parameters: Type.Object({
			agent: Type.String({ description: "Exact configured agent name" }),
			task: Type.String({ description: "Detailed self-contained assignment, scope, evidence, constraints, and stop conditions" }),
			mode: Type.Optional(StringEnum(["background", "foreground"] as const, { default: "foreground" })),
			tier: Type.Optional(StringEnum(["low", "medium", "high", "max", "local"] as const)),
			model: Type.Optional(Type.String({ description: "Configured model or provider/model, optionally suffixed with #effort" })),
			effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const current = requireBinding();
			if (ctx.sessionManager.getSessionId() !== current.owner.sessionId) throw new Error("Subagent launch context belongs to a replacement session");
			const resolved = resolveLaunch(current, params, fastModePolicy, ctx);
			const launched = await current.service.launch(resolved.spec);
			const agentId = launched.handle.agentId;
			const mode = params.mode ?? "foreground";
			current.presentations.set(agentId, mode);
			current.tiers.set(agentId, resolved.tier);
			publishProjection(current);
			if (mode === "background") {
				pendingDeliveries.track({ owner: current.owner, agent: params.agent, agentId }, launched.result);
				return result(`Spawned ${params.agent} in background as ${agentId}. Its terminal report will be delivered automatically to this activation.`, toolDetails(current, agentId));
			}
			const unsubscribe = subscribeToolUpdates(current, agentId, onUpdate);
			const removeAbort = stopOnAbort(signal, current, launched.handle);
			try {
				return terminalResult(current, agentId, await launched.result);
			} finally {
				removeAbort();
				unsubscribe();
			}
		},
	});

	pi.registerTool({
		name: "subagent_status",
		label: "Subagent Status",
		description: "Inspect this activation's bounded standalone subagent snapshot. This is a point-in-time diagnostic, not a polling mechanism.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String()),
			includeSettled: Type.Optional(Type.Boolean({ default: false })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_STATUS_AGENTS, default: 12 })),
		}, { additionalProperties: false }),
		async execute(_id, params) {
			const current = requireBinding();
			const limit = Math.min(MAX_STATUS_AGENTS, Math.max(1, params.limit ?? 12));
			const all = current.service.replay(current.owner).snapshot.agents
				.filter((agent) => !params.agentId || agent.handle.agentId === params.agentId)
				.filter((agent) => params.includeSettled === true || ACTIVE_STATES.has(agent.state))
				.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.handle.agentId.localeCompare(right.handle.agentId));
			const agents = all.slice(0, limit).map((agent) => ({
				agentId: agent.handle.agentId,
				agent: agent.agent,
				state: agent.state,
				provider: agent.provider,
				model: agent.model,
				effort: agent.effort,
				fast: agent.fast,
				startedAt: agent.startedAt,
				updatedAt: agent.updatedAt,
				...(agent.progress ? { progress: agent.progress } : {}),
				...(agent.summary ? { summary: agent.summary } : {}),
			}));
			const payload = { agents, count: all.length, returned: agents.length, hasMore: all.length > agents.length };
			return result(agents.length ? JSON.stringify(payload, null, 2) : "No matching subagents in this activation.", payload);
		},
	});

	pi.registerTool({
		name: "subagent_control",
		label: "Control Subagent",
		description: "Stop one active standalone subagent and wait for confirmed process exit.",
		parameters: Type.Object({ agentId: Type.String(), action: StringEnum(["stop"] as const) }, { additionalProperties: false }),
		async execute(_id, params) {
			const current = requireBinding();
			const target = agentSnapshot(current, params.agentId);
			if (!target) throw new Error(`Unknown subagent: ${params.agentId}`);
			await current.service.stop(current.owner, target.handle);
			return result(`Stop confirmed for ${params.agentId}.`, toolDetails(current, params.agentId));
		},
	});

	pi.registerTool({
		name: "subagent_continue",
		label: "Continue Subagent",
		description: "Run one new bounded terminal turn against a settled standalone subagent's same-activation transcript. The tool waits for settlement; there is no live respond surface.",
		parameters: Type.Object({ agentId: Type.String(), task: Type.String({ description: "New user turn for the settled logical agent" }) }, { additionalProperties: false }),
		async execute(_id, params, signal, onUpdate) {
			const current = requireBinding();
			if (signal?.aborted) throw abortError(signal);
			const target = agentSnapshot(current, params.agentId);
			if (!target) throw new Error(`Unknown subagent: ${params.agentId}`);
			if (ACTIVE_STATES.has(target.state)) throw new Error(`Subagent ${params.agentId} is still active`);
			current.presentations.set(params.agentId, "foreground");
			publishProjection(current);
			const unsubscribe = subscribeToolUpdates(current, params.agentId, onUpdate);
			let started: Awaited<ReturnType<SubagentService["continue"]>> | undefined;
			let abortRequested = false;
			let stopPromise: Promise<void> | undefined;
			const stopStarted = () => {
				abortRequested = true;
				if (started && !stopPromise) stopPromise = current.service.stop(current.owner, started.handle);
			};
			signal?.addEventListener("abort", stopStarted, { once: true });
			try {
				started = await current.service.continue({ owner: current.owner, handle: target.handle, attemptUserPrompt: params.task });
				if (abortRequested || signal?.aborted) {
					stopStarted();
					await stopPromise;
				}
				return terminalResult(current, params.agentId, await started.result);
			} finally {
				signal?.removeEventListener("abort", stopStarted);
				unsubscribe();
			}
		},
	});

	pi.on("session_before_tree", (_event, ctx) => {
		const current = binding;
		if (!current?.active) return;
		try { assertTreeNavigationAllowed(current.owner, current.service.replay(current.owner).snapshot); }
		catch {
			if (ctx.hasUI) ctx.ui.notify("Tree navigation is unavailable while subagents are active.", "warning");
			return { cancel: true };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		const lifecycle = event.reason as ActivationLifecycle;
		const repositoryRoot = findRepositoryRoot(ctx.cwd);
		const ownerRequest = {
			lifecycle,
			sessionId: ctx.sessionManager.getSessionId(),
			processInstanceId,
			// Ignored when reload rebinds successfully; used when /reload is the
			// first activation that includes this extension.
			activationId: idFactory(),
		};
		const createService = async (owner: RuntimeOwner) => dependencies.createService
			? dependencies.createService(owner, ctx)
			: new SubagentProcessManager({ owner, sessionDirectory: join(tmpdir(), "pibox-subagents", owner.processInstanceId, owner.activationId) });
		let registration: SubagentRegistration;
		try {
			registration = await registry.acquire(ownerRequest, createService);
		} catch (error) {
			// A process-global registry object created by the pre-fallback extension
			// keeps its old class method across hot reload. Retry that legacy object as
			// a fresh activation; subsequent reloads can rebind the created manager.
			if (lifecycle !== "reload" || !String(error).includes("Reload has no manager in this session and process to rebind")) throw error;
			registration = await registry.acquire({ ...ownerRequest, lifecycle: "startup" }, createService);
		}
		let catalog: LoadedSubagentCatalog;
		try {
			catalog = catalogLoader(repositoryRoot, {
				...(selectedModelTierProfile ? { modelTierProfile: selectedModelTierProfile } : {}),
				includeProject: ctx.isProjectTrusted(),
			});
		} catch (error) {
			await registration.unregister();
			pendingDeliveries.discard(registration.owner);
			await registry.teardown(registration.owner);
			throw error;
		}
		const presentations = new Map<string, "foreground" | "background">();
		const tiers = new Map<string, string>();
		const ui = uiRegistry.bind(registration.owner, idFactory());
		const current = {
			owner: registration.owner,
			registration,
			service: registration.service,
			ctx,
			repositoryRoot,
			catalog,
			presentations,
			tiers,
			ui,
			delivery: { release: () => false },
			unsubscribe: () => undefined,
			active: true,
		} as SessionBinding;
		const subscription = current.service.subscribe(current.owner, current.service.replay(current.owner).snapshot.cursor, () => publishProjection(current));
		current.unsubscribe = () => subscription.unsubscribe();
		binding = current;
		current.delivery = pendingDeliveries.bind(current.owner, idFactory(), (delivery, outcome) => deliverBackground(current, delivery, outcome));
		publishProjection(current, subscription.initial.snapshot);
	});

	pi.on("session_shutdown", async (event) => {
		const current = binding;
		if (!current) return;
		current.active = false;
		if (binding === current) binding = undefined;
		current.unsubscribe();
		current.ui.release();
		current.delivery.release();
		if (event.reason !== "reload") pendingDeliveries.discard(current.owner);
		await current.registration.unregister();
		if (event.reason !== "reload") await registry.teardown(current.owner);
	});
}

function resolveLaunch(
	binding: SessionBinding,
	params: { agent: string; task: string; tier?: ModelTier; model?: string; effort?: HarnessEffort },
	fastModePolicy: FastModePolicy,
	ctx: ExtensionContext,
): { tier: ModelTier; spec: Parameters<SubagentService["launch"]>[0] } {
	const agent = binding.catalog.config.agents[params.agent];
	if (!agent) throw new Error(`Unknown subagent definition: ${params.agent}. Available: ${Object.keys(binding.catalog.config.agents).sort().join(", ")}`);
	let tier: ModelTier = params.tier ?? (params.model?.trim().startsWith("local-llm/") ? "local" : agent.tier ?? "medium");
	if (params.model?.trim().startsWith("local-llm/") && params.tier && params.tier !== "local") throw new Error("local-llm models require tier local");
	const routingConfig = {
		modelTierListProfiles: binding.catalog.config.modelTierListProfiles,
		modelTierProfile: binding.catalog.config.modelTierListProfiles.profiles[binding.catalog.config.modelTierProfile]
			? binding.catalog.config.modelTierProfile
			: binding.catalog.config.modelTierListProfiles.defaultProfile,
	};
	let preferredModel = params.model ?? agent.model;
	if (!preferredModel && params.effort) {
		const route = routingConfig.modelTierListProfiles.profiles[routingConfig.modelTierProfile]?.[tier]?.[0];
		if (route) preferredModel = route.slice(0, route.lastIndexOf("#"));
	}
	const override = preferredModel ? normalizeExplicitModelOverride(preferredModel, params.effort) : undefined;
	if (preferredModel?.startsWith("local-llm/")) tier = "local";
	const availableModels = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	const resolution = resolveSubagentModel(routingConfig, availableModels, { tier, ...(override ? { override, strict: true } : {}) });
	if (resolution.status !== "resolved") throw new Error(`No configured subagent model is available: ${JSON.stringify(resolution.attempts)}`);
	const selectors = agent.tools ?? [...DEFAULT_SUBAGENT_TOOLS];
	const promptPath = resolveConfiguredPath(binding.repositoryRoot, agent.prompt);
	if (!promptPath) throw new Error(`Subagent ${params.agent} has no readable prompt definition`);
	const prompt = parseFrontmatter<Record<string, unknown>>(readFileSync(promptPath, "utf8")).body.trim();
	if (!prompt) throw new Error(`Subagent ${params.agent} prompt is empty`);
	const promptContext = assemblePromptContext({ stableSystemParts: [prompt], attemptUserPrompt: params.task }, {});
	const skillPaths = (agent.skills ?? []).map((skill) => resolveConfiguredPath(binding.repositoryRoot, skill)).filter((path): path is string => Boolean(path));
	const fast = subagentFastEnabled(fastModePolicy.subagents, tier) && isChatGptFastRoute(resolution.model.provider, resolution.model.id, resolution.model.api);
	return {
		tier,
		spec: {
			owner: binding.owner,
			agent: params.agent,
			cwd: binding.repositoryRoot,
			...promptContext,
			provider: resolution.model.provider,
			model: resolution.model.id,
			effort: resolution.effort,
			tools: resolveSubagentToolSelectors(selectors),
			extensionPaths: [...STANDALONE_CHILD_EXTENSION_PATHS],
			skillPaths,
			fast,
			env: mcpLaunchEnvironment(selectors),
		},
	};
}

function resolveConfiguredPath(repositoryRoot: string, configuredPath: string | undefined): string | undefined {
	if (!configuredPath) return undefined;
	const candidates = isAbsolute(configuredPath)
		? [configuredPath]
		: [join(repositoryRoot, ".pi", configuredPath), join(homedir(), ".pi", "agent", "harness", configuredPath), resolve(repositoryRoot, configuredPath)];
	return candidates.find(existsSync);
}

function findRepositoryRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git")) || existsSync(join(current, ".pi", "harness.yaml"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Subagent continuation was aborted");
}

function boundedUtf8(value: string, maximumBytes: number): string {
	const buffer = Buffer.from(value, "utf8");
	if (buffer.length <= maximumBytes) return value;
	let text = buffer.subarray(0, maximumBytes).toString("utf8");
	while (text.endsWith("�")) text = text.slice(0, -1);
	return `${text}\n\n[Subagent output truncated; the complete turn remains in its private transcript.]`;
}

export * from "./activation.js";
export * from "./agent-definitions.js";
export * from "./agent-progress.js";
export * from "./catalog.js";
export * from "./child-extensions.js";
export * from "./api.js";
export * from "./continuations.js";
export * from "./display.js";
export * from "./events.js";
export * from "./invocation.js";
export * from "./jsonl.js";
export * from "./mcp-capabilities.js";
export * from "./model-resolver.js";
export * from "./process-instance.js";
export * from "./process-manager.js";
export * from "./pending-deliveries.js";
export * from "./prompt-context.js";
export * from "./registry.js";
export * from "./tool-policy.js";
export * from "./types.js";
export * from "./ui-projection.js";
