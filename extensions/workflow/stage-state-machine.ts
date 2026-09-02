import {
	emptyWorkflowMetrics,
	isCurrentAttempt,
	markWorkflowClockIncomplete,
	type ActiveSlotAttempt,
	type DurableCheckState,
	type FailureSummary,
	type IntegrationRuntimeState,
	type ReviewRuntimeState,
	type RuntimeOwner,
	type StageRuntimeState,
	type StoryRuntimeState,
	type StructuredFinding,
	type TaskRuntimeState,
	type VerificationRuntimeState,
} from "./story-runtime-store.js";

export interface MachineCheck { id: string }
export interface MachineTask { id: string; checks?: readonly MachineCheck[] }
export interface MachineStage {
	id: string;
	mode: "sequential" | "concurrent";
	tasks: readonly MachineTask[];
	checks: readonly MachineCheck[];
	review?: { mode: "required" | "skip"; focus?: string };
}
export interface StageMachinePlan {
	stages: readonly MachineStage[];
}

export type WorkflowActionKind =
	| "task-launch" | "task-check" | "task-repair"
	| "integration" | "integration-repair"
	| "verification" | "verification-repair"
	| "review" | "review-fix"
	| "final-review" | "final-review-fix"
	| "e2e" | "e2e-fix"
	| "completion" | "attention";

export interface WorkflowAction {
	kind: WorkflowActionKind;
	stageId?: string;
	taskId?: string;
	reason?: FailureSummary;
}

export type SettlementResult = "passed" | "repairable" | "critical" | "needs_user" | "unsafe";
export interface CheckSettlement {
	id: string;
	status: "passed" | "failed";
	failure?: FailureSummary;
}
export interface ActionSettlement {
	action: WorkflowAction;
	token: string;
	owner: RuntimeOwner;
	result: SettlementResult;
	summary?: FailureSummary;
	failure?: FailureSummary;
	contributionCommit?: string;
	integratedCommit?: string;
	checks?: readonly CheckSettlement[];
	findings?: readonly StructuredFinding[];
	evidenceRefs?: readonly string[];
}

export interface MachineAdvance {
	state: StoryRuntimeState;
	actions: WorkflowAction[];
	changed: boolean;
}

function checks(items: readonly MachineCheck[] | undefined): DurableCheckState[] {
	return (items ?? []).map(({ id }) => ({ id, status: "pending" }));
}

function reviewState(required: boolean): ReviewRuntimeState {
	return { status: required ? "pending" : "skipped", iteration: 0, repairCount: 0, currentFindings: [] };
}

export function createStoryRuntimeState(
	plan: StageMachinePlan,
	input: Pick<StoryRuntimeState, "storyId" | "contracts" | "git">,
): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId: input.storyId,
		status: "ready",
		contracts: structuredClone(input.contracts),
		git: structuredClone(input.git),
		stages: plan.stages.map((stage): StageRuntimeState => ({
			id: stage.id,
			status: "pending",
			tasks: stage.tasks.map((task): TaskRuntimeState => ({ id: task.id, status: "pending", repairCount: 0, checks: checks(task.checks) })),
			integration: { status: "pending", repairCount: 0, contributionCommits: [] },
			verification: { status: "pending", repairCount: 0, checks: checks(stage.checks) },
			review: reviewState(stage.review?.mode === "required"),
		})),
		finalReview: reviewState(true),
		e2e: { status: "pending", repairCount: 0, evidenceRefs: [] },
		metrics: emptyWorkflowMetrics(),
		outcomeStatus: "pending",
	};
}

export function startWorkflow(state: StoryRuntimeState, owner: RuntimeOwner): StoryRuntimeState {
	if (state.status !== "ready" && state.status !== "paused") return state;
	const next = structuredClone(state);
	next.status = "running";
	next.activationOwner = structuredClone(owner);
	delete next.attention;
	return next;
}

function allTasksComplete(stage: StageRuntimeState): boolean {
	return stage.tasks.every((task) => task.status === "completed");
}

