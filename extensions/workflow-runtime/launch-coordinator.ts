import { dirname, join } from "node:path";
import {
	classifyProviderFailure,
	defaultProviderCooldowns,
	isFallbackEligible,
	type ProviderCooldowns,
	type ProviderRoute,
} from "../provider-fallback/index.js";
import { SessionAgentRegistry, type AgentScope, type ProcessAttemptTiming, type SessionAgentRecord, type WorkflowActivityDescriptor } from "./agent-registry.js";
import { runDirectAgent, type DirectAgentResult } from "./direct-agent.js";
import { initialAgentProgress, markAgentProcessExited, markAgentProcessStarted, projectAgentProgress, type AgentProgress } from "./agent-progress.js";
import { clearAgentLiveProgress, publishAgentLiveProgress } from "./agent-live-projection.js";
import { fastModeChildEnvironment, isSubagentFastActive } from "../fast-mode/runtime.js";
import type { FastCapabilityTier } from "../fast-mode/policy.js";

export interface CoordinatedLaunchInput extends AgentScope {
	operationId: string;
	existingAgentId?: string;
	role: string;
	task: string;
	assignment: unknown;
	presentation?: "foreground" | "background";
	cwd: string;
	provider: string;
	model: string;
	effort: string;
	/** Capability tier used by the parent session's subagent Fast-mode ceiling. */
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
	onSpawn?: (pid: number | undefined) => void;
	invocationResolver?: (args: string[]) => { command: string; args: string[] };
	deferCompletion?: boolean;
}

export interface CoordinatedLaunchResult {
	agent: SessionAgentRecord;
	result: DirectAgentResult;
}

function sameRoute(left: ProviderRoute, right: ProviderRoute): boolean {
	return left.provider === right.provider && left.model === right.model && left.effort === right.effort;
}

/** One process gateway shared by managed work and free-form subagent_spawn calls. */
export class LaunchCoordinator {
	constructor(
		readonly registry: SessionAgentRegistry,
		readonly mainAgentId: string,
		readonly invocationResolver?: (args: string[]) => { command: string; args: string[] },
		readonly extensionPaths: string[] = [],
		readonly cooldowns: ProviderCooldowns = defaultProviderCooldowns,
	) {}

