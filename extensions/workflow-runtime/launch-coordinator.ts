import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	classifyProviderFailure,
	defaultProviderCooldowns,
	isFallbackEligible,
	type ProviderCooldowns,
	type ProviderRoute,
} from "../provider-fallback/index.js";
import type { LogicalAgentSnapshot, PromptContextHashes, SubagentEvent, SubagentService, TerminalResult } from "../subagent/api.js";
import { promptContextHashes } from "../subagent/prompt-context.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../subagent/tool-policy.js";
import { isSubagentFastActive } from "../fast-mode/runtime.js";
import type { FastCapabilityTier } from "../fast-mode/policy.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { SessionAgentRegistry, type AgentScope, type ProcessAttempt, type ProcessAttemptTiming, type SessionAgentRecord, type WorkflowActivityDescriptor } from "./agent-registry.js";
import { initialAgentProgress, markAgentProcessExited, markAgentProcessStarted, projectAgentProgress, type AgentProgress } from "../subagent/agent-progress.js";

export interface CoordinatedLaunchInput extends AgentScope {
	operationId: string;
	existingAgentId?: string;
	role: string;
	task: string;
	assignment: unknown;
	cwd: string;
	provider: string;
	model: string;
	effort: string;
	capabilityTier?: FastCapabilityTier;
	activity?: WorkflowActivityDescriptor;
	providerCandidates?: ProviderRoute[];
	tools: string[];
	promptPath?: string;
	agentPrompt?: string;
	additionalPrompt?: string;
	extensionPaths?: string[];
	persistentContext?: string;
	skillPaths?: string[];
	env?: Record<string, string>;
	signal?: AbortSignal;
	onText?: (text: string) => void;
	onStarted?: (agent: SessionAgentRecord) => void;
	onProgress?: (progress: AgentProgress) => void;
	onSpawn?: (pid: number | undefined) => void | Promise<void>;
	/** Existing service child rebound after extension/runtime replacement. */
	onRebind?: () => void | Promise<void>;
	/** Durable credential fence committed after attempt allocation and before process launch. */
	onAttemptReady?: (agent: SessionAgentRecord, attempt: ProcessAttempt) => void | Promise<void>;
	/** Revalidated at the service boundary and again inside the service before OS spawn. */
	beforeServiceLaunch?: (agent: SessionAgentRecord, attempt: ProcessAttempt) => void | Promise<void>;
	deferCompletion?: boolean;
}

export interface CoordinatedAgentResult {
	exitCode: number;
	agent: string;
	provider: string;
	model: string;
	effort: string;
	text: string;
	stderr: string;
	events: unknown[];
	terminalReason: TerminalResult["reason"];
	serviceAttemptId: string;
	contextHashes?: PromptContextHashes;
	progress?: AgentProgress;
}

export interface CoordinatedLaunchResult {
	agent: SessionAgentRecord;
	result: CoordinatedAgentResult;
}

const ACTIVE_SERVICE_STATES = new Set(["launching", "running", "stopping"]);
const WORKFLOW_LOGICAL_AGENT_ID = "PIBOX_WORKFLOW_LOGICAL_AGENT_ID";
const WORKFLOW_ATTEMPT_ID = "PIBOX_WORKFLOW_ATTEMPT_ID";

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return left.provider === right.provider && left.model === right.model && left.effort === right.effort;
}

/** Workflow registry adapter over the standalone in-process SubagentService. */
export class LaunchCoordinator {
	constructor(
		readonly registry: SessionAgentRegistry,
		readonly mainAgentId: string,
		readonly service: SubagentService,
		readonly extensionPaths: string[] = [],
		readonly cooldowns: ProviderCooldowns = defaultProviderCooldowns,
	) {
		if (!service) throw new Error("LaunchCoordinator requires the standalone SubagentService");
	}

	async launch(input: CoordinatedLaunchInput): Promise<CoordinatedLaunchResult> {
		return this.launchWithService(input, this.service);
	}