function attentionAction(state: StoryRuntimeState): WorkflowAction[] {
	return [{ kind: "attention", ...(state.attention ? { reason: state.attention } : {}) }];
}

/** Pure scheduling projection. It never starts work or manufactures attempt identities. */
export function advanceStageStateMachine(plan: StageMachinePlan, state: StoryRuntimeState): MachineAdvance {
	if (state.status === "attention") return { state, actions: attentionAction(state), changed: false };
	if (state.status !== "running") return { state, actions: [], changed: false };
	const next = structuredClone(state);
	let changed = false;
	const projected = (actions: WorkflowAction[]): MachineAdvance => ({ state: changed ? next : state, actions, changed });

	for (let index = 0; index < next.stages.length; index++) {
		const stage = next.stages[index]!;
		const definition = plan.stages[index];
		if (!definition || definition.id !== stage.id) return putAttention(next, { code: "plan_mismatch", summary: `Runtime stage ${stage.id} does not match the plan` });
		if (stage.status === "completed") continue;
		if (stage.status !== "running") { stage.status = "running"; changed = true; }
		const activeTask = stage.tasks.some((task) => ["implementing", "checking", "repairing"].includes(task.status));
		const pendingTaskActions = stage.tasks.flatMap((task): WorkflowAction[] => {
			if (task.status === "pending") return [{ kind: "task-launch", stageId: stage.id, taskId: task.id }];
			if (task.status === "check_pending") return [{ kind: "task-check", stageId: stage.id, taskId: task.id }];
			if (task.status === "repair_pending") return [{ kind: "task-repair", stageId: stage.id, taskId: task.id }];
			return [];
		});
		if (!allTasksComplete(stage)) {
			if (definition.mode === "concurrent") return projected(pendingTaskActions);
			return projected(activeTask ? [] : pendingTaskActions.slice(0, 1));
		}
		const integration = actionForIntegration(stage);
		if (integration) return projected([integration]);
		if (stage.integration.status !== "completed") return projected([]);
		const verification = actionForVerification(stage);
		if (verification) return projected([verification]);
		if (stage.verification.status !== "completed") return projected([]);
		const review = actionForReview(stage.review, "review", "review-fix", stage.id);
		if (review) return projected([review]);
		if (stage.review.status !== "completed" && stage.review.status !== "skipped") return projected([]);
		stage.status = "completed";
		changed = true;
	}

	const finalReview = actionForReview(next.finalReview, "final-review", "final-review-fix");
	if (finalReview) return projected([finalReview]);
	if (next.finalReview.status !== "completed") return projected([]);
	if (next.e2e.status === "pending") return projected([{ kind: "e2e" }]);
	if (next.e2e.status === "fix_pending") return projected([{ kind: "e2e-fix" }]);
	if (next.e2e.status !== "completed") return projected([]);
	return projected([{ kind: "completion" }]);
}

function actionForIntegration(stage: StageRuntimeState): WorkflowAction | undefined {
	if (stage.integration.status === "pending") return { kind: "integration", stageId: stage.id };
	if (stage.integration.status === "repair_pending") return { kind: "integration-repair", stageId: stage.id };
	return undefined;
}

function actionForVerification(stage: StageRuntimeState): WorkflowAction | undefined {
	if (stage.verification.status === "pending") return { kind: "verification", stageId: stage.id };
	if (stage.verification.status === "repair_pending") return { kind: "verification-repair", stageId: stage.id };
	return undefined;
}

function actionForReview(review: ReviewRuntimeState, reviewKind: "review" | "final-review", fixKind: "review-fix" | "final-review-fix", stageId?: string): WorkflowAction | undefined {
	if (review.status === "pending") return { kind: reviewKind, ...(stageId ? { stageId } : {}) };
	if (review.status === "fix_pending") return { kind: fixKind, ...(stageId ? { stageId } : {}) };
	return undefined;
}