	async launch(input: CoordinatedLaunchInput): Promise<CoordinatedLaunchResult> {
		const primary: ProviderRoute = { provider: input.provider, model: input.model, effort: input.effort };
		const configured = input.providerCandidates?.length ? input.providerCandidates : [primary];
		const routes = configured.some((route) => sameRoute(route, primary))
			? [...configured]
			: [primary, ...configured];
		const reserved = input.existingAgentId
			? await this.registry.bindScope(input.existingAgentId, {
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				...(input.taskId ? { taskId: input.taskId } : {}),
				...(input.evaluationId ? { evaluationId: input.evaluationId } : {}),
				...(input.runId ? { runId: input.runId } : {}),
				...(input.workspace ? { workspace: input.workspace } : {}),
			})
			: await this.registry.reserve({
				operationId: input.operationId,
				parentAgentId: this.mainAgentId,
				parentDepth: 0,
				role: input.role,
				...(input.presentation ? { presentation: input.presentation } : {}),
				provider: primary.provider,
				model: primary.model,
				effort: primary.effort,
				assignment: input.assignment,
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				...(input.taskId ? { taskId: input.taskId } : {}),
				...(input.evaluationId ? { evaluationId: input.evaluationId } : {}),
				...(input.runId ? { runId: input.runId } : {}),
				...(input.workspace ? { workspace: input.workspace } : {}),
			});
		const agentRoot = join(this.registry.root, "agents", reserved.id);
		const invocationResolver = input.invocationResolver ?? this.invocationResolver;
		let lastResult: DirectAgentResult | undefined;

		try {
			for (let routeIndex = 0; routeIndex < routes.length; routeIndex += 1) {
				const route = routes[routeIndex]!;
				if (!this.cooldowns.available(route.provider)) continue;
				const fast = isSubagentFastActive(input.capabilityTier, route);
				const { attempt } = await this.registry.startAttempt(reserved.id, route, input.activity, fast);
				input.onStarted?.(await this.registry.get(reserved.id));
				const attemptRoot = join(agentRoot, "attempts", attempt.id);
				let running: Promise<unknown> | undefined;
				let progress = initialAgentProgress(attempt.startedAt);
				let timing: ProcessAttemptTiming = structuredClone(attempt.timing ?? { attemptStartedAt: attempt.startedAt });
				const publishProgress = () => {
					const snapshot = structuredClone(progress);
					publishAgentLiveProgress(this.registry.root, reserved.id, attempt.id, snapshot);
					input.onProgress?.(snapshot);
				};
				publishProgress();
				const successfulText: string[] = [];
				const result = await runDirectAgent({
					agent: input.role,
					task: input.task,
					cwd: input.cwd,
					provider: route.provider,
					model: route.model,
					effort: route.effort,
					tools: input.tools,
					outputDirectory: attemptRoot,
					sessionFile: join(agentRoot, "pi-session.jsonl"),
					env: {
						...input.env,
						...fastModeChildEnvironment(input.capabilityTier, route),
						PIBOX_WORKFLOW_SESSION_ID: this.registry.sessionId,
						PIBOX_SUBAGENT_ID: reserved.id,
						PIBOX_SUBAGENT_PARENT_ID: this.mainAgentId,
						PIBOX_SUBAGENT_DEPTH: String(reserved.depth),
						PIBOX_SUBAGENT_ATTEMPT_ID: attempt.id,
						PIBOX_SUBAGENT_ROOT: agentRoot,
						PIBOX_SUBAGENT_STORE_ROOT: dirname(dirname(this.registry.root)),
						PIBOX_SUBAGENT_ASSIGNMENT_PATH: join(this.registry.root, reserved.assignmentPath),
						PIBOX_SUBAGENT_AGENT: reserved.role,
						PIBOX_SUBAGENT_ROLE: reserved.role,
					},
					extensionPaths: input.extensionPaths ?? this.extensionPaths,
					...(input.promptPath ? { promptPath: input.promptPath } : {}),
					...(input.agentPrompt ? { agentPrompt: input.agentPrompt } : {}),
					...(input.additionalPrompt ? { additionalPrompt: input.additionalPrompt } : {}),
					...(input.persistentContext ? { persistentContext: input.persistentContext } : {}),
					...(input.skillPaths ? { skillPaths: input.skillPaths } : {}),
					...(input.signal ? { signal: input.signal } : {}),
					onText: (text) => {
						timing.reportReadyAt ??= new Date().toISOString();
						successfulText.push(text);
					},
					onEvent: (event) => {
						const observedAt = new Date().toISOString();
						timing.childReadyAt ??= observedAt;
						timing.firstActivityAt ??= observedAt;
						timing.lastActivityAt = observedAt;
						const eventType = typeof event === "object" && event !== null && "type" in event ? String(event.type) : "";
						if (eventType === "tool_execution_start" || eventType === "tool_execution_end") timing.firstToolAt ??= observedAt;
						const next = projectAgentProgress(progress, event, observedAt);
						if (next === progress) return;
						progress = next;
						publishProgress();
					},
					onExit: (_exitCode, observedAt) => {
						timing.processExitedAt ??= observedAt;
					},
					...(invocationResolver ? { invocationResolver } : {}),
					onSpawn: (pid) => {
						if (pid) {
							const observedAt = new Date().toISOString();
							timing.processSpawnedAt = observedAt;
							running = this.registry.markRunning(reserved.id, attempt.id, pid, observedAt);
							progress = markAgentProcessStarted(progress, observedAt);
							publishProgress();
						}
						input.onSpawn?.(pid);
					},
				});
				await running;
				const outputDrainedAt = new Date().toISOString();
				timing.outputDrainedAt = outputDrainedAt;
				timing.processExitedAt ??= outputDrainedAt;
				progress = markAgentProcessExited(progress, timing.processExitedAt);
				if (!progress.settledAt) progress = projectAgentProgress(progress, { type: "agent_settled" }, outputDrainedAt);
				timing.settledAt = progress.settledAt ?? outputDrainedAt;
				timing.childReadyAt ??= timing.firstActivityAt ?? timing.processExitedAt;
				publishProgress();
				const failure = classifyProviderFailure(result, input.signal);
				const providerFailure = isFallbackEligible(failure);
				await this.registry.recordExit(
					reserved.id,
					attempt.id,
					providerFailure && result.exitCode === 0 ? 1 : result.exitCode,
					{ progress, timing },
				);
				clearAgentLiveProgress(this.registry.root, reserved.id, attempt.id);
				lastResult = result;
				const afterExit = await this.registry.get(reserved.id);
				if (["waiting_decision", "blocked", "paused", "interrupted", "recovery_required", "cancelled"].includes(afterExit.state)) {
					return { agent: afterExit, result };
				}
				const hasLaterRoute = routes.slice(routeIndex + 1).some((candidate) => this.cooldowns.available(candidate.provider));
				if (providerFailure) {
					this.cooldowns.mark(route.provider, failure.cooldownMs);
					const waiting = await this.registry.transition(reserved.id, "waiting_capacity", { error: `${failure.kind} on ${route.provider}/${route.model}` });
					if (hasLaterRoute) continue;
					return { agent: waiting, result };
				}
				if (result.exitCode === 0 && !providerFailure) {
					for (const text of successfulText) input.onText?.(text);
					const reported = await this.registry.transition(reserved.id, "reported", { summary: result.text || `${input.role} completed` });
					return { agent: input.deferCompletion ? reported : await this.registry.transition(reserved.id, "completed"), result };
				}
				return {
					agent: await this.registry.transition(reserved.id, "failed", { error: result.stderr || result.text || `Child exited ${result.exitCode}` }),
					result,
				};
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
			};
			const current = await this.registry.get(reserved.id);
			const waiting = current.state === "waiting_capacity"
				? current
				: await this.registry.transition(reserved.id, "waiting_capacity", { error: result.stderr });
			return { agent: waiting, result };
		} catch (error) {
			let current = await this.registry.get(reserved.id);
			const attempt = current.attempts.find((candidate) => candidate.id === current.currentAttemptId);
			if (attempt && (attempt.state === "launching" || attempt.state === "running")) {
				const now = new Date().toISOString();
				let progress = attempt.progress ?? initialAgentProgress(attempt.startedAt);
				if (attempt.pid && !progress.processStartedAt) progress = markAgentProcessStarted(progress, attempt.timing?.processSpawnedAt ?? now);
				progress = markAgentProcessExited(progress, now);
				if (!progress.settledAt) progress = projectAgentProgress(progress, { type: "agent_settled" }, now);
				const timing: ProcessAttemptTiming = {
					...(attempt.timing ?? { attemptStartedAt: attempt.startedAt }),
					processExitedAt: now,
					outputDrainedAt: now,
					settledAt: progress.settledAt ?? now,
				};
				await this.registry.recordExit(reserved.id, attempt.id, 1, { progress, timing }).catch(() => undefined);
				clearAgentLiveProgress(this.registry.root, reserved.id, attempt.id);
				current = await this.registry.get(reserved.id);
			}
			if (current.state !== "failed" && current.state !== "cancelled") {
				await this.registry.transition(reserved.id, "failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
			}
			throw error;
		}
	}
}