	inspect(logicalAgentId: string): LogicalAgentSnapshot | undefined {
		return this.service.inspect(this.service.owner, {
			workflowMetadata: {
				PIBOX_WORKFLOW_SESSION_ID: this.registry.sessionId,
				[WORKFLOW_LOGICAL_AGENT_ID]: logicalAgentId,
			},
		}).find((agent) => ACTIVE_SERVICE_STATES.has(agent.state));
	}

	async stop(logicalAgentId: string): Promise<boolean> {
		const active = this.inspect(logicalAgentId);
		if (!active) return false;
		await this.service.stop(this.service.owner, active.handle);
		// stop() returns only after exit and output drain; wait also gives callers a
		// stable confirmation when another observer initiated the same stop.
		await this.service.wait(this.service.owner, active.handle);
		return true;
	}

	/** Delete a settled child transcript only after the workflow loop has ended. */
	async release(logicalAgentId: string): Promise<boolean> {
		const settled = this.service.inspect(this.service.owner, {
			workflowMetadata: {
				PIBOX_WORKFLOW_SESSION_ID: this.registry.sessionId,
				[WORKFLOW_LOGICAL_AGENT_ID]: logicalAgentId,
			},
		}).filter((agent) => !ACTIVE_SERVICE_STATES.has(agent.state));
		for (const agent of settled) await this.service.release(this.service.owner, agent.handle);
		return settled.length > 0;
	}