function putAttention(state: StoryRuntimeState, reason: FailureSummary): MachineAdvance {
	state.status = "attention";
	state.attention = reason;
	return { state, actions: [{ kind: "attention", reason }], changed: true };
}

function stageById(state: StoryRuntimeState, id: string | undefined): StageRuntimeState | undefined {
	return id ? state.stages.find((stage) => stage.id === id) : undefined;
}
function taskByAction(state: StoryRuntimeState, action: WorkflowAction): TaskRuntimeState | undefined {
	return stageById(state, action.stageId)?.tasks.find((task) => task.id === action.taskId);
}
function attempt(token: string, owner: RuntimeOwner, activatedAt: string): ActiveSlotAttempt {
	return { token, owner: structuredClone(owner), activatedAt };
}

/** Mark one projected action active. Completion is the only synchronous action. */
export function activateWorkflowAction(state: StoryRuntimeState, action: WorkflowAction, token: string, owner: RuntimeOwner, activatedAt: string): StoryRuntimeState {
	if (state.status !== "running" || action.kind === "attention" || !state.activationOwner || !sameOwner(state.activationOwner, owner)) return state;
	const next = structuredClone(state);
	if (action.kind === "completion") {
		next.status = "completed";
		return next;
	}
	const activeAttempt = attempt(token, owner, activatedAt);
	const task = taskByAction(next, action);
	if (task) {
		if (action.kind === "task-launch" && task.status === "pending") task.status = "implementing";
		else if (action.kind === "task-check" && task.status === "check_pending") { task.status = "checking"; task.checks.forEach((check) => { check.status = "running"; delete check.failure; }); }
		else if (action.kind === "task-repair" && task.status === "repair_pending") task.status = "repairing";
		else return next;
		task.attempt = activeAttempt;
		delete task.interruptedFrom;
		return next;
	}
	const stage = stageById(next, action.stageId);
	if (stage && activateStageAction(stage, action.kind, activeAttempt)) return next;
	if (activateReview(next.finalReview, action.kind, activeAttempt, "final-review", "final-review-fix")) return next;
	if (action.kind === "e2e" && next.e2e.status === "pending") { next.e2e.status = "testing"; next.e2e.attempt = activeAttempt; return next; }
	if (action.kind === "e2e-fix" && next.e2e.status === "fix_pending") { next.e2e.status = "fixing"; next.e2e.attempt = activeAttempt; return next; }
	return next;
}

function activateStageAction(stage: StageRuntimeState, kind: WorkflowActionKind, activeAttempt: ActiveSlotAttempt): boolean {
	if (kind === "integration" && stage.integration.status === "pending") {
		stage.integration.status = "integrating";
		stage.integration.contributionCommits = stage.tasks.flatMap((task) => task.contributionCommit ? [task.contributionCommit] : []);
		stage.integration.attempt = activeAttempt; return true;
	}
	if (kind === "integration-repair" && stage.integration.status === "repair_pending") { stage.integration.status = "repairing"; stage.integration.attempt = activeAttempt; return true; }
	if (kind === "verification" && stage.verification.status === "pending") { stage.verification.status = "checking"; stage.verification.checks.forEach((check) => { check.status = "running"; delete check.failure; }); stage.verification.attempt = activeAttempt; return true; }
	if (kind === "verification-repair" && stage.verification.status === "repair_pending") { stage.verification.status = "repairing"; stage.verification.attempt = activeAttempt; return true; }
	return activateReview(stage.review, kind, activeAttempt, "review", "review-fix");
}

function activateReview(review: ReviewRuntimeState, kind: WorkflowActionKind, activeAttempt: ActiveSlotAttempt, reviewKind: WorkflowActionKind, fixKind: WorkflowActionKind): boolean {
	if (kind === reviewKind && review.status === "pending") { review.status = "reviewing"; review.iteration += 1; review.attempt = activeAttempt; return true; }
	if (kind === fixKind && review.status === "fix_pending") { review.status = "fixing"; review.attempt = activeAttempt; return true; }
	return false;
}

