import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { DynamicSubagentRequest, DynamicSubagentStarted, SpawnableAgentDefinition, WorkflowAdapter, WorkflowRunResult, WorkflowSnapshot, WorkflowStep, WorkflowStepStatus, WorkflowStartProgress } from "../workflow-runtime/api.js";
import type { AgentProgress } from "../workflow-runtime/agent-progress.js";
import { AgentLiveProjectionManager } from "../workflow-runtime/agent-live-projection.js";
import { WorkflowControlStore } from "../workflow-runtime/control-store.js";
import { isAgentProcessActive, type SessionAgentRecord, type SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import type { RepositoryIdentity } from "./repository.js";
import { readTextIfExists } from "./repository.js";
import type { WorkItemStore } from "./work-items.js";
import { orderedExecutionStages, preflightTaskChecks, resolveStageMode, taskExecutionTopology } from "./execution-topology.js";
import { WorktreeManager } from "./worktrees.js";
import { HarnessError } from "./errors.js";
import type { RepositoryMutex } from "./idempotency.js";
import { readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import { confirmCriticalRisk } from "../permissions/runtime.js";
import { DEFAULT_REVIEW_FIX_ITERATIONS } from "./review-loop.js";
import { WorkflowEventJournal, type WorkflowDomainEventType } from "./workflow-events.js";
import type { RepositoryEventStore } from "./event-store.js";
import { readStageVerificationActivity, readVerificationAttempts } from "./verification-runner.js";
import { RepairRecoveryStore, type RepairRecoveryRecord } from "./repair-recovery.js";
import { projectWorkflowMetrics } from "./workflow-metrics.js";


export interface HarnessWorkflowRuntime {
	identity: RepositoryIdentity;
	workItems: WorkItemStore;
	mutex: RepositoryMutex;
	agents: SessionAgentRegistry;
	sessionId?: string;
	events?: RepositoryEventStore;
	config?: { limits: { repairRounds: number } };
}

export interface HarnessWorkflowAdapterOptions {
	runtimeFor(ctx: ExtensionContext): Promise<HarnessWorkflowRuntime>;
	launchTask(ctx: ExtensionContext, workItemId: string, taskId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	launchEvaluation(ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	launchRepair?(ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	/** Harness-owned repair assignment for a preserved stage merge conflict. */
	launchIntegrationRepair?(ctx: ExtensionContext, workItemId: string, stageId: string, taskIds: string[], evidencePath: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	spawnSubagent?(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void, onStarted?: (status: DynamicSubagentStarted) => void, onProgress?: (progress: AgentProgress) => void): Promise<WorkflowRunResult>;
	listSpawnableAgents?(ctx: ExtensionContext): Promise<SpawnableAgentDefinition[]>;
	validateWorkingBranch?(runtime: HarnessWorkflowRuntime, workItemId: string, options?: { allowDirty?: boolean }): Promise<void>;
	reconcileReported?(runtime: HarnessWorkflowRuntime): Promise<void>;
}

const WORK_ITEM = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const STEP = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)\/(task|evaluation):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const settledAgent = new Set(["completed", "cancelled"]);
const taskDone = new Set(["merged", "integrated"]);
function agentAttention(agent: SessionAgentRecord): string | undefined {
	if (isAgentProcessActive(agent) || settledAgent.has(agent.state)) return undefined;
	if (agent.state === "reported") return "result pending reconciliation";
	if ((agent.state === "launching" || agent.state === "running") && agent.currentAttemptId) return "stale process state";
	return agent.state.replaceAll("_", " ");
}

function currentAttempt(agent: SessionAgentRecord | undefined) {
	return agent?.attempts.find((attempt) => attempt.id === agent.currentAttemptId);
}

type ActiveProcessProjection = { running: boolean; attention?: string; progress?: AgentProgress; fast?: boolean };

function scopeActivity(agents: SessionAgentRecord[], scope: "taskId" | "evaluationId", id: string, relevant?: (agent: SessionAgentRecord) => boolean): ActiveProcessProjection {
	const matching = agents.filter((agent) => agent[scope] === id && (!relevant || relevant(agent)));
	const active = matching.find(isAgentProcessActive);
	const attempt = currentAttempt(active);
	if (active) return { running: true, ...(attempt?.progress ? { progress: attempt.progress } : {}), ...(attempt?.fast === true ? { fast: true } : {}) };
	const attention = matching.map(agentAttention).find((detail): detail is string => Boolean(detail));
	return { running: false, ...(attention ? { attention } : {}) };
}

function evaluationActivity(agents: SessionAgentRecord[], evaluation: { id: string; loop?: { state?: string; iteration?: number; reviewerAgentId?: string; fixerAgentId?: string } }): ActiveProcessProjection {
	const loop = evaluation.loop;
	const fixing = loop?.state === "fixing";
	const rereviewing = loop?.state === "rereviewing";
	const expected = fixing
		? { kind: "repair" as const, generation: (loop?.iteration ?? 0) + 1 }
		: { kind: "review" as const, generation: rereviewing ? (loop?.iteration ?? 0) : 0 };
	const candidates = agents.filter((agent) => agent.evaluationId === evaluation.id &&
		(fixing ? (loop?.fixerAgentId ? agent.id === loop.fixerAgentId : agent.role === "repair-implementer") :
			(loop?.reviewerAgentId ? agent.id === loop.reviewerAgentId : agent.role !== "repair-implementer")));
	const current = candidates
		.map((agent) => ({ agent, attempt: agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId) }))
		.filter(({ attempt }) => attempt?.activity?.kind === expected.kind && attempt.activity.generation === expected.generation);
	// The activity descriptor, rather than attempt sequence, is the durable
	// generation boundary. This also makes provider fallback attempts in one
	// generation equivalent while excluding historical reports and exits.
	const active = current.find(({ agent, attempt }) => isAgentProcessActive(agent) && (attempt?.state === "launching" || attempt?.state === "running"));
	const attempt = active?.attempt;
	if (active) return { running: true, ...(attempt?.progress ? { progress: attempt.progress } : {}), ...(attempt?.fast === true ? { fast: true } : {}) };
	if (current.some(({ agent }) => agent.state === "reported")) return { running: false, attention: "result pending reconciliation" };
	const failed = current.find(({ agent }) => ["failed", "protocol_failed", "recovery_required"].includes(agent.state));
	if (failed) return { running: false, attention: agentAttention(failed.agent) ?? "failed" };
	if (current.some(({ agent }) => agent.state === "launching" || agent.state === "running")) return { running: false, attention: "stale process state" };
	if (current.some(({ agent, attempt }) => agent.state !== "reserved" && attempt?.state === "failed")) return { running: false, attention: "failed" };
	if (current.some(({ attempt }) => attempt?.state === "exited")) return { running: false, attention: "stale process state" };
	return { running: false };
}

function finalValidationDisplay(evaluation: { checkpoint?: string; status: string; loop?: { state?: string; iteration?: number } }, activity: { running: boolean; attention?: string }): { name: string; phase: string } | undefined {
	const journey = evaluation.checkpoint === "final-e2e";
	const branch = evaluation.checkpoint === "final-review";
	if (!journey && !branch) return undefined;
	const name = journey ? "E2E journey/fix loop" : "Whole-branch review/fix loop";
	const state = evaluation.loop?.state;
	const iteration = evaluation.loop?.iteration ?? 0;
	if (["passed", "not_applicable"].includes(evaluation.status) || state === "passed") return { name, phase: journey ? "Journeys passed" : "Branch approved" };
	if (state === "awaiting_manager") return { name, phase: "Decision needed · Approve or Request changes" };
	if (activity.running) {
		if (state === "fixing") return { name, phase: journey ? `Fixing E2E failures #${Math.max(2, iteration + 1)}` : `Fixing branch findings #${Math.max(2, iteration + 1)}` };
		if (state === "rereviewing") return { name, phase: journey ? `Re-running journeys #${iteration}` : `Re-reviewing whole branch #${iteration}` };
		return { name, phase: journey ? "Running journeys" : "Reviewing whole branch" };
	}
	if (activity.attention) {
		if (state === "fixing") return { name, phase: journey ? "E2E fix failed · Resume" : "Branch fix failed · Resume" };
		if (activity.attention === "result pending reconciliation") return { name, phase: journey ? "Journey report ready" : "Branch-review report ready" };
		return { name, phase: journey ? "E2E worker needs attention" : "Branch reviewer needs attention" };
	}
	if (state === "fixing") return { name, phase: journey ? "E2E fix queued" : "Branch fix queued" };
	if (state === "rereviewing") return { name, phase: journey ? "Journey re-run queued" : "Branch re-review queued" };
	return { name, phase: journey ? "Journey run queued" : "Whole-branch review queued" };
}

function taskStatus(status: string, dependenciesDone: boolean): { status: WorkflowStepStatus; detail?: string } {
	if (taskDone.has(status)) return { status: "done" };
	if (["running", "reviewing"].includes(status)) return { status: "running" };
	if (["accepted", "merge_queued", "merging", "contribution_complete", "staged", "integrating"].includes(status)) {
		if (!dependenciesDone) return { status: "pending" };
		return { status: "ready", detail: status.replaceAll("_", " ") };
	}
	if (status === "ready") return dependenciesDone ? { status: "ready" } : { status: "pending" };
	if (status === "cancelled") return { status: "cancelled" };
	if (status === "failed" || status === "protocol_failed") return { status: "attention", detail: "failed" };
	if ((status === "blocked" || status === "paused" || status === "changes_requested") && dependenciesDone) return { status: "attention", detail: status.replaceAll("_", " ") };
	return { status: "pending" };
}

export function createHarnessWorkflowAdapter(options: HarnessWorkflowAdapterOptions): WorkflowAdapter {
	return {
		id: "workflow",
		canHandle(ref) { return WORK_ITEM.test(ref) || STEP.test(ref); },
		async listAgentLive(ctx) {
			const runtime = await options.runtimeFor(ctx);
			return new AgentLiveProjectionManager(runtime.agents).list();
		},
		async subscribeAgentLive(ctx, listener, signal) {
			const runtime = await options.runtimeFor(ctx);
			return new AgentLiveProjectionManager(runtime.agents).watch(listener, signal);
		},
		async controlExecution(ref, command, operationId, ctx) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const sessionId = runtime.sessionId ?? ctx.sessionManager.getSessionId();
			const prior = await new WorkflowControlStore(runtime.identity.privateRoot).get(ref);
			const record = await new WorkflowControlStore(runtime.identity.privateRoot).apply({ workflowRef: ref, command, sessionId, operationId });
			if (runtime.events && prior?.lastOperationId !== operationId) {
				const eventType: WorkflowDomainEventType = command === "start" ? "workflow.started"
					: command === "pause" ? "workflow.paused"
						: command === "resume" ? "workflow.resumed"
							: command === "stop" ? "workflow.stopped"
								: command === "complete" ? "workflow.completed"
									: command === "detach" ? "workflow.detached" : "workflow.attached";
				await new WorkflowEventJournal(runtime.events).append({ type: eventType, workItemId: match[1]!, ownerGeneration: record.generation, correlationId: operationId, transition: { ...(prior ? { from: prior.mode } : {}), to: record.mode, cause: command } });
			}
			return record;
		},
		async listExecutionControls(ctx) {
			const runtime = await options.runtimeFor(ctx);
			return new WorkflowControlStore(runtime.identity.privateRoot).list();
		},
		async assertExecutionCurrent(ref, generation, ctx) {
			const runtime = await options.runtimeFor(ctx);
			const sessionId = runtime.sessionId ?? ctx.sessionManager.getSessionId();
			await new WorkflowControlStore(runtime.identity.privateRoot).assertCurrent(ref, sessionId, generation);
		},
		async reconcileWorkflow(ref, ctx) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			if (!options.reconcileReported) return;
			await options.reconcileReported(await options.runtimeFor(ctx));
		},
		async preflightWorkflow(ref, ctx) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
			const missing = await preflightTaskChecks(item, tasks, runtime.identity.root);
			if (!missing.missingCommands.length && !missing.missingEnvironment.length) return { ok: true };
			const details = [
				missing.missingCommands.length ? `missing commands: ${missing.missingCommands.join(", ")}` : undefined,
				missing.missingEnvironment.length ? `missing environment: ${missing.missingEnvironment.join(", ")}` : undefined,
			].filter(Boolean).join("; ");
			return { ok: false, ...missing, detail: `Workflow preflight failed: ${details}. Configure the declared prerequisites and retry; PiBox will not guess project-specific values.` };
		},
		async prepareWorkflow(ref, ctx, onUpdate) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const started = Date.now();
			const progress = (phase: WorkflowStartProgress["phase"]) => onUpdate?.({ phase, elapsedMs: Date.now() - started });
			await runtime.mutex.run(`workflow-begin:${match[1]}`, async () => {
				progress("Finalizing reviewed plan"); await runtime.workItems.submitPlanning(match[1]!);
				progress("Validating working branch");
				if (options.validateWorkingBranch) await options.validateWorkingBranch(runtime, match[1]!);
				else await new WorktreeManager(runtime.identity).validateWorkingBranch(match[1]!);
				await runtime.workItems.beginExecution(match[1]!);
				progress("Creating runtime verification gates"); await runtime.workItems.ensureFinalEvaluations(match[1]!, runtime.config?.limits.repairRounds ?? DEFAULT_REVIEW_FIX_ITERATIONS);
				progress("Activating tasks"); await runtime.workItems.activateDraftTasks(match[1]!);
			});
		},
		async completionPrompt(ref, ctx) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			const worktrees = await new WorktreeManager(runtime.identity).listManaged();
			const modifiedWorktrees = worktrees.filter((worktree) => worktree.status === "modified").length;
			return renderBuiltInPrompt("workflow-completion", {
				workflowId: item.id,
				outcomePath: `${runtime.workItems.workItemRoot(item.id)}/outcome.md`,
				worktreeGuidance: worktrees.length
					? renderBuiltInPrompt("workflow-completion-worktrees-retained", { count: worktrees.length, modified: modifiedWorktrees ? ` (${modifiedWorktrees} modified)` : "" })
					: readBuiltInPrompt("workflow-completion-worktrees-none"),
				branchGuidance: item.delivery?.workingBranch
					? renderBuiltInPrompt("workflow-completion-created-branch", { branch: item.delivery.workingBranch })
					: readBuiltInPrompt("workflow-completion-unknown-branch"),
			});
		},
		subscribeLifecycle(ref, ctx, listener, signal) {
			const match = WORK_ITEM.exec(ref);
			if (!match || signal?.aborted) return () => undefined;
			return options.runtimeFor(ctx).then(async (runtime) => {
				if (signal?.aborted) return () => undefined;
				const unsubscribers: Array<() => void> = [];
				const agentWatcher = await runtime.agents.watch((event) => {
					if (signal?.aborted || !event.data.agentId) return;
					void runtime.agents.get(event.data.agentId).then((agent) => {
						if (!signal?.aborted && agent.workItemId === match[1]) listener();
					}).catch(() => undefined);
				}, signal);
				unsubscribers.push(agentWatcher);
				// Cross-process filesystem notifications are wake-up hints. Replay the
				// durable suffix from a cursor, then project semantic verification events
				// into notices while every event still triggers a fresh snapshot.
				if (runtime.events) {
					let cursor = Math.max(0, ...(await runtime.events.readAll()).map((event) => event.sequence));
					let drain = Promise.resolve();
					const replay = () => {
						drain = drain.then(async () => {
							for (const event of await runtime.events!.readSince(cursor)) {
								cursor = Math.max(cursor, event.sequence);
								const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : undefined;
								if (event.type.startsWith("verification.attempt.") && data && data.workItemId === match[1]) {
									const stageId = String(data.stageId ?? "stage");
									const checkId = String(data.checkId ?? "check");
									const attemptId = String(data.attemptId ?? "?");
									const candidate = String(data.candidateCommit ?? "").slice(0, 12);
									const state = event.type.split(".").at(-1)!;
									listener({ workflowRef: ref, title: `${state === "started" ? "Verifying" : state === "passed" ? "Verification passed" : "Verification failed"} · ${stageId} · ${checkId}`, detail: [`attempt ${attemptId}`, candidate ? `candidate ${candidate}` : undefined].filter(Boolean).join(" · "), attention: false, kind: "verification", cause: event.type });
								} else listener();
							}
						}).catch(() => listener());
					};
					unsubscribers.push(runtime.events.watch(replay, signal));
					replay();
				}
				const unsubscribe = () => { for (const dispose of unsubscribers.splice(0)) dispose(); };
				if (signal?.aborted) { unsubscribe(); return () => undefined; }
				if (signal) signal.addEventListener("abort", unsubscribe, { once: true });
				return unsubscribe;
			}).catch(() => () => undefined);
		},
		async snapshot(ref, ctx): Promise<WorkflowSnapshot> {
			const match = WORK_ITEM.exec(ref);
			if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			const agents = await runtime.agents.list();
			const metrics = runtime.events ? projectWorkflowMetrics({
				workItemId: item.id,
				workflowEvents: await new WorkflowEventJournal(runtime.events).readSince(0, item.id),
				agents,
				verificationAttempts: await readVerificationAttempts(runtime.identity, item.id),
			}) : undefined;
			const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
			const evaluations = await Promise.all(item.evaluations.map((entry) => runtime.workItems.readEvaluation(item.id, entry.id)));
			const taskById = new Map(tasks.map((task) => [task.id, task]));
			const evaluationById = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
			const stages = orderedExecutionStages(item);
			const stageVerification = runtime.identity?.privateRoot
				? new Map((await Promise.all(stages.map(async (stage) => [stage.id, await readStageVerificationActivity(runtime.identity, item.id, stage.id)] as const))).filter((entry) => entry[1]))
				: new Map();
			const stageReviews = new Map(evaluations.filter((evaluation) => evaluation.checkpoint === "stage-review" && evaluation.stageId).map((evaluation) => [evaluation.stageId!, evaluation]));
			const contributionStates = new Set(["contribution_complete", "accepted", "merge_queued", "merging", "staged", "integrating", "merged", "integrated"]);
			const steps: WorkflowStep[] = tasks.map((task) => {
				const topology = taskExecutionTopology(item, task);
				const priorStagesDone = stages.slice(0, topology.stageIndex).every((stage) => stage.tasks.every((id) => ["merged", "integrated"].includes(taskById.get(id)?.status ?? "")) && ["passed", "not_applicable"].includes(stageReviews.get(stage.id)?.status ?? ""));
				const dependenciesDone = task.dependsOn.every((id) => ["merged", "integrated"].includes(taskById.get(id)?.status ?? ""));
				const isSequentialStage = resolveStageMode(stages[topology.stageIndex]!) === "sequential";
				const taskIndex = topology.stageTasks.indexOf(task.id);
				const priorSequentialTaskDone = !isSequentialStage || taskIndex <= 0 || taskDone.has(taskById.get(topology.stageTasks[taskIndex - 1]!)?.status ?? "");
				const isMergeState = contributionStates.has(task.status) && !["merged", "integrated"].includes(task.status);
				const parallelStageReadyToMerge = topology.mode === "sequential" || topology.stageSize === 1 || topology.stageTasks.every((id) => contributionStates.has(taskById.get(id)?.status ?? ""));
				const mergeBarrierOwner = topology.mode === "sequential" || topology.stageSize === 1 || topology.stageTasks[0] === task.id;
				let mapped = taskStatus(task.status, priorStagesDone && dependenciesDone && priorSequentialTaskDone);
				const activity = scopeActivity(agents, "taskId", task.id);
				if (isMergeState && (!priorSequentialTaskDone || !parallelStageReadyToMerge || !mergeBarrierOwner)) mapped = { status: "pending", detail: !priorSequentialTaskDone ? "waiting for prior sequential task" : parallelStageReadyToMerge ? "waiting for stage merge barrier" : "waiting for parallel contributions" };
				if (mapped.status === "running" && !activity.running) mapped = { status: "attention", detail: activity.attention ?? "stale process state" };
				const verification = stageVerification.get(topology.stageId);
				const phase = ["merged", "integrated"].includes(task.status) ? "integrated"
					: isMergeState && !mergeBarrierOwner ? "contribution-ready"
					: isMergeState && (verification?.state === "failed" || verification?.state === "interrupted") ? "verification-failed"
					: isMergeState && (verification?.state === "running" || verification?.state === "starting") ? "verifying-candidate"
					: isMergeState ? "ready-to-integrate"
					: mapped.status === "running" || mapped.status === "ready" ? "implementing" : undefined;
				return {
					ref: `work-item:${item.id}/task:${task.id}`,
					title: task.title,
					kind: isMergeState ? "merge" : "task",
					...mapped,
					...(phase ? { phase } : {}),
					dependsOn: [...task.dependsOn.map((id) => `work-item:${item.id}/task:${id}`), ...(topology.stageIndex > 0 && stageReviews.get(stages[topology.stageIndex - 1]!.id) ? [`work-item:${item.id}/evaluation:${stageReviews.get(stages[topology.stageIndex - 1]!.id)!.id}`] : [])],
					parallelism: isMergeState ? "serial" : topology.parallelism,
					resourceClaims: isMergeState || topology.isolation === "repository" ? ["working-branch"] : task.execution.resourceClaims,
					...(activity.progress ? { progress: activity.progress } : {}),
					...(activity.fast ? { fast: true } : {}),
				};
			});
			const finalJourneyRefs = evaluations
				.filter((evaluation) => evaluation.checkpoint === "final-e2e" || (evaluation.type === "e2e" && evaluation.scope.workItem === item.id))
				.map((evaluation) => `work-item:${item.id}/evaluation:${evaluation.id}`);
			const stageReviewRefs = evaluations.filter((evaluation) => evaluation.checkpoint === "stage-review").map((evaluation) => `work-item:${item.id}/evaluation:${evaluation.id}`);
			const evaluationOrder = (evaluation: typeof evaluations[number]): number => evaluation.checkpoint === "stage-review" ? 0 : evaluation.checkpoint === "final-e2e" ? 1 : evaluation.checkpoint === "final-review" ? 2 : 0;
			for (const evaluation of [...evaluations].sort((left, right) => evaluationOrder(left) - evaluationOrder(right))) {
				const explicitStage = evaluation.stageId ? stages.find((stage) => stage.id === evaluation.stageId) : undefined;
				const dependencies = evaluation.checkpoint === "stage-review" && explicitStage
					? explicitStage.tasks.map((taskId) => `work-item:${item.id}/task:${taskId}`)
					: evaluation.checkpoint === "final-e2e"
						? stageReviewRefs
						: evaluation.checkpoint === "final-review"
							? finalJourneyRefs.filter((candidate) => candidate !== `work-item:${item.id}/evaluation:${evaluation.id}`)
							: [];
				const dependencySteps = dependencies.map((dependency) => steps.find((step) => step.ref === dependency));
				const dependenciesDone = dependencySteps.every((step) => step?.status === "done");
				const dependencyAttention = dependencySteps.find((step) => step?.status === "attention" || step?.status === "cancelled");
				let status: WorkflowStepStatus = "pending"; let detail: string | undefined;
				const activity = evaluationActivity(agents, evaluation);
				// Process activity is authoritative over the durable loop label, but only
				// for the worker that owns the current phase. A prior reviewer report must
				// not shadow a queued fixer.
				// A fixer or
				// reviewer can be active while the canonical loop is still being settled.
				// A durable manager checkpoint is authoritative, even when a persistent
				// reviewer still has a reported process record.
				if (["passed", "not_applicable"].includes(evaluation.status) || evaluation.loop?.state === "passed" || evaluation.loop?.state === "skipped") status = "done";
				else if (activity.running) { status = "running"; detail = evaluation.loop?.state === "fixing" ? `Fixing #${Math.max(2, (evaluation.loop?.iteration ?? 0) + 1)}` : evaluation.loop?.state === "rereviewing" ? `Re-reviewing #${evaluation.loop.iteration}` : "Reviewing"; }
				else if (activity.attention) { status = "attention"; detail = activity.attention; }
				// Only the upstream checkpoint is actionable. Downstream final gates stay
				// visibly queued instead of inheriting its Approve/Request-changes warning.
				else if (dependencyAttention) {
					status = "pending";
					const dependencyName = dependencyAttention.title.split(" · ")[0] ?? dependencyAttention.title;
					detail = evaluation.checkpoint === "final-e2e" || evaluation.checkpoint === "final-review" ? `waiting for ${dependencyName}` : `blocked by ${dependencyName}`;
				}
				else if (evaluation.loop?.state === "awaiting_manager") { status = "attention"; detail = "Needs attention · Approve or Request changes"; }
				else if (evaluation.loop?.state === "fixing" || evaluation.loop?.state === "rereviewing") { status = dependenciesDone ? "ready" : "pending"; detail = evaluation.loop.state === "fixing" ? "Fix requested" : "Re-review requested"; }
				else if (["failed", "blocked"].includes(evaluation.status)) { status = "attention"; detail = evaluation.status; }
				else if (evaluation.status === "running") { status = "attention"; detail = "stale process state"; }
				else if (dependenciesDone) status = "ready";
				// Durable loop states describe intent, not process activity. Keep this as the
				// canonical user-facing phase so queued work and settled reports cannot look
				// like an active worker in the dashboard or workflow events.
				const finalValidation = finalValidationDisplay(evaluation, activity);
				const dependencyPhase = dependencyAttention
					? evaluation.checkpoint === "final-e2e" ? "Journey run queued" : evaluation.checkpoint === "final-review" ? "Whole-branch review queued" : undefined
					: undefined;
				const phase = dependencyPhase ?? finalValidation?.phase ?? (["passed", "not_applicable"].includes(evaluation.status) || evaluation.loop?.state === "passed" ? "Approved"
					: evaluation.loop?.state === "awaiting_manager" ? "Needs attention · Approve or Request changes"
					: activity.running ? evaluation.loop?.state === "fixing" ? `Fixing #${Math.max(2, evaluation.loop.iteration + 1)}` : evaluation.loop?.state === "rereviewing" ? `Re-reviewing #${evaluation.loop.iteration}` : "Reviewing"
					: activity.attention && evaluation.loop?.state === "fixing" ? "Fix failed · Resume"
					: activity.attention === "result pending reconciliation" ? "Review report ready"
					: evaluation.loop?.state === "fixing" ? "Fix requested"
					: evaluation.loop?.state === "rereviewing" ? "Re-review requested"
					: "Review requested");
				if (finalValidation && !dependencyAttention) detail = finalValidation.phase;
				const findings = evaluation.findings ?? [];
				const open = findings.filter((finding) => ["open", "needs_user", "accepted"].includes(finding.status));
				const blocking = open.filter((finding) => finding.blocking);
				const guidance = `findings ${open.length} (blocking ${blocking.length}); iteration ${evaluation.loop?.iteration ?? 0}/${evaluation.loop?.maxIterations ?? runtime.config?.limits.repairRounds ?? DEFAULT_REVIEW_FIX_ITERATIONS}; allowed actions: Approve or Request changes${evaluation.loop?.managerPrompt ? `; manager guidance: ${evaluation.loop.managerPrompt}` : ""}`;
				const stepDetail = activity.attention || dependencyAttention || (status === "pending" && !dependenciesDone) ? detail : [detail, guidance].filter(Boolean).join(" · ");
				steps.push({ ref: `work-item:${item.id}/evaluation:${evaluation.id}`, title: `${finalValidation?.name ?? `Review loop ${evaluation.id}`} · ${phase}`, kind: "evaluation", status, ...(evaluation.checkpoint ? { checkpoint: evaluation.checkpoint } : {}), ...(stepDetail ? { detail: stepDetail } : {}), ...(activity.progress ? { progress: activity.progress } : {}), ...(activity.fast ? { fast: true } : {}), dependsOn: dependencies, parallelism: "serial", resourceClaims: [] });
			}
			const status = steps.some((step) => step.status === "attention" || step.status === "cancelled") ? "attention" : steps.length > 0 && steps.every((step) => step.status === "done") ? "done" : steps.some((step) => step.status === "running") ? "running" : "ready";
			const plannerStages = stages.map((stage, index) => ({ id: stage.id, index, nodes: [...stage.tasks.map((id) => `task:${id}`), ...(stageReviews.get(stage.id) ? [`evaluation:${stageReviews.get(stage.id)!.id}`] : [])], parallel: resolveStageMode(stage) === "concurrent", group: "planner" as const }));
			const runtimeNodes = evaluations.filter((evaluation) => ["final-e2e", "final-review"].includes(evaluation.checkpoint ?? "") || (evaluation.type === "e2e" && evaluation.scope.workItem === item.id)).map((evaluation) => `evaluation:${evaluation.id}`);
			const repairBoundaries = [
				...stages.flatMap((stage, index) => {
					const evaluation = stageReviews.get(stage.id);
					return evaluation ? [{ evaluation, label: `Stage ${index + 1} fix loop` }] : [];
				}),
				...evaluations.filter((evaluation) => evaluation.checkpoint === "final-e2e" || (evaluation.type === "e2e" && evaluation.scope.workItem === item.id)).map((evaluation) => ({ evaluation, label: "E2E fix loop" })),
				...evaluations.filter((evaluation) => evaluation.checkpoint === "final-review").map((evaluation) => ({ evaluation, label: "Final fix loop" })),
			];
			const currentRepairBoundary = repairBoundaries.find(({ evaluation }) => !["passed", "not_applicable"].includes(evaluation.status) && !["passed", "skipped"].includes(evaluation.loop?.state ?? ""));
			const currentRepairLimit = currentRepairBoundary?.evaluation.loop?.maxIterations ?? runtime.config?.limits.repairRounds ?? DEFAULT_REVIEW_FIX_ITERATIONS;
			const settledRepairRounds = currentRepairBoundary?.evaluation.loop?.iteration ?? 0;
			const currentRepairRound = Math.min(currentRepairLimit, settledRepairRounds + (currentRepairBoundary?.evaluation.loop?.state === "fixing" ? 1 : 0));
			const repairLoop = currentRepairBoundary ? {
				label: currentRepairBoundary.label,
				iteration: currentRepairRound,
				maxIterations: currentRepairLimit,
				evaluationRef: `work-item:${item.id}/evaluation:${currentRepairBoundary.evaluation.id}`,
			} : undefined;
			return { ref, title: item.title || item.id, status, steps, stages: [...plannerStages, ...(runtimeNodes.length ? [{ id: "runtime-verification", index: plannerStages.length, nodes: runtimeNodes, parallel: false, group: "runtime" as const }] : [])], ...(metrics ? { metrics } : {}), ...(repairLoop ? { repairLoop } : {}) };
		},
		async runStep(ref, ctx, _signal): Promise<WorkflowRunResult> {
			const match = STEP.exec(ref); if (!match) throw new Error(`Invalid workflow step: ${ref}`);
			const [, workItemId, kind, id] = match;
			if (kind === "task") {
				const runtime = await options.runtimeFor(ctx);
				// Conflict evidence is private runtime state because the canonical branch is
				// intentionally left dirty and cannot safely accept a task-manifest write.
				const conflict = await new WorktreeManager(runtime.identity).activeConflict(workItemId!);
				if (conflict) {
					if (!options.launchIntegrationRepair) throw new Error(`Stage ${conflict.stageId} has a preserved integration conflict at ${conflict.evidencePath}; harness repair assignment is required (no generic agent may be spawned).`);
					const repaired = await options.launchIntegrationRepair(ctx, workItemId!, conflict.stageId, conflict.taskIds, conflict.evidencePath, _signal);
					return { ref, state: "completed", summary: repaired.content[0]?.text ?? `Managed integration repair for ${conflict.stageId} settled.`, ...(repaired.details?.agentId ? { agentId: repaired.details.agentId } : {}) };
				}

				const task = await runtime.workItems.readTask(workItemId!, id!);
				if (["contribution_complete", "accepted", "merge_queued", "merging", "staged", "integrating"].includes(task.status)) {
					const merged = await runtime.mutex.run(`merge-task:${workItemId}:${id}`, () => new WorktreeManager(runtime.identity).mergeTask(workItemId!, id!));
					return { ref, state: "completed", summary: `Merged stage ${merged.stageId} (${merged.taskIds.join(", ")}) into the working branch as ${merged.commit.slice(0, 12)}.` };
				}
				const launched = await options.launchTask(ctx, workItemId!, id!);
				const run = launched.details?.run; const state = run?.state === "completed" ? "completed" : run?.state === "cancelled" ? "cancelled" : ["interrupted", "waiting_capacity"].includes(run?.state) ? "blocked" : "failed";
				return { ref, state, summary: launched.content[0]?.text ?? `Task ${id} settled.`, ...(launched.details?.agentId ? { agentId: launched.details.agentId } : {}), attention: state === "blocked" || state === "failed" };
			}
			const evaluation = await (await options.runtimeFor(ctx)).workItems.readEvaluation(workItemId!, id!);
			if (evaluation.loop?.state === "fixing") {
				if (!options.launchRepair) throw new Error(`Workflow adapter cannot repair evaluation ${id}`);
				const repaired = await options.launchRepair(ctx, workItemId!, id!, _signal);
				return { ref, state: "completed", summary: repaired.content[0]?.text ?? `Repair for ${id} settled.`, ...(repaired.details?.agentId ? { agentId: repaired.details.agentId } : {}) };
			}
			const launched = await options.launchEvaluation(ctx, workItemId!, id!);
			const verdict = launched.details?.handoff?.verdict ?? launched.details?.evaluation?.status;
			return { ref, state: verdict === "pass" || verdict === "passed" || verdict === "not_applicable" ? "completed" : "failed", summary: launched.content[0]?.text ?? `Evaluation ${id} settled.`, ...(launched.details?.agentId ? { agentId: launched.details.agentId } : {}), attention: verdict !== "pass" && verdict !== "passed" && verdict !== "not_applicable" };
		},
		...(options.spawnSubagent ? { async spawnSubagent(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void, onStarted?: (status: DynamicSubagentStarted) => void, onProgress?: (progress: AgentProgress) => void) { return options.spawnSubagent!(request, ctx, signal, onText, onStarted, onProgress); } } : {}),
		...(options.listSpawnableAgents ? { async listSpawnableAgents(ctx: ExtensionContext) { return options.listSpawnableAgents!(ctx); } } : {}),
		async controlCheckpoint(ref, action, checkpointOptions, ctx) {
			const match = STEP.exec(ref);
			if (!match || match[2] !== "evaluation") throw new Error(`Checkpoint decision requires an evaluation step ref: ${ref}`);
			const [, workItemId, , evaluationId] = match;
			const runtime = await options.runtimeFor(ctx);
			const evaluation = await runtime.workItems.readEvaluation(workItemId!, evaluationId!);
			const prompt = checkpointOptions?.prompt;
			if (action === "request_changes") {
				// Re-read under the checkpoint mutex: a resumed/replayed decision must be
				// judged against the durable phase, not the snapshot read before locking.
				return runtime.mutex.run(`checkpoint:${workItemId}:${evaluationId}`, async () => {
					const current = await runtime.workItems.readEvaluation(workItemId!, evaluationId!);
					const currentLoop = current.loop ?? { state: "planned" as const, iteration: 0, maxIterations: runtime.config?.limits.repairRounds ?? DEFAULT_REVIEW_FIX_ITERATIONS };
					if (currentLoop.state === "fixing") {
						if (!prompt?.trim() || prompt.trim() !== currentLoop.managerPrompt?.trim()) throw new Error(`Evaluation ${evaluationId} is already fixing; only the existing repair decision may be replayed`);
						// Idempotent recovery: retain the fixer identity, prompt, and iteration.
						return current;
					}
					if (currentLoop.state !== "awaiting_manager") throw new Error(`Cannot request changes for evaluation ${evaluationId} while loop is ${currentLoop.state}`);
					if (!options.launchRepair) throw new Error(`Workflow adapter cannot repair evaluation ${evaluationId}`);
					const currentFindings = (current.findings ?? []).filter((finding) => ["open", "needs_user", "accepted"].includes(finding.status));
					if (current.checkpoint === "final-review" && currentFindings.filter((finding) => finding.blocking).length === 0) throw new Error("Final branch review has no blocking findings; non-blocking findings may only be accepted as residual risk.");
					if (!prompt?.trim()) throw new Error("request_changes requires a repair prompt");
					if (currentLoop.iteration >= currentLoop.maxIterations) throw new Error(`Review/fix iteration limit reached for ${evaluationId}`);
					// A pre-recovery-version fixer may have failed after editing the canonical
					// checkout and then been projected back to awaiting_manager. Replaying the
					// exact same manager decision explicitly adopts that preserved workspace,
					// keeps the logical fixer identity, and makes one fresh process attempt.
					const expectedGeneration = currentLoop.iteration + 1;
					const priorFixer = currentLoop.managerPrompt?.trim() === prompt.trim()
						? (await runtime.agents?.list?.() ?? [])
							.filter((agent) => agent.evaluationId === evaluationId && agent.role === "repair-implementer" && ["failed", "protocol_failed", "reported", "recovery_required"].includes(agent.state))
							.filter((agent) => agent.attempts.find((attempt) => attempt.id === agent.currentAttemptId)?.activity?.kind === "repair" && agent.attempts.find((attempt) => attempt.id === agent.currentAttemptId)?.activity?.generation === expectedGeneration)
							.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
						: undefined;
					const updated = await runtime.workItems.updateEvaluationLoop(workItemId!, evaluationId!, { state: "fixing", managerPrompt: prompt, ...(priorFixer ? { fixerAgentId: priorFixer.id } : {}) });
					if (priorFixer) {
						await new RepairRecoveryStore(runtime.identity).record({ workItemId: workItemId!, evaluationId: evaluationId!, agentId: priorFixer.id, operationId: priorFixer.operationId, iteration: expectedGeneration });
						await runtime.agents.prepareRetry(priorFixer.id);
					}
					// Record authorization only. The runner owns fixer launch, settlement,
					// and automatic re-review.
					return updated;
				});
			}
			return runtime.mutex.run(`checkpoint:${workItemId}:${evaluationId}`, async () => {
				if (action === "approve") {
					const current = await runtime.workItems.readEvaluation(workItemId!, evaluationId!);
					const risks = checkpointOptions?.acceptedRisks ?? [];
					const critical = risks.filter((risk) => current.findings?.find((finding) => finding.id === risk.findingId)?.severity === "critical");
					if (critical.length) {
						if (!ctx.hasUI || !(await confirmCriticalRisk(ctx, ref, critical.map((risk) => risk.findingId)))) throw new Error("USER_DECISION_REQUIRED: Explicit user confirmation is required before accepting Critical risk; approval was not recorded.");
					}
					return runtime.workItems.approveEvaluation(workItemId!, evaluationId!, risks.map((risk) => ({ ...risk, ...(critical.some((candidate) => candidate.findingId === risk.findingId) ? { userConfirmed: true } : {}) })));
				}
				throw new Error(`Unsupported checkpoint action: ${action}`);
			});
		},
		async controlWorkflow(ref, action, ctx) {
			const workflow = WORK_ITEM.exec(ref); if (!workflow) throw new Error(`Invalid workflow reference: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const workItemId = workflow[1]!;
			if (action === "resume") {
				const item = await runtime.mutex.run(`workflow-begin:${workItemId}`, async () => {
					const current = await runtime.workItems.read(workItemId);
					const recoverable: Array<{ evaluationId: string; agentId: string; record: RepairRecoveryRecord }> = [];
					const recoveryStore = new RepairRecoveryStore(runtime.identity);
					for (const entry of current.evaluations) {
						const evaluation = await runtime.workItems.readEvaluation(workItemId, entry.id);
						if (evaluation.loop?.state !== "fixing" || !evaluation.loop.fixerAgentId) continue;
						const agent = await runtime.agents.get(evaluation.loop.fixerAgentId).catch(() => undefined);
						if (!agent || !["failed", "protocol_failed", "reported", "recovery_required", "reserved"].includes(agent.state)) continue;
						const record = await recoveryStore.read(workItemId, evaluation.id);
						if (!record || record.agentId !== agent.id) throw new HarnessError("DIRTY_CANONICAL_BRANCH", `Failed fixer ${agent.id} has no matching durable repair recovery record; preserved work requires user-directed recovery`);
						recoverable.push({ evaluationId: evaluation.id, agentId: agent.id, record });
					}
					if (recoverable.length > 1) throw new HarnessError("RESOURCE_LOCKED", `Multiple failed canonical fixers require recovery: ${recoverable.map((entry) => entry.evaluationId).join(", ")}`);
					if (recoverable.length === 1) {
						const recovery = recoverable[0]!;
						await recoveryStore.assertCurrent(recovery.record);
						if (options.validateWorkingBranch) await options.validateWorkingBranch(runtime, workItemId, { allowDirty: recovery.record.dirty });
						else await new WorktreeManager(runtime.identity).validateWorkingBranch(workItemId, { allowDirty: recovery.record.dirty });
						const agent = await runtime.agents.get(recovery.agentId);
						if (agent.state !== "reserved") await runtime.agents.prepareRetry(recovery.agentId);
						return current;
					}
					await runtime.workItems.submitPlanning(workItemId);
					if (options.validateWorkingBranch) await options.validateWorkingBranch(runtime, workItemId);
					else await new WorktreeManager(runtime.identity).validateWorkingBranch(workItemId);
					const begun = await runtime.workItems.beginExecution(workItemId);
					await runtime.workItems.ensureFinalEvaluations(workItemId, runtime.config?.limits.repairRounds ?? DEFAULT_REVIEW_FIX_ITERATIONS);
					await runtime.workItems.activateDraftTasks(workItemId);
					return begun;
				});
				const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
				const taskById = new Map(tasks.map((task) => [task.id, task]));
				for (const task of tasks) {
					if (!["cancelled", "paused", "failed", "protocol_failed"].includes(task.status)) continue;
					const dependenciesDone = task.dependsOn.every((id) => ["merged", "integrated"].includes(taskById.get(id)?.status ?? ""));
					await runtime.mutex.run(`workflow-resume:${item.id}:${task.id}`, () => runtime.workItems.updateTask(item.id, task.id, { status: dependenciesDone ? "ready" : "blocked" }));
				}
				return;
			}
			if (action === "pause") {
				await runtime.workItems.transitionWorkItem(workItemId, "pause", "Workflow paused by user; safe amendment boundary.");
				return;
			}
			for (const agent of await runtime.agents.list()) if (agent.workItemId === workItemId && isAgentProcessActive(agent)) await this.controlSubagent(agent.id, "stop", ctx);
		},
		async listSubagents(ctx) { return (await options.runtimeFor(ctx)).agents.list(); },
		async listMessages(ctx) { return (await options.runtimeFor(ctx)).agents.listMessages().then((messages) => messages.filter((message) => message.status === "open")); },
		async controlSubagent(agentId, action, ctx) {
			const runtime = await options.runtimeFor(ctx); const agent = await runtime.agents.get(agentId); const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
			if (!isAgentProcessActive(agent)) return { agent, signaled: false, reason: "Agent has no active process." };
			if (!attempt) throw new Error(`Agent ${agent.id} has no current process attempt.`);
			const heartbeatText = await readTextIfExists(join(runtime.agents.root, "agents", agent.id, "attempts", attempt.id, "heartbeat.json"));
			const heartbeat = heartbeatText ? JSON.parse(heartbeatText) as { attemptId?: string; pid?: number; at?: string } : undefined;
			const fresh = heartbeat?.attemptId === attempt.id && heartbeat.at && Date.now() - Date.parse(heartbeat.at) < 15_000;
			if (!fresh || !heartbeat?.pid) throw new Error("Refusing to signal a process without a fresh matching heartbeat.");
			try { process.kill(-heartbeat.pid, "SIGTERM"); } catch { process.kill(heartbeat.pid, "SIGTERM"); }
			return runtime.agents.transition(agent.id, action === "pause" ? "paused" : "cancelled", { summary: `${action} requested by orchestrator` });
		},
		async respondSubagent(agentId, messageId, response, ctx) {
			const runtime = await options.runtimeFor(ctx); const message = await runtime.agents.respondMessage(agentId, messageId, response); const agent = await runtime.agents.get(agentId);
			if (agent.workItemId && agent.taskId) { const task = await runtime.workItems.readTask(agent.workItemId, agent.taskId); if (task.status === "blocked") await runtime.mutex.run(`agent-response:${messageId}`, () => runtime.workItems.updateTask(agent.workItemId!, agent.taskId!, { status: "ready" })); }
			return { message, ...(agent.workItemId ? { workflowRef: `work-item:${agent.workItemId}` } : {}) };
		},
	};
}
