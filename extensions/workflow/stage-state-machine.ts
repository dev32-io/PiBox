import {
	authoritativeAttentionTarget,
	emptyWorkflowMetrics,
	effectiveExecutionOverrides,
	hasWorkflowAttention,
	isCurrentAttempt,
	markWorkflowClockIncomplete,
	type ActiveSlotAttempt,
	type DurableCheckState,
	type FailureSummary,
	type IntegrationRuntimeState,
	type ReviewRuntimeState,
	type RuntimeCorrectionTarget,
	type RuntimeExecutionCorrection,
	type RuntimeOwner,
	sameCorrectionTarget,
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

export type SettlementResult = "passed" | "repairable" | "critical" | "needs_user" | "unsafe" | "interrupted";
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
	/** Cumulative validated E2E evidence history. */
	evidenceRefs?: readonly string[];
	/** Validated evidence produced by this evaluator attempt only. */
	currentEvidenceRefs?: readonly string[];
	/** Exact canonical report produced by this evaluator attempt. */
	currentReportRef?: string;
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
	if ((state.status !== "ready" && state.status !== "paused") || hasWorkflowAttention(state)) return state;
	const next = structuredClone(state);
	next.status = "running";
	next.activationOwner = structuredClone(owner);
	delete next.attention;
	delete next.attentionTarget;
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

function enterAttention(state: StoryRuntimeState, reason: FailureSummary, target?: RuntimeCorrectionTarget): void {
	state.status = "attention";
	state.attention = reason;
	state.attentionEpoch = (state.attentionEpoch ?? 0) + 1;
	if (target) state.attentionTarget = structuredClone(target); else delete state.attentionTarget;
}

function putAttention(state: StoryRuntimeState, reason: FailureSummary): MachineAdvance {
	enterAttention(state, reason);
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
function setAttention(state: StoryRuntimeState, slot: { status: string; result?: FailureSummary; failure?: FailureSummary }, reason: FailureSummary, target: RuntimeCorrectionTarget): void {
	(slot as { status: "attention" }).status = "attention";
	delete slot.result;
	slot.failure = reason;
	enterAttention(state, reason, target);
}
function repairOrAttention(state: StoryRuntimeState, slot: { status: string; repairCount: number; result?: FailureSummary; failure?: FailureSummary }, pending: "repair_pending" | "fix_pending", settlement: ActionSettlement, repairRounds: number, target: RuntimeCorrectionTarget): void {
	const reason = failure(settlement);
	delete slot.result;
	if (requiresAttention(settlement)) { setAttention(state, slot, reason, target); return; }
	if (slot.repairCount >= repairRounds) {
		setAttention(state, slot, { ...reason, code: "repair_exhausted", causeCode: reason.causeCode ?? reason.code }, target);
		return;
	}
	(slot as { status: typeof pending }).status = pending;
	slot.failure = reason;
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
		settleTask(next, task, action.kind, settlement, repairRounds, { kind: "task", stageId: action.stageId!, taskId: action.taskId! });
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
		settleReview(next, next.finalReview, action.kind === "final-review-fix", settlement, repairRounds, { kind: "final-review" });
		return { state: next, accepted: true };
	}
	if (action.kind === "e2e" || action.kind === "e2e-fix") {
		if (!isCurrentAttempt(next.e2e, settlement.token, settlement.owner)) return { state, accepted: false };
		delete next.e2e.attempt;
		settleE2E(next, action.kind === "e2e-fix", settlement, repairRounds, { kind: "e2e" });
		return { state: next, accepted: true };
	}
	return { state, accepted: false };
}

function settleTask(state: StoryRuntimeState, task: TaskRuntimeState, kind: WorkflowActionKind, settlement: ActionSettlement, budget: number, target: RuntimeCorrectionTarget): void {
	if (kind === "task-check") finalizeChecks(task.checks, settlement);
	if (settlement.result !== "passed") {
		if (kind === "task-repair") task.repairCount += 1;
		repairOrAttention(state, task, "repair_pending", settlement, budget, target);
		return;
	}
	task.result = success(settlement);
	if (settlement.contributionCommit) task.contributionCommit = settlement.contributionCommit;
	if (kind === "task-launch") { delete task.failure; task.status = task.checks.length > 0 ? "check_pending" : "completed"; }
	else if (kind === "task-check") { delete task.failure; task.status = "completed"; }
	else {
		task.repairCount += 1;
		task.status = task.checks.length > 0 ? "check_pending" : "completed";
		if (task.status === "completed") delete task.failure; // retain the failed-check diagnostic until its rerun settles
	}
}

function stageTarget(stage: StageRuntimeState, kind: WorkflowActionKind): IntegrationRuntimeState | VerificationRuntimeState | ReviewRuntimeState | undefined {
	if (kind === "integration" || kind === "integration-repair") return stage.integration;
	if (kind === "verification" || kind === "verification-repair") return stage.verification;
	if (kind === "review" || kind === "review-fix") return stage.review;
	return undefined;
}

function settleStageTarget(state: StoryRuntimeState, stage: StageRuntimeState, kind: WorkflowActionKind, settlement: ActionSettlement, budget: number): void {
	if (kind === "review" || kind === "review-fix") {
		settleReview(state, stage.review, kind === "review-fix", settlement, budget, { kind: "stage-review", stageId: stage.id });
		if (kind === "review-fix" && settlement.result === "passed" && settlement.integratedCommit) stage.integration.integratedCommit = settlement.integratedCommit;
		return;
	}
	const target = kind === "integration" || kind === "integration-repair" ? stage.integration : stage.verification;
	if (target === stage.verification && kind === "verification") finalizeChecks(stage.verification.checks, settlement);
	const repairing = kind === "integration-repair" || kind === "verification-repair";
	if (settlement.result !== "passed") {
		if (repairing) target.repairCount += 1;
		repairOrAttention(state, target, "repair_pending", settlement, budget, { kind: target === stage.integration ? "integration" : "stage-verification", stageId: stage.id }); return;
	}
	if (repairing) target.repairCount += 1;
	target.result = success(settlement);
	if (target === stage.verification && repairing) target.status = "pending"; // retain the failed-check diagnostic until rerun
	else { target.status = "completed"; delete target.failure; }
	if ((target === stage.integration || kind === "verification-repair") && settlement.integratedCommit) stage.integration.integratedCommit = settlement.integratedCommit;
}

function settleReview(state: StoryRuntimeState, review: ReviewRuntimeState, fixing: boolean, settlement: ActionSettlement, budget: number, target: RuntimeCorrectionTarget): void {
	if (fixing && settlement.result === "passed") {
		review.result = success(settlement);
		review.repairCount += 1;
		review.status = "pending";
		return; // only a fresh independent review may clear the retained findings
	}
	if (settlement.findings) {
		const findings = fixing ? [...settlement.findings, ...review.currentFindings] : [...settlement.findings];
		review.currentFindings = structuredClone([...new Map(findings.map((finding) => [finding.id, finding])).values()]);
	}
	const critical = review.currentFindings.find((finding) => finding.severity === "critical");
	if (critical) {
		setAttention(state, review, { code: critical.code, summary: critical.summary }, target);
		return;
	}
	if (settlement.result !== "passed") {
		if (fixing) review.repairCount += 1;
		repairOrAttention(state, review, "fix_pending", settlement, budget, target); return;
	}
	delete review.failure;
	review.result = success(settlement);
	review.status = "completed";
	if (settlement.findings === undefined) review.currentFindings = [];
}

function settleE2E(state: StoryRuntimeState, fixing: boolean, settlement: ActionSettlement, budget: number, target: RuntimeCorrectionTarget): void {
	if (!fixing && settlement.result === "interrupted") {
		state.e2e.status = "interrupted";
		state.e2e.interruptedFrom = "testing";
		state.e2e.failure = failure(settlement);
		state.status = "paused";
		delete state.activationOwner;
		return;
	}
	if (!fixing) {
		if (settlement.evidenceRefs) state.e2e.evidenceRefs = [...new Set([...state.e2e.evidenceRefs, ...settlement.evidenceRefs])];
		const acceptedReportMetadata = settlement.currentReportRef !== undefined || settlement.currentEvidenceRefs !== undefined || settlement.findings !== undefined;
		if (acceptedReportMetadata) {
			if (settlement.findings === undefined) delete state.e2e.currentFindings;
			else state.e2e.currentFindings = structuredClone([...settlement.findings]);
			if (settlement.currentEvidenceRefs === undefined) delete state.e2e.currentEvidenceRefs;
			else state.e2e.currentEvidenceRefs = [...settlement.currentEvidenceRefs];
			if (settlement.currentReportRef === undefined) delete state.e2e.currentReportRef;
			else state.e2e.currentReportRef = settlement.currentReportRef;
		}
	}
	if (settlement.result !== "passed") {
		if (fixing) state.e2e.repairCount += 1;
		repairOrAttention(state, state.e2e, "fix_pending", settlement, budget, target); return;
	}
	state.e2e.result = success(settlement);
	if (fixing) { state.e2e.repairCount += 1; state.e2e.status = "pending"; }
	else { delete state.e2e.failure; state.e2e.status = "completed"; }
}

function finalizeChecks(target: DurableCheckState[], settlement: ActionSettlement): void {
	if (settlement.checks) applyChecks(target, settlement.checks);
	for (const check of target) {
		if (settlement.result === "passed") { check.status = "passed"; delete check.failure; }
		else if (check.status === "running") { check.status = "pending"; delete check.failure; }
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
	| { action: "request_changes"; prompt?: string; correction?: RuntimeExecutionCorrection }
	| { action: "approve"; acceptedRisks: readonly AttentionRiskAcceptance[]; acceptedAt: string };

function correctionCheckStates(checks: readonly import("./types.js").VerificationCheckSpec[]): DurableCheckState[] {
	return checks.map((check, index) => ({ id: typeof check === "string" ? `check-${index + 1}` : check.id ?? `check-${index + 1}`, status: "pending" }));
}

function fenceActiveAttemptsForCorrection(state: StoryRuntimeState): void {
	const fence = (target: { status: string; attempt?: ActiveSlotAttempt; interruptedFrom?: string }) => {
		if (!target.attempt) return;
		target.interruptedFrom = target.status;
		target.status = "interrupted";
		delete target.attempt;
	};
	for (const stage of state.stages) {
		stage.tasks.forEach(fence);
		fence(stage.integration); fence(stage.verification); fence(stage.review);
	}
	fence(state.finalReview); fence(state.e2e);
}

function recordExecutionCorrection(state: StoryRuntimeState, correction: RuntimeExecutionCorrection): void {
	const projected = effectiveExecutionOverrides({
		...(state.executionOverrides ? { executionOverrides: state.executionOverrides } : {}),
		executionCorrections: [...(state.executionCorrections ?? []), structuredClone(correction)],
	});
	state.correctionSequence = correction.sequence;
	state.executionOverrides = projected;
	state.executionCorrections = [...(state.executionCorrections ?? []), structuredClone(correction)];
}

function correctionTargetPrompt(state: StoryRuntimeState, target: RuntimeExecutionCorrection["target"]): string | undefined {
	const overrides = effectiveExecutionOverrides(state);
	if (target.kind === "task") return overrides.tasks.find((entry) => entry.stageId === target.stageId && entry.taskId === target.taskId)?.prompt;
	if (target.kind === "stage-verification") return undefined;
	return overrides.guidance.find((entry) => sameCorrectionTarget(entry.target, target))?.prompt;
}

function attentionBoundary(state: StoryRuntimeState, target: RuntimeCorrectionTarget): { slot: TaskRuntimeState | IntegrationRuntimeState | VerificationRuntimeState | ReviewRuntimeState | StoryRuntimeState["e2e"]; stage?: StageRuntimeState } | undefined {
	if (target.kind === "final-review") return { slot: state.finalReview };
	if (target.kind === "e2e") return { slot: state.e2e };
	const stage = state.stages.find((candidate) => candidate.id === target.stageId);
	if (!stage) return undefined;
	if (target.kind === "task") {
		const slot = stage.tasks.find((candidate) => candidate.id === target.taskId);
		return slot ? { slot, stage } : undefined;
	}
	if (target.kind === "integration") return { slot: stage.integration, stage };
	if (target.kind === "stage-verification") return { slot: stage.verification, stage };
	return { slot: stage.review, stage };
}

function finishAttentionResolution(state: StoryRuntimeState): void {
	delete state.attentionTarget;
	const remaining = authoritativeAttentionTarget(state);
	if (!remaining) {
		const ledgerRecoveries = Object.values(state.ledgerRecoveries ?? {});
		if (ledgerRecoveries.length) {
			state.status = "attention";
			state.attention = { code: "ledger_persistence_failed", summary: `${ledgerRecoveries.length} accepted contribution ledger note(s) still require settlement; next error: ${ledgerRecoveries[0]!.error}` };
			return;
		}
		state.status = "paused";
		delete state.attention;
		return;
	}
	const boundary = attentionBoundary(state, remaining)!;
	if (boundary.stage) boundary.stage.status = "attention";
	enterAttention(state, boundary.slot.failure ?? { code: "attention", summary: "Workflow runtime slot requires attention" }, remaining);
}

export function isExhaustedE2ENeedsUserCorrectionEligible(
	state: StoryRuntimeState,
	target: RuntimeCorrectionTarget,
	repairRounds: number,
): boolean {
	const failure = state.e2e.failure;
	return target.kind === "e2e"
		&& state.e2e.status === "attention"
		&& state.e2e.repairCount >= repairRounds
		&& failure?.code === "needs_user"
		&& (failure.causeCode === undefined || failure.causeCode === "needs_user")
		&& !state.e2e.currentFindings?.some((finding) => finding.severity === "critical");
}

function applyRuntimeCorrection(original: StoryRuntimeState, next: StoryRuntimeState, correction: RuntimeExecutionCorrection, repairRounds: number): { state: StoryRuntimeState; accepted: boolean; reason?: FailureSummary } {
	const epoch = original.attentionEpoch ?? 1; // old attention states predate epochs and are exposed as epoch 1
	if (correction.attentionEpoch !== epoch) return { state: original, accepted: false, reason: { code: "stale_attention_epoch", summary: `Correction targets attention epoch ${correction.attentionEpoch}; current epoch is ${epoch}` } };
	const authoritativeTarget = authoritativeAttentionTarget(original);
	if (!authoritativeTarget || !sameCorrectionTarget(authoritativeTarget, correction.target)) return { state: original, accepted: false, reason: { code: "correction_boundary_mismatch", summary: "Correction does not target the authoritative attention boundary" } };
	const history = original.executionCorrections ?? [];
	const sequence = original.correctionSequence ?? history.at(-1)?.sequence ?? 0;
	if (correction.sequence !== sequence + 1) return { state: original, accepted: false, reason: { code: "correction_history_invalid", summary: "Runtime correction is out of sequence" } };
	const target = correction.target;
	const stage = "stageId" in target ? next.stages.find((candidate) => candidate.id === target.stageId) : undefined;
	if ("stageId" in target && !stage) return { state: original, accepted: false, reason: { code: "correction_boundary_mismatch", summary: "Correction does not target the current attention boundary" } };
	if (target.kind === "task") {
		const task = stage!.tasks.find((candidate) => candidate.id === target.taskId);
		if (!task || task.status !== "attention" || !correction.task) return { state: original, accepted: false, reason: { code: "correction_boundary_mismatch", summary: "Correction does not target the task currently requiring attention" } };
		const changedProse = Boolean(correction.task.description || correction.task.scope || correction.task.delivery);
		if (!changedProse && correction.prompt && (correctionTargetPrompt(original, target) === correction.prompt.trim() || task.failure?.summary === correction.prompt.trim() || original.attention?.summary === correction.prompt.trim())) return { state: original, accepted: false, reason: { code: "correction_noop", summary: "Prompt correction must add genuinely new guidance or evidence" } };
		const implementationGuidance = Boolean(correction.prompt || changedProse);
		if (!implementationGuidance && correction.task.checks) {
			const checkOrigin = task.checks.some((check) => check.status === "failed" && Boolean(check.failure || task.failure?.diagnostic?.checkId === check.id));
			if (!task.contributionCommit || !checkOrigin) return { state: original, accepted: false, reason: { code: "correction_requires_implementation", summary: "Checks-only correction requires a validated contribution and preserved failed-check evidence; provide explicit implementation guidance instead" } };
		}
		fenceActiveAttemptsForCorrection(next);
		recordExecutionCorrection(next, correction);
		if (correction.task.checks) task.checks = correctionCheckStates(correction.task.checks);
		if (correction.prompt?.trim()) task.failure = { code: "user_change_request", summary: correction.prompt.trim() };
		task.status = implementationGuidance ? "repair_pending" : "check_pending";
		stage!.status = "running";
	} else if (target.kind === "stage-verification") {
		if (stage!.verification.status !== "attention" || !correction.stageVerification) return { state: original, accepted: false, reason: { code: "correction_boundary_mismatch", summary: "Correction does not target the stage verification currently requiring attention" } };
		fenceActiveAttemptsForCorrection(next);
		recordExecutionCorrection(next, correction);
		stage!.verification.checks = correctionCheckStates(correction.stageVerification.checks);
		stage!.verification.status = "pending";
		stage!.status = "running";
	} else {
		const slot = target.kind === "integration" ? stage!.integration
			: target.kind === "stage-review" ? stage!.review
				: target.kind === "final-review" ? next.finalReview : next.e2e;
		if (slot.status !== "attention") return { state: original, accepted: false, reason: { code: "correction_boundary_mismatch", summary: "Guidance correction does not target the runtime slot currently requiring attention" } };
		if (slot.failure?.code !== "repair_exhausted" && !isExhaustedE2ENeedsUserCorrectionEligible(original, target, repairRounds)) return { state: original, accepted: false, reason: { code: "guidance_requires_repair_exhaustion", summary: "Runtime-slot guidance is valid only for authoritative repair-exhausted attention" } };
		if ((target.kind === "stage-review" || target.kind === "final-review") && (slot as ReviewRuntimeState).currentFindings.some((finding) => finding.severity === "critical")) return { state: original, accepted: false, reason: { code: "critical_findings_require_user_decision", summary: "Runtime-slot guidance cannot waive a retained Critical finding; use the explicit user-owned Critical handling path" } };
		if (!correction.prompt?.trim() || correctionTargetPrompt(original, target) === correction.prompt.trim() || slot.failure?.summary === correction.prompt.trim() || original.attention?.summary === correction.prompt.trim()) return { state: original, accepted: false, reason: { code: "correction_noop", summary: "Guidance correction must provide genuinely new guidance or evidence" } };
		fenceActiveAttemptsForCorrection(next);
		recordExecutionCorrection(next, correction);
		slot.failure = { code: "user_change_request", summary: correction.prompt.trim() };
		if (target.kind === "integration") { stage!.integration.status = "repair_pending"; stage!.status = "running"; }
		else if (target.kind === "stage-review") { stage!.review.status = "fix_pending"; stage!.status = "running"; }
		else if (target.kind === "final-review") next.finalReview.status = "fix_pending";
		else next.e2e.status = "fix_pending";
	}
	finishAttentionResolution(next);
	return { state: next, accepted: true };
}

/** Resolve only the authoritative slot currently holding attention; resume is a separate explicit control. */
export function resolveWorkflowAttention(
	state: StoryRuntimeState,
	resolution: AttentionResolution,
	repairRounds: number,
): { state: StoryRuntimeState; accepted: boolean; reason?: FailureSummary } {
	if (!Number.isInteger(repairRounds) || repairRounds < 0) throw new Error("repairRounds must be a non-negative integer");
	if (state.status !== "attention" && state.status !== "paused") return { state, accepted: false, reason: { code: "not_attention", summary: "Workflow has no authoritative attention state" } };
	const next = structuredClone(state);
	if (next.attentionEpoch === undefined && hasWorkflowAttention(next)) next.attentionEpoch = 1;
	if (resolution.action === "request_changes" && resolution.correction) return applyRuntimeCorrection(state, next, resolution.correction, repairRounds);
	const target = authoritativeAttentionTarget(next);
	if (!target) return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "Workflow-level attention is not attached to a repairable runtime slot" } };
	const boundary = attentionBoundary(next, target);
	if (!boundary || boundary.slot.status !== "attention") return { state, accepted: false, reason: { code: "attention_not_resolved", summary: "The authoritative attention target is not an active runtime boundary" } };
	if (target.kind === "stage-review" || target.kind === "final-review") return resolveReviewAttention(state, next, boundary.slot as ReviewRuntimeState, resolution, repairRounds, boundary.stage);
	if (resolution.action !== "request_changes" || boundary.slot.repairCount >= repairRounds) {
		return { state, accepted: false, reason: { code: "attention_not_resolved", summary: `${target.kind} attention requires an available repair round` } };
	}
	(boundary.slot as { status: "repair_pending" | "fix_pending" }).status = target.kind === "e2e" ? "fix_pending" : "repair_pending";
	if (resolution.prompt?.trim()) boundary.slot.failure = { code: "user_change_request", summary: resolution.prompt.trim() };
	if (boundary.stage) boundary.stage.status = "running";
	finishAttentionResolution(next);
	return { state: next, accepted: true };
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
		finishAttentionResolution(next);
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
	finishAttentionResolution(next);
	return { state: next, accepted: true };
}