function failure(settlement: ActionSettlement): FailureSummary {
	return settlement.failure ?? { code: settlement.result, summary: `Action ended with ${settlement.result}` };
}
function success(settlement: ActionSettlement): FailureSummary {
	return settlement.summary ?? { code: "passed", summary: "Action passed" };
}
function requiresAttention(settlement: ActionSettlement): boolean {
	return settlement.result === "critical" || settlement.result === "needs_user" || settlement.result === "unsafe"
		|| Boolean(settlement.findings?.some((finding) => finding.severity === "critical"));
}
function setAttention(state: StoryRuntimeState, target: { status: string; result?: FailureSummary; failure?: FailureSummary }, reason: FailureSummary): void {
	(target as { status: "attention" }).status = "attention";
	delete target.result;
	target.failure = reason;
	state.status = "attention";
	state.attention = reason;
}
function repairOrAttention(state: StoryRuntimeState, target: { status: string; repairCount: number; result?: FailureSummary; failure?: FailureSummary }, pending: "repair_pending" | "fix_pending", settlement: ActionSettlement, repairRounds: number): void {
	const reason = failure(settlement);
	delete target.result;
	if (requiresAttention(settlement)) { setAttention(state, target, reason); return; }
	if (target.repairCount >= repairRounds) { setAttention(state, target, { code: "repair_exhausted", summary: reason.summary }); return; }
	(target as { status: typeof pending }).status = pending;
	target.failure = reason;
}

/** Settle only the matching active attempt; stale callbacks return the original state reference. */
export function settleWorkflowAction(state: StoryRuntimeState, settlement: ActionSettlement, repairRounds: number): { state: StoryRuntimeState; accepted: boolean } {
	if (!Number.isInteger(repairRounds) || repairRounds < 0) throw new Error("repairRounds must be a non-negative integer");
	const next = structuredClone(state);
	const action = settlement.action;
	const task = taskByAction(next, action);
	if (task) {
		const expected = action.kind === "task-launch" ? "implementing" : action.kind === "task-check" ? "checking" : "repairing";
		if (task.status !== expected || !isCurrentAttempt(task, settlement.token, settlement.owner)) return { state, accepted: false };
		delete task.attempt;
		settleTask(next, task, action.kind, settlement, repairRounds);
		if (next.status === "attention") stageById(next, action.stageId)!.status = "attention";
		return { state: next, accepted: true };
	}
	const stage = stageById(next, action.stageId);
	if (stage) {
		const target = stageTarget(stage, action.kind);
		if (!target || !isCurrentAttempt(target, settlement.token, settlement.owner)) return { state, accepted: false };
		delete target.attempt;
		settleStageTarget(next, stage, action.kind, settlement, repairRounds);
		if (next.status === "attention") stage.status = "attention";
		return { state: next, accepted: true };
	}
	if (action.kind === "final-review" || action.kind === "final-review-fix") {
		if (!isCurrentAttempt(next.finalReview, settlement.token, settlement.owner)) return { state, accepted: false };
		delete next.finalReview.attempt;
		settleReview(next, next.finalReview, action.kind === "final-review-fix", settlement, repairRounds);
		return { state: next, accepted: true };
	}
	if (action.kind === "e2e" || action.kind === "e2e-fix") {
		if (!isCurrentAttempt(next.e2e, settlement.token, settlement.owner)) return { state, accepted: false };
		delete next.e2e.attempt;
		settleE2E(next, action.kind === "e2e-fix", settlement, repairRounds);
		return { state: next, accepted: true };
	}
	return { state, accepted: false };
}