	private async launchWithService(input: CoordinatedLaunchInput, service: SubagentService): Promise<CoordinatedLaunchResult> {
		if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("Subagent launch aborted", "AbortError");
		const primary: ProviderRoute = { provider: input.provider, model: input.model, effort: input.effort };
		const configured = input.providerCandidates?.length ? input.providerCandidates : [primary];
		const routes = configured.some((route) => sameRoute(route, primary)) ? [...configured] : [primary, ...configured];
		const reserved = input.existingAgentId
			? await this.registry.bindScope(input.existingAgentId, scope(input))
			: await this.registry.reserve({
				operationId: input.operationId,
				parentAgentId: this.mainAgentId,
				parentDepth: 0,
				role: input.role,
				provider: primary.provider,
				model: primary.model,
				effort: primary.effort,
				assignment: input.assignment,
				...scope(input),
			});
		const agentRoot = join(this.registry.root, "agents", reserved.id);
		const stableSystemContext = await workflowSystemContext(input);
		const contextHashes = promptContextHashes(stableSystemContext, input.task);
		const extensionPaths = input.extensionPaths ?? this.extensionPaths;
		const skillPaths = input.skillPaths ?? [];
		const { environment, credentials } = splitCredentials(input.env ?? {});
		let lastResult: CoordinatedAgentResult | undefined;

		try {
			for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
				const route = routes[routeIndex]!;
				if (!this.cooldowns.available(route.provider)) continue;
				const fast = isSubagentFastActive(input.capabilityTier, route);
				const continuationKey = configurationKey({ input, route, fast, stableSystemContext, extensionPaths, skillPaths });
				const workflowMetadata = {
					PIBOX_WORKFLOW_SESSION_ID: this.registry.sessionId,
					[WORKFLOW_LOGICAL_AGENT_ID]: reserved.id,
				};
				const candidates = service.inspect(service.owner, { workflowMetadata });
				const current = await this.registry.get(reserved.id);
				const durableActiveAttempt = current.attempts.find((attempt) => attempt.id === current.currentAttemptId && (attempt.state === "launching" || attempt.state === "running"));
				const rebound = durableActiveAttempt ? candidates.find((agent) =>
					ACTIVE_SERVICE_STATES.has(agent.state)
					&& agent.attemptMetadata?.[WORKFLOW_ATTEMPT_ID] === durableActiveAttempt.id
					&& agent.continuationKey === continuationKey
				) : undefined;
				const attempt = durableActiveAttempt && rebound
					? durableActiveAttempt
					: (await this.registry.startAttempt(reserved.id, { ...route, ...(input.capabilityTier ? { tier: input.capabilityTier } : {}) }, input.activity, fast, contextHashes)).attempt;
				const attemptAgent = await this.registry.get(reserved.id);
				input.onStarted?.(attemptAgent);
				if (durableActiveAttempt && rebound) await input.onRebind?.();
				else await input.onAttemptReady?.(attemptAgent, attempt);
				if (input.signal?.aborted && !rebound) {
					const settledAt = new Date().toISOString();
					let cancelledProgress = attempt.progress ?? initialAgentProgress(attempt.startedAt);
					cancelledProgress = markAgentProcessExited(cancelledProgress, settledAt);
					cancelledProgress = projectAgentProgress(cancelledProgress, { type: "agent_settled" }, settledAt);
					const settlement = await this.registry.settleAttempt(reserved.id, attempt.id, {
						exitCode: 1,
						reason: "explicit_stop",
						targetState: "cancelled",
						error: "Subagent was explicitly stopped before process launch",
						progress: cancelledProgress,
						timing: { ...(attempt.timing ?? { attemptStartedAt: attempt.startedAt }), settledAt },
						contextHashes: attempt.contextHashes ?? contextHashes,
					});
					return { agent: settlement.agent, result: { exitCode: 1, agent: input.role, provider: route.provider, model: route.model, effort: route.effort, text: "", stderr: "", events: [], terminalReason: "explicit_stop", serviceAttemptId: attempt.id, contextHashes: attempt.contextHashes ?? contextHashes, progress: cancelledProgress } };
				}
				let progress = attempt.progress ?? initialAgentProgress(attempt.startedAt);
				let timing: ProcessAttemptTiming = structuredClone(attempt.timing ?? { attemptStartedAt: attempt.startedAt });
				let processStateDurable = durableActiveAttempt === attempt && current.state === "running";
				const publishProgress = () => {
					if (progress.processStartedAt && !processStateDurable) return;
					input.onProgress?.(structuredClone(progress));
				};
				publishProgress();
				const attemptMetadata = workflowAttemptMetadata(input, reserved, attempt, agentRoot, this.registry.root, this.mainAgentId);
				const beforeCursor = service.replay(service.owner).snapshot.cursor;
				let serviceAgentId = rebound?.handle.agentId;
				const observe = (event: SubagentEvent) => {
					if (event.agentId !== serviceAgentId) return;
					const observedAt = event.at;
					timing.childReadyAt ??= observedAt;
					timing.firstActivityAt ??= observedAt;
					timing.lastActivityAt = observedAt;
					if (event.type === "tool_activity") timing.firstToolAt ??= observedAt;
					if (event.type === "final_message") timing.reportReadyAt ??= observedAt;
					if (event.type === "process_exited") timing.processExitedAt ??= observedAt;
					if (event.type === "output_drained") timing.outputDrainedAt ??= observedAt;
					const projected = service.inspect(service.owner, { workflowMetadata }).find((agent) => agent.handle.agentId === event.agentId)?.progress;
					if (projected) progress = structuredClone(projected);
					publishProgress();
				};
				let subscription: ReturnType<SubagentService["subscribe"]> | undefined;
				let removeAbort: () => void = () => undefined;
				let terminal: TerminalResult;
				try {
					let resultPromise: Promise<TerminalResult>;
					if (rebound) {
						resultPromise = service.wait(service.owner, rebound.handle);
					} else {
						const reusable = candidates
							.filter((agent) => !ACTIVE_SERVICE_STATES.has(agent.state) && agent.continuationKey === continuationKey)
							.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
						const assertBeforeSpawn = async () => {
							if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("Subagent launch aborted", "AbortError");
							await input.beforeServiceLaunch?.(attemptAgent, attempt);
							if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("Subagent launch aborted", "AbortError");
						};
						// The outer check keeps services that implement only the base protocol fail
						// closed. The callback on the spec closes invocation-resolution races in the
						// in-process manager immediately before OS spawn.
						await assertBeforeSpawn();
						const started = reusable
							? await service.continue({ owner: service.owner, handle: reusable.handle, attemptUserPrompt: input.task, attemptMetadata, env: environment, workflowCredentials: credentials, beforeSpawn: assertBeforeSpawn })
							: await service.launch({
								owner: service.owner,
								agent: input.role,
								cwd: input.cwd,
								stableSystemContext,
								attemptUserPrompt: input.task,
								provider: route.provider,
								model: route.model,
								effort: route.effort,
								tools: input.tools,
								extensionPaths,
								skillPaths,
								fast,
								continuationKey,
								env: environment,
								workflowCredentials: credentials,
								workflowMetadata,
								attemptMetadata,
								beforeSpawn: assertBeforeSpawn,
							});
						serviceAgentId = started.handle.agentId;
						const snapshot = service.inspect(service.owner, { handle: started.handle })[0];
						const spawnedAt = snapshot?.startedAt ?? new Date().toISOString();
						timing.processSpawnedAt ??= spawnedAt;
						progress = snapshot?.progress ?? markAgentProcessStarted(progress, spawnedAt);
						await this.registry.markRunning(reserved.id, attempt.id, spawnedAt);
						processStateDurable = true;
						publishProgress();
						try {
							await input.onSpawn?.(snapshot?.processId);
						} catch (error) {
							await service.stop(service.owner, started.handle).catch(() => undefined);
							await service.wait(service.owner, started.handle).catch(() => undefined);
							throw error;
						}
						resultPromise = started.result;
					}
					subscription = service.subscribe(service.owner, beforeCursor, observe);
					for (const event of subscription.initial.events) observe(event);
					const activeHandle = service.inspect(service.owner, { workflowMetadata }).find((agent) => agent.handle.agentId === serviceAgentId)?.handle;
					if (input.signal && activeHandle) {
						const stop = () => { void service.stop(service.owner, activeHandle).catch(() => undefined); };
						if (input.signal.aborted) stop();
						else input.signal.addEventListener("abort", stop, { once: true });
						removeAbort = () => input.signal?.removeEventListener("abort", stop);
					}
					terminal = await resultPromise;
				} finally {
					removeAbort();
					subscription?.unsubscribe();
				}
				const outputDrainedAt = timing.outputDrainedAt ?? new Date().toISOString();
				timing.outputDrainedAt = outputDrainedAt;
				timing.processExitedAt ??= outputDrainedAt;
				progress = terminal.progress ?? markAgentProcessExited(progress, timing.processExitedAt);
				if (!progress.processExitedAt) progress = markAgentProcessExited(progress, timing.processExitedAt);
				if (!progress.settledAt) progress = projectAgentProgress(progress, { type: "agent_settled" }, outputDrainedAt);
				timing.settledAt = progress.settledAt ?? outputDrainedAt;
				timing.childReadyAt ??= timing.firstActivityAt ?? timing.processExitedAt;
				publishProgress();
				const result = coordinatedResult(input.role, route, terminal);
				const failure = classifyProviderFailure(result, input.signal);
				const providerFailure = terminal.reason === "failure" && isFallbackEligible(failure);
				const hasLaterRoute = routes.slice(routeIndex + 1).some((candidate) => this.cooldowns.available(candidate.provider));
				const targetState = terminal.reason === "owner_lost"
					? "interrupted"
					: terminal.reason === "explicit_stop"
						? "cancelled"
						: providerFailure
							? "waiting_capacity"
							: result.exitCode === 0
								? input.deferCompletion ? "reported" : "completed"
								: "failed";
				const summary = result.exitCode === 0 ? result.text || `${input.role} completed` : undefined;
				const error = targetState === "interrupted"
					? "Subagent owner activation was lost"
					: targetState === "cancelled"
						? "Subagent was explicitly stopped"
						: providerFailure
							? `${failure.kind} on ${route.provider}/${route.model}`
							: result.stderr || result.text || `Child exited ${result.exitCode}`;
				const settlement = await this.registry.settleAttempt(reserved.id, attempt.id, {
					exitCode: providerFailure && result.exitCode === 0 ? 1 : result.exitCode,
					reason: terminal.reason,
					targetState,
					...(summary ? { summary } : {}),
					...(error ? { error } : {}),
					progress,
					timing,
					contextHashes: terminal.contextHashes,
				});
				lastResult = result;
				if (!settlement.claimed) return { agent: settlement.agent, result };
				if (["waiting_decision", "blocked", "paused", "interrupted", "recovery_required", "cancelled"].includes(settlement.agent.state)) return { agent: settlement.agent, result };
				if (providerFailure) {
					this.cooldowns.mark(route.provider, failure.cooldownMs);
					if (hasLaterRoute) continue;
				}
				if (result.exitCode === 0 && result.text) input.onText?.(result.text);
				return { agent: settlement.agent, result };
			}

			const result = lastResult ?? {
				exitCode: 1,
				agent: input.role,
				provider: primary.provider,
				model: primary.model,
				effort: primary.effort,
				text: "",
				stderr: "All configured provider routes are cooling down",
				events: [],
				terminalReason: "failure" as const,
				serviceAttemptId: "unavailable",
			};
			const current = await this.registry.get(reserved.id);
			const waiting = current.state === "waiting_capacity" ? current : await this.registry.transition(reserved.id, "waiting_capacity", { error: result.stderr });
			return { agent: waiting, result };
		} catch (error) {
			const current = await this.registry.get(reserved.id);
			const attempt = current.attempts.find((candidate) => candidate.id === current.currentAttemptId);
			if (attempt && (attempt.state === "launching" || attempt.state === "running")) {
				const now = new Date().toISOString();
				let progress = attempt.progress ?? initialAgentProgress(attempt.startedAt);
				if (attempt.state === "running" && !progress.processStartedAt) progress = markAgentProcessStarted(progress, attempt.timing?.processSpawnedAt ?? now);
				progress = markAgentProcessExited(progress, now);
				if (!progress.settledAt) progress = projectAgentProgress(progress, { type: "agent_settled" }, now);
				await this.registry.settleAttempt(reserved.id, attempt.id, {
					exitCode: 1,
					reason: "failure",
					targetState: "failed",
					error: error instanceof Error ? error.message : String(error),
					progress,
					timing: { ...(attempt.timing ?? { attemptStartedAt: attempt.startedAt }), processExitedAt: now, outputDrainedAt: now, settledAt: progress.settledAt ?? now },
					...(attempt.contextHashes ? { contextHashes: attempt.contextHashes } : {}),
				}).catch(() => undefined);
			}
			throw error;
		}
	}
}

