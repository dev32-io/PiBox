import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type { DynamicSubagentRequest, SpawnableAgentDefinition, WorkflowAdapter, WorkflowRunResult, WorkflowSnapshot, WorkflowStep, WorkflowStepStatus, WorkflowStartProgress } from "../workflow-runtime/api.js";
import { isAgentProcessActive, type SessionAgentRecord, type SessionAgentRegistry } from "../workflow-runtime/agent-registry.js";
import type { RepositoryIdentity } from "./repository.js";
import { readTextIfExists } from "./repository.js";
import type { WorkItemStore } from "./work-items.js";
import { orderedExecutionStages, preflightTaskChecks, resolveStageMode, taskExecutionTopology } from "./execution-topology.js";
import { WorktreeManager } from "./worktrees.js";
import type { RepositoryMutex } from "./idempotency.js";
import { readBuiltInPrompt, renderBuiltInPrompt } from "./prompt-loader.js";
import { confirmCriticalRisk } from "../permissions/runtime.js";

export interface HarnessWorkflowRuntime {
	identity: RepositoryIdentity;
	workItems: WorkItemStore;
	mutex: RepositoryMutex;
	agents: SessionAgentRegistry;
	config?: { limits: { repairRounds: number } };
}

export interface HarnessWorkflowAdapterOptions {
	runtimeFor(ctx: ExtensionContext): Promise<HarnessWorkflowRuntime>;
	launchTask(ctx: ExtensionContext, workItemId: string, taskId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	launchEvaluation(ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	launchRepair?(ctx: ExtensionContext, workItemId: string, evaluationId: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	/** Harness-owned repair assignment for a preserved stage merge conflict. */
	launchIntegrationRepair?(ctx: ExtensionContext, workItemId: string, stageId: string, taskIds: string[], evidencePath: string, signal?: AbortSignal): Promise<{ content: Array<{ type: string; text?: string }>; details?: any }>;
	spawnSubagent?(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void): Promise<WorkflowRunResult>;
	listSpawnableAgents?(ctx: ExtensionContext): Promise<SpawnableAgentDefinition[]>;
	validateWorkingBranch?(runtime: HarnessWorkflowRuntime, workItemId: string): Promise<void>;
	reconcileReported?(runtime: HarnessWorkflowRuntime): Promise<void>;
}

const WORK_ITEM = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const STEP = /^work-item:([a-z0-9]+(?:-[a-z0-9]+)*)\/(task|evaluation):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const settledAgent = new Set(["completed", "cancelled"]);
const taskDone = new Set(["merged", "integrated"]);
const REPORT_RECONCILIATION_GRACE_MS = 5_000;

function agentAttention(agent: SessionAgentRecord): string | undefined {
	if (isAgentProcessActive(agent) || settledAgent.has(agent.state)) return undefined;
	if (agent.state === "reported") return "result pending reconciliation";
	if ((agent.state === "launching" || agent.state === "running") && agent.currentAttemptId) return "stale process state";
	return agent.state.replaceAll("_", " ");
}

function scopeActivity(agents: SessionAgentRecord[], scope: "taskId" | "evaluationId", id: string, relevant?: (agent: SessionAgentRecord) => boolean): { running: boolean; attention?: string } {
	const matching = agents.filter((agent) => agent[scope] === id && (!relevant || relevant(agent)));
	if (matching.some(isAgentProcessActive)) return { running: true };
	const attention = matching.map(agentAttention).find((detail): detail is string => Boolean(detail));
	return { running: false, ...(attention ? { attention } : {}) };
}

function evaluationActivity(agents: SessionAgentRecord[], evaluation: { id: string; loop?: { state?: string; reviewerAgentId?: string; fixerAgentId?: string } }): { running: boolean; attention?: string } {
	const loop = evaluation.loop;
	if (loop?.state === "fixing") {
		// A reported reviewer is the settled result which caused this checkpoint; it
		// is not activity for the queued fixer. Prefer the persisted fixer identity
		// when present so retries resume the same logical worker.
		return scopeActivity(agents, "evaluationId", evaluation.id, (agent) =>
			(loop.fixerAgentId ? agent.id === loop.fixerAgentId : agent.role === "repair-implementer"));
	}
	if (loop?.state === "rereviewing" || loop?.state === "reviewing") {
		return scopeActivity(agents, "evaluationId", evaluation.id, (agent) =>
			(loop.reviewerAgentId ? agent.id === loop.reviewerAgentId : agent.role !== "repair-implementer"));
	}
	return scopeActivity(agents, "evaluationId", evaluation.id);
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
		async preflightWorkflow(ref, ctx) {
			const match = WORK_ITEM.exec(ref); if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
			const missing = await preflightTaskChecks(item, tasks);
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
				progress("Creating runtime verification gates"); await runtime.workItems.ensureFinalEvaluations(match[1]!, runtime.config?.limits.repairRounds ?? 2);
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
		async snapshot(ref, ctx): Promise<WorkflowSnapshot> {
			const match = WORK_ITEM.exec(ref);
			if (!match) throw new Error(`A workflow must reference a work item: ${ref}`);
			const runtime = await options.runtimeFor(ctx);
			const item = await runtime.workItems.read(match[1]!);
			let agents = await runtime.agents.list();
			const staleReport = agents.some((agent) => agent.state === "reported" && Date.now() - Date.parse(agent.updatedAt) >= REPORT_RECONCILIATION_GRACE_MS);
			if (staleReport && options.reconcileReported) {
				await options.reconcileReported(runtime).catch(() => undefined);
				agents = await runtime.agents.list();
			}
			const tasks = await Promise.all(item.tasks.map((entry) => runtime.workItems.readTask(item.id, entry.id)));
			const evaluations = await Promise.all(item.evaluations.map((entry) => runtime.workItems.readEvaluation(item.id, entry.id)));
			const taskById = new Map(tasks.map((task) => [task.id, task]));
			const evaluationById = new Map(evaluations.map((evaluation) => [evaluation.id, evaluation]));
			const stages = orderedExecutionStages(item);
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
				if (isMergeState && (!priorSequentialTaskDone || !parallelStageReadyToMerge || !mergeBarrierOwner)) mapped = { status: "pending", detail: !priorSequentialTaskDone ? "waiting for prior sequential task" : parallelStageReadyToMerge ? "waiting for stage merge barrier" : "waiting for parallel contributions" };
				if (mapped.status === "running") {
					const activity = scopeActivity(agents, "taskId", task.id);
					if (!activity.running) mapped = { status: "attention", detail: activity.attention ?? "stale process state" };
				}
				return {
					ref: `work-item:${item.id}/task:${task.id}`,
					title: task.title,
					kind: isMergeState ? "merge" : "task",
					...mapped,
					dependsOn: [...task.dependsOn.map((id) => `work-item:${item.id}/task:${id}`), ...(topology.stageIndex > 0 && stageReviews.get(stages[topology.stageIndex - 1]!.id) ? [`work-item:${item.id}/evaluation:${stageReviews.get(stages[topology.stageIndex - 1]!.id)!.id}`] : [])],
					parallelism: isMergeState ? "serial" : topology.parallelism,
					resourceClaims: isMergeState || topology.isolation === "repository" ? ["working-branch"] : task.execution.resourceClaims,
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
				if (["passed", "not_applicable"].includes(evaluation.status) || evaluation.loop?.state === "skipped") status = "done";
				else if (activity.running) { status = "running"; detail = evaluation.loop?.state === "fixing" ? "fixing" : evaluation.loop?.state === "rereviewing" ? "re-reviewing" : "reviewing"; }
				else if (activity.attention) { status = "attention"; detail = activity.attention; }
				else if (dependencyAttention) { status = "attention"; detail = `blocked by ${dependencyAttention.title}`; }
				else if (evaluation.loop?.state === "fixing" || evaluation.loop?.state === "rereviewing") { status = dependenciesDone ? "ready" : "pending"; detail = `${evaluation.loop.state.replace("rereviewing", "re-reviewing")} · iteration ${evaluation.loop.iteration}`; }
				else if (evaluation.loop?.state === "awaiting_manager" || ["failed", "blocked"].includes(evaluation.status)) { status = "attention"; detail = evaluation.loop?.state === "awaiting_manager" ? `awaiting manager · iteration ${evaluation.loop.iteration}` : evaluation.status; }
				else if (evaluation.status === "running") { status = "attention"; detail = "stale process state"; }
				else if (dependenciesDone) status = "ready";
				const phase = evaluation.loop?.state === "rereviewing" ? `re-reviewing #${evaluation.loop.iteration}` : evaluation.loop?.state === "fixing" ? activity.running ? `fixing #${Math.max(2, evaluation.loop.iteration + 1)}` : "Fix requested" : ["passed", "not_applicable"].includes(evaluation.status) ? "Approved" : evaluation.loop?.state === "awaiting_manager" ? "Needs attention" : "Reviewing";
				const findings = evaluation.findings ?? [];
				const open = findings.filter((finding) => ["open", "needs_user", "accepted"].includes(finding.status));
				const blocking = open.filter((finding) => finding.blocking);
				const guidance = `findings ${open.length} (blocking ${blocking.length}); iteration ${evaluation.loop?.iteration ?? 0}/${evaluation.loop?.maxIterations ?? runtime.config?.limits.repairRounds ?? 2}; allowed actions: Approve or Request changes${evaluation.loop?.managerPrompt ? `; manager guidance: ${evaluation.loop.managerPrompt}` : ""}`;
				const stepDetail = activity.attention || dependencyAttention ? detail : [detail, guidance].filter(Boolean).join(" · ");
				steps.push({ ref: `work-item:${item.id}/evaluation:${evaluation.id}`, title: `Review loop ${evaluation.id} · ${phase}`, kind: "evaluation", status, ...(stepDetail ? { detail: stepDetail } : {}), dependsOn: dependencies, parallelism: "serial", resourceClaims: [] });
			}
			const status = steps.some((step) => step.status === "attention" || step.status === "cancelled") ? "attention" : steps.length > 0 && steps.every((step) => step.status === "done") ? "done" : steps.some((step) => step.status === "running") ? "running" : "ready";
			const plannerStages = stages.map((stage, index) => ({ id: stage.id, index, nodes: [...stage.tasks.map((id) => `task:${id}`), ...(stageReviews.get(stage.id) ? [`evaluation:${stageReviews.get(stage.id)!.id}`] : [])], parallel: resolveStageMode(stage) === "concurrent", group: "planner" as const }));
			const runtimeNodes = evaluations.filter((evaluation) => ["final-e2e", "final-review"].includes(evaluation.checkpoint ?? "") || (evaluation.type === "e2e" && evaluation.scope.workItem === item.id)).map((evaluation) => `evaluation:${evaluation.id}`);
			return { ref, title: item.title || item.id, status, steps, stages: [...plannerStages, ...(runtimeNodes.length ? [{ id: "runtime-verification", index: plannerStages.length, nodes: runtimeNodes, parallel: false, group: "runtime" as const }] : [])] };
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
		...(options.spawnSubagent ? { async spawnSubagent(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void) { return options.spawnSubagent!(request, ctx, signal, onText); } } : {}),
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
					const currentLoop = current.loop ?? { state: "planned" as const, iteration: 0, maxIterations: runtime.config?.limits.repairRounds ?? 2 };
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
					// Record authorization only. The runner owns fixer launch, settlement,
					// and automatic re-review.
					return runtime.workItems.updateEvaluationLoop(workItemId!, evaluationId!, { state: "fixing", managerPrompt: prompt });
				});
			}
			return runtime.mutex.run(`checkpoint:${workItemId}:${evaluationId}`, async () => {
				if (action === "approve") {
					const risks = checkpointOptions?.acceptedRisks ?? [];
					const critical = risks.filter((risk) => evaluation.findings?.find((finding) => finding.id === risk.findingId)?.severity === "critical");
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
					await runtime.workItems.submitPlanning(workItemId);
					if (options.validateWorkingBranch) await options.validateWorkingBranch(runtime, workItemId);
					else await new WorktreeManager(runtime.identity).validateWorkingBranch(workItemId);
					const begun = await runtime.workItems.beginExecution(workItemId);
					await runtime.workItems.ensureFinalEvaluations(workItemId, runtime.config?.limits.repairRounds ?? 2);
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