function settleTask(state: StoryRuntimeState, task: TaskRuntimeState, kind: WorkflowActionKind, settlement: ActionSettlement, budget: number): void {
	if (kind === "task-check") finalizeChecks(task.checks, settlement);
	if (settlement.result !== "passed") {
		if (kind === "task-repair") task.repairCount += 1;
		repairOrAttention(state, task, "repair_pending", settlement, budget);
		return;
	}
	delete task.failure;
	task.result = success(settlement);
	if (settlement.contributionCommit) task.contributionCommit = settlement.contributionCommit;
	if (kind === "task-launch") task.status = task.checks.length > 0 ? "check_pending" : "completed";
	else if (kind === "task-check") task.status = "completed";
	else { task.repairCount += 1; task.status = task.checks.length > 0 ? "check_pending" : "completed"; }
}

function stageTarget(stage: StageRuntimeState, kind: WorkflowActionKind): IntegrationRuntimeState | VerificationRuntimeState | ReviewRuntimeState | undefined {
	if (kind === "integration" || kind === "integration-repair") return stage.integration;
	if (kind === "verification" || kind === "verification-repair") return stage.verification;
	if (kind === "review" || kind === "review-fix") return stage.review;
	return undefined;
}

function settleStageTarget(state: StoryRuntimeState, stage: StageRuntimeState, kind: WorkflowActionKind, settlement: ActionSettlement, budget: number): void {
	if (kind === "review" || kind === "review-fix") {
		settleReview(state, stage.review, kind === "review-fix", settlement, budget);
		if (kind === "review-fix" && settlement.result === "passed" && settlement.integratedCommit) stage.integration.integratedCommit = settlement.integratedCommit;
		return;
	}
	const target = kind === "integration" || kind === "integration-repair" ? stage.integration : stage.verification;
	if (target === stage.verification && kind === "verification") finalizeChecks(stage.verification.checks, settlement);
	const repairing = kind === "integration-repair" || kind === "verification-repair";
	if (settlement.result !== "passed") {
		if (repairing) target.repairCount += 1;
		repairOrAttention(state, target, "repair_pending", settlement, budget); return;
	}
	if (repairing) target.repairCount += 1;
	delete target.failure;
	target.result = success(settlement);
	if (target === stage.verification && repairing) target.status = "pending";
	else target.status = "completed";
	if ((target === stage.integration || kind === "verification-repair") && settlement.integratedCommit) stage.integration.integratedCommit = settlement.integratedCommit;
}

function settleReview(state: StoryRuntimeState, review: ReviewRuntimeState, fixing: boolean, settlement: ActionSettlement, budget: number): void {
	if (settlement.findings) review.currentFindings = structuredClone([...settlement.findings]);
	const critical = review.currentFindings.find((finding) => finding.severity === "critical");
	if (critical) {
		setAttention(state, review, { code: critical.code, summary: critical.summary });
		return;
	}
	if (settlement.result !== "passed") {
		if (fixing) review.repairCount += 1;
		repairOrAttention(state, review, "fix_pending", settlement, budget); return;
	}
	delete review.failure;
	review.result = success(settlement);
	if (fixing) { review.repairCount += 1; review.status = "pending"; }
	else { review.status = "completed"; review.currentFindings = []; }
}

function settleE2E(state: StoryRuntimeState, fixing: boolean, settlement: ActionSettlement, budget: number): void {
	if (!fixing && settlement.evidenceRefs) state.e2e.evidenceRefs = [...settlement.evidenceRefs];
	if (settlement.result !== "passed") {
		if (fixing) state.e2e.repairCount += 1;
		repairOrAttention(state, state.e2e, "fix_pending", settlement, budget); return;
	}
	delete state.e2e.failure;
	state.e2e.result = success(settlement);
	if (fixing) { state.e2e.repairCount += 1; state.e2e.status = "pending"; }
	else state.e2e.status = "completed";
}