function scope(input: AgentScope): AgentScope {
	return {
		...(input.workItemId ? { workItemId: input.workItemId } : {}),
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.evaluationId ? { evaluationId: input.evaluationId } : {}),
		...(input.runId ? { runId: input.runId } : {}),
		...(input.workspace ? { workspace: input.workspace } : {}),
	};
}

async function workflowSystemContext(input: CoordinatedLaunchInput): Promise<string> {
	let agentPrompt: string;
	try {
		if (!input.agentPrompt && !input.promptPath) throw new Error("No agent definition supplied");
		const supplied = input.agentPrompt ?? await readFile(input.promptPath!, "utf8");
		agentPrompt = parseFrontmatter<Record<string, unknown>>(supplied).body;
	} catch {
		agentPrompt = renderBuiltInPrompt("default-agent", { agent: input.role });
	}
	return [agentPrompt.trim(), input.additionalPrompt?.trim(), input.persistentContext?.trim()].filter(Boolean).join("\n\n");
}

function configurationKey(value: {
	input: CoordinatedLaunchInput;
	route: ProviderRoute;
	fast: boolean;
	stableSystemContext: string;
	extensionPaths: readonly string[];
	skillPaths: readonly string[];
}): string {
	return createHash("sha256").update(JSON.stringify({
		agent: value.input.role,
		cwd: value.input.cwd,
		provider: value.route.provider,
		model: value.route.model,
		effort: value.route.effort,
		tools: value.input.tools,
		extensionPaths: value.extensionPaths,
		skillPaths: value.skillPaths,
		fast: value.fast,
		stableSystemContext: value.stableSystemContext,
	})).digest("hex");
}