function finalizeChecks(target: DurableCheckState[], settlement: ActionSettlement): void {
	if (settlement.checks) applyChecks(target, settlement.checks);
	for (const check of target) {
		if (settlement.result === "passed") { check.status = "passed"; delete check.failure; }
		else if (check.status === "running") { check.status = "failed"; check.failure = failure(settlement); }
	}
}
function applyChecks(target: DurableCheckState[], results: readonly CheckSettlement[]): void {
	const byId = new Map(results.map((result) => [result.id, result]));
	for (const check of target) {
		const result = byId.get(check.id);
		if (!result) continue;
		check.status = result.status;
		if (result.failure) check.failure = structuredClone(result.failure); else delete check.failure;
	}
}
function sameOwner(left: RuntimeOwner, right: RuntimeOwner): boolean {
	return left.activationId === right.activationId && left.processInstanceId === right.processInstanceId && left.sessionId === right.sessionId;
}

/** Fence all attempts owned by a lost activation and pause without crediting unknown clock time. */
export function interruptOwnedAttempts(state: StoryRuntimeState, owner: RuntimeOwner): StoryRuntimeState {
	if ((state.status !== "running" && state.status !== "paused") || !state.activationOwner || !sameOwner(state.activationOwner, owner)) return state;
	const next = structuredClone(state);
	const interrupt = <T extends { status: string; attempt?: ActiveSlotAttempt; interruptedFrom?: string }>(target: T): void => {
		if (!target.attempt || !sameOwner(target.attempt.owner, owner)) return;
		target.interruptedFrom = target.status;
		(target as { status: "interrupted" }).status = "interrupted";
		delete target.attempt;
	};
	for (const stage of next.stages) {
		stage.tasks.forEach(interrupt);
		interrupt(stage.integration); interrupt(stage.verification); interrupt(stage.review);
	}
	interrupt(next.finalReview); interrupt(next.e2e);
	next.status = "paused";
	delete next.activationOwner;
	next.metrics = markWorkflowClockIncomplete(next.metrics);
	return next;
}

/** Explicit resume maps interrupted domain work back to its pending phase; activation creates fresh tokens later. */
export function resumeInterruptedWorkflow(state: StoryRuntimeState, owner: RuntimeOwner): StoryRuntimeState {
	if (state.status !== "paused") return state;
	const next = structuredClone(state);
	for (const stage of next.stages) {
		for (const task of stage.tasks) if (task.status === "interrupted") {
			task.status = task.interruptedFrom === "checking" ? "check_pending" : task.interruptedFrom === "repairing" ? "repair_pending" : "pending";
			delete task.interruptedFrom;
		}
		if (stage.integration.status === "interrupted") { stage.integration.status = stage.integration.interruptedFrom === "repairing" ? "repair_pending" : "pending"; delete stage.integration.interruptedFrom; }
		if (stage.verification.status === "interrupted") { stage.verification.status = stage.verification.interruptedFrom === "repairing" ? "repair_pending" : "pending"; delete stage.verification.interruptedFrom; }
		resumeReview(stage.review);
	}
	resumeReview(next.finalReview);
	if (next.e2e.status === "interrupted") { next.e2e.status = next.e2e.interruptedFrom === "fixing" ? "fix_pending" : "pending"; delete next.e2e.interruptedFrom; }
	next.status = "running";
	next.activationOwner = structuredClone(owner);
	return next;
}
function resumeReview(review: ReviewRuntimeState): void {
	if (review.status !== "interrupted") return;
	review.status = review.interruptedFrom === "fixing" ? "fix_pending" : "pending";
	delete review.interruptedFrom;
}

export interface AttentionRiskAcceptance {
	findingId: string;
	rationale: string;
}

export type AttentionResolution =
	| { action: "request_changes"; prompt?: string }
	| { action: "approve"; acceptedRisks: readonly AttentionRiskAcceptance[]; acceptedAt: string };

/** Resolve only the authoritative slot currently holding attention; resume is a separate explicit control. */
export function resolveWorkflowAttention(
	state: StoryRuntimeState,
	resolution: AttentionResolution,
	repairRounds: number,
): { state: StoryRuntimeState; accepted: boolean; reason?: FailureSummary } {
	if (!Number.isInteger(repairRounds) || repairRounds < 0) throw new Error("repairRounds must be a non-negative integer");
	if (state.status !== "attention" && state.status !== "paused") return { state, accepted: false, reason: { code: "not_attention", summary: "Workflow has no authoritative attention state" } };
	const next = structuredClone(state);
	const clearGlobal = () => {
		next.status = "paused";
		delete next.attention;
	};
	const requestRepair = (target: { status: string; repairCount: number; failure?: FailureSummary }, pending: "repair_pending" | "fix_pending", stage?: StageRuntimeState) => {
		if (target.repairCount >= repairRounds) return false;
		(target as { status: typeof pending }).status = pending;
		if (resolution.action === "request_changes" && resolution.prompt?.trim()) target.failure = { code: "user_change_request", summary: resolution.prompt.trim() };
		if (stage) stage.status = "running";
		clearGlobal();
		return true;
	};

	for (const stage of next.stages) {
		for (const task of stage.tasks) if (task.status === "attention") {
			if (resolution.action !== "request_changes" || !requestRepair(task, "repair_pending", stage)) return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "Task attention requires an available repair round" } };
			return { state: next, accepted: true };
		}
		if (stage.integration.status === "attention") {
			if (resolution.action !== "request_changes" || !requestRepair(stage.integration, "repair_pending", stage)) return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "Integration attention requires an available repair round" } };
			return { state: next, accepted: true };
		}
		if (stage.verification.status === "attention") {
			if (resolution.action !== "request_changes" || !requestRepair(stage.verification, "repair_pending", stage)) return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "Verification attention requires an available repair round" } };
			return { state: next, accepted: true };
		}
		if (stage.review.status === "attention") return resolveReviewAttention(state, next, stage.review, resolution, repairRounds, stage);
	}
	if (next.finalReview.status === "attention") return resolveReviewAttention(state, next, next.finalReview, resolution, repairRounds);
	if (next.e2e.status === "attention") {
		if (resolution.action !== "request_changes" || !requestRepair(next.e2e, "fix_pending")) return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "E2E attention requires an available repair round" } };
		return { state: next, accepted: true };
	}
	return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "Workflow attention is not attached to a repairable runtime slot" } };
}

function resolveReviewAttention(
	original: StoryRuntimeState,
	next: StoryRuntimeState,
	review: ReviewRuntimeState,
	resolution: AttentionResolution,
	repairRounds: number,
	stage?: StageRuntimeState,
): { state: StoryRuntimeState; accepted: boolean; reason?: FailureSummary } {
	if (resolution.action === "request_changes") {
		if (review.repairCount >= repairRounds) return { state: original, accepted: false, reason: { code: "repair_exhausted", summary: "Review repair budget is exhausted" } };
		review.status = "fix_pending";
		if (resolution.prompt?.trim()) review.failure = { code: "user_change_request", summary: resolution.prompt.trim() };
		if (stage) stage.status = "running";
		next.status = "paused";
		delete next.attention;
		return { state: next, accepted: true };
	}
	const findings = review.currentFindings;
	const accepted = new Map(resolution.acceptedRisks.map((risk) => [risk.findingId, risk.rationale.trim()]));
	if (!findings.some((finding) => finding.severity === "critical") || findings.some((finding) => !accepted.get(finding.id))) {
		return { state: original, accepted: false, reason: { code: "risk_acceptance_incomplete", summary: "Every unresolved review finding requires an explicit non-empty acceptance rationale, including at least one critical finding" } };
	}
	review.acceptedRisks = [
		...(review.acceptedRisks ?? []),
		...findings.map((finding) => ({ findingId: finding.id, rationale: accepted.get(finding.id)!, acceptedAt: resolution.acceptedAt })),
	];
	review.status = "completed";
	review.result = { code: "accepted_risk", summary: `${findings.length} unresolved finding(s) explicitly accepted` };
	delete review.failure;
	if (stage) stage.status = "running";
	next.status = "paused";
	delete next.attention;
	return { state: next, accepted: true };
}