function workflowAttemptMetadata(
	input: CoordinatedLaunchInput,
	reserved: SessionAgentRecord,
	attempt: ProcessAttempt,
	agentRoot: string,
	registryRoot: string,
	mainAgentId: string,
): Record<string, string> {
	return {
		PIBOX_WORKFLOW_SESSION_ID: reserved.sessionId,
		[WORKFLOW_LOGICAL_AGENT_ID]: reserved.id,
		[WORKFLOW_ATTEMPT_ID]: attempt.id,
		PIBOX_WORKFLOW_OPERATION_ID: input.operationId,
		...(input.runId ? { PIBOX_WORKFLOW_RUN_ID: input.runId } : {}),
		...(input.workItemId ? { PIBOX_WORKFLOW_WORK_ITEM_ID: input.workItemId } : {}),
		...(input.taskId ? { PIBOX_WORKFLOW_TASK_ID: input.taskId } : {}),
		...(input.evaluationId ? { PIBOX_WORKFLOW_EVALUATION_ID: input.evaluationId } : {}),
		[PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE,
		PIBOX_SUBAGENT_ID: reserved.id,
		PIBOX_SUBAGENT_PARENT_ID: mainAgentId,
		PIBOX_SUBAGENT_DEPTH: String(reserved.depth),
		PIBOX_SUBAGENT_ATTEMPT_ID: attempt.id,
		PIBOX_HARNESS_AGENT_ATTEMPT_ID: attempt.id,
		PIBOX_HARNESS_AGENT_GENERATION: String(attempt.sequence),
		PIBOX_SUBAGENT_ROOT: agentRoot,
		PIBOX_SUBAGENT_STORE_ROOT: dirname(dirname(registryRoot)),
		PIBOX_SUBAGENT_ASSIGNMENT_PATH: join(registryRoot, reserved.assignmentPath),
		PIBOX_SUBAGENT_AGENT: reserved.role,
		PIBOX_SUBAGENT_ROLE: reserved.role,
	};
}

function splitCredentials(env: Readonly<Record<string, string>>): { environment: Record<string, string>; credentials: Record<string, string> } {
	const environment: Record<string, string> = {};
	const credentials: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (/(?:CREDENTIAL|TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)) credentials[key] = value;
		else environment[key] = value;
	}
	return { environment, credentials };
}

function coordinatedResult(agent: string, route: ProviderRoute, terminal: TerminalResult): CoordinatedAgentResult {
	const exitCode = terminal.status === "completed" ? terminal.exitCode ?? 0 : terminal.exitCode && terminal.exitCode !== 0 ? terminal.exitCode : 1;
	return {
		exitCode,
		agent,
		provider: route.provider,
		model: route.model,
		effort: route.effort,
		text: terminal.text,
		stderr: terminal.stderr ?? "",
		events: [],
		terminalReason: terminal.reason,
		serviceAttemptId: terminal.attemptId,
		contextHashes: terminal.contextHashes,
		...(terminal.progress ? { progress: terminal.progress } : {}),
	};
}
