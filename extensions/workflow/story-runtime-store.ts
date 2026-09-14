import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile, readTextIfExists } from "./repository.js";
import type { RuntimeOwner } from "../subagent/api.js";
import type { E2eWorkspaceReportReference } from "../e2e-workspace/workspace.js";

export const WORKFLOW_METRIC_CATEGORIES = ["implementation", "integration", "verification", "review", "e2e", "repair"] as const;
export type WorkflowMetricCategory = (typeof WORKFLOW_METRIC_CATEGORIES)[number];

export interface WorkflowMetricBreakdown {
	workflowMs: number;
	categories: Record<WorkflowMetricCategory, number>;
	incompleteIntervals: number;
	incompleteCategories: WorkflowMetricCategory[];
}

export interface StoryWorkflowMetrics extends WorkflowMetricBreakdown {
	open?: { category: WorkflowMetricCategory; since: string; stageId?: string };
	/** Added lazily so current state remains compatible with runs created before stage timing existed. */
	stageBreakdown?: Record<string, WorkflowMetricBreakdown>;
}

export type ActivationOwner = RuntimeOwner;
export type { RuntimeOwner };

export interface ActiveSlotAttempt {
	token: string;
	owner: RuntimeOwner;
	activatedAt: string;
}

export interface CheckDiagnostic {
	checkId: string;
	command: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	outputTruncated: boolean;
}

export interface FailureSummary {
	code: string;
	summary: string;
	/** The concrete cause remains available when code is replaced by repair_exhausted. */
	causeCode?: string;
	diagnostic?: CheckDiagnostic;
}

export type RuntimeCorrectionTarget =
	| { kind: "task"; stageId: string; taskId: string }
	| { kind: "stage-verification"; stageId: string }
	| { kind: "integration"; stageId: string }
	| { kind: "stage-review"; stageId: string }
	| { kind: "final-review" }
	| { kind: "e2e" };

export type RuntimeGuidanceTarget = Exclude<RuntimeCorrectionTarget, { kind: "task" } | { kind: "stage-verification" }>;

export interface RuntimeTaskCorrection {
	description?: string;
	scope?: string;
	delivery?: string;
	checks?: import("./types.js").VerificationCheckSpec[];
}

export interface RuntimeTaskExecutionOverride {
	stageId: string;
	taskId: string;
	task: RuntimeTaskCorrection;
	prompt?: string;
}

export interface RuntimeExecutionOverrides {
	tasks: RuntimeTaskExecutionOverride[];
	stageVerifications: Array<{ stageId: string; checks: import("./types.js").VerificationCheckSpec[] }>;
	guidance: Array<{ target: RuntimeGuidanceTarget; prompt: string }>;
}

export interface RuntimeExecutionCorrection {
	sequence: number;
	attentionEpoch: number;
	appliedAt: string;
	target: RuntimeCorrectionTarget;
	prompt?: string;
	task?: RuntimeTaskCorrection;
	stageVerification?: { checks: import("./types.js").VerificationCheckSpec[] };
	priorFailure: FailureSummary;
	/** Failed-check evidence captured before effective check vectors are replaced. */
	priorChecks?: DurableCheckState[];
	priorChecksTruncated?: boolean;
	priorRepairCount?: number;
}

export type DurableCheckStatus = "pending" | "running" | "passed" | "failed";
export interface DurableCheckState {
	id: string;
	status: DurableCheckStatus;
	failure?: FailureSummary;
}

export interface TaskRuntimeState {
	id: string;
	status: "pending" | "implementing" | "check_pending" | "checking" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "implementing" | "checking" | "repairing";
	repairCount: number;
	checks: DurableCheckState[];
	contributionCommit?: string;
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface IntegrationRuntimeState {
	status: "pending" | "integrating" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "integrating" | "repairing";
	repairCount: number;
	contributionCommits: string[];
	integratedCommit?: string;
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface VerificationRuntimeState {
	status: "pending" | "checking" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "checking" | "repairing";
	repairCount: number;
	checks: DurableCheckState[];
	result?: FailureSummary;
	failure?: FailureSummary;
}

export type FindingSeverity = "critical" | "major" | "minor";
export interface StructuredFinding {
	id: string;
	severity: FindingSeverity;
	code: string;
	summary: string;
	path?: string;
	line?: number;
}

export interface AcceptedRisk {
	findingId: string;
	rationale: string;
	acceptedAt: string;
}

export interface ReviewRuntimeState {
	status: "pending" | "reviewing" | "fix_pending" | "fixing" | "interrupted" | "completed" | "skipped" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "reviewing" | "fixing";
	iteration: number;
	repairCount: number;
	currentFindings: StructuredFinding[];
	acceptedRisks?: AcceptedRisk[];
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface E2ERuntimeState {
	status: "pending" | "testing" | "fix_pending" | "fixing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "testing" | "fixing";
	repairCount: number;
	/** Cumulative immutable evidence history across accepted evaluator attempts. */
	evidenceRefs: string[];
	/** Findings produced by current accepted evaluator attempt; absence means unknown for legacy or failed attempts. */
	currentFindings?: StructuredFinding[];
	/** Validated evidence cited by current accepted evaluator attempt; absence means unknown. */
	currentEvidenceRefs?: string[];
	/** Exact canonical report produced by current accepted legacy tool-backed evaluator attempt. */
	currentReportRef?: string;
	/** Exact temporary workspace report produced by current accepted evaluator attempt. */
	workspaceReport?: E2eWorkspaceReportReference;
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface StageRuntimeState {
	id: string;
	status: "pending" | "running" | "completed" | "attention";
	tasks: TaskRuntimeState[];
	integration: IntegrationRuntimeState;
	verification: VerificationRuntimeState;
	review: ReviewRuntimeState;
}

/** Target domain state is local to the story store until scheduler integration. */
export interface StoryContractDigests {
	story: string;
	plan: string;
	tasks: Record<string, string>;
}

export interface PendingLedgerRecovery {
	action: string;
	attemptToken: string;
	sourceRole: string;
	reportPath: string;
	error: string;
	submission?: { summary: string; evidence?: string[] };
}

export interface StoryRuntimeState {
	schemaVersion: 1;
	storyId: string;
	status: "ready" | "running" | "paused" | "attention" | "completed" | "failed" | "stopped";
	activationOwner?: RuntimeOwner;
	attention?: FailureSummary;
	/** Monotonic attention boundary used to reject stale corrections. */
	attentionEpoch?: number;
	/** Exact runtime slot authoritative for the current attention epoch. Absent for workflow-level attention. */
	attentionTarget?: RuntimeCorrectionTarget;
	/** Accepted contributions whose optional attempt notes still need explicit settlement, keyed by attempt token. */
	ledgerRecoveries?: Record<string, PendingLedgerRecovery>;
	/** Monotonic correction sequence. */
	correctionSequence?: number;
	/** Cumulative effective runtime overrides over the immutable authored baseline. */
	executionOverrides?: RuntimeExecutionOverrides;
	/** Complete audit history for corrections recorded by this runtime version. */
	executionCorrections?: RuntimeExecutionCorrection[];
	contracts: StoryContractDigests;
	git: {
		canonicalBranch: string;
		baseCommit: string;
		integrationBranch?: string;
		integrationWorktree?: string;
	};
	stages: StageRuntimeState[];
	finalReview: ReviewRuntimeState;
	e2e: E2ERuntimeState;
	metrics: StoryWorkflowMetrics;
	outcomeStatus?: "pending" | "written" | "failed";
}

export function sameCorrectionTarget(left: RuntimeCorrectionTarget, right: RuntimeCorrectionTarget): boolean {
	return left.kind === right.kind
		&& (!("stageId" in left) || ("stageId" in right && left.stageId === right.stageId))
		&& (!("taskId" in left) || ("taskId" in right && left.taskId === right.taskId));
}

/** Resolve the persisted target, or deterministically migrate a legacy slot-attention state in memory. */
export function authoritativeAttentionTarget(state: StoryRuntimeState): RuntimeCorrectionTarget | undefined {
	if (state.attentionTarget) return structuredClone(state.attentionTarget);
	for (const stage of state.stages) {
		for (const task of stage.tasks) if (task.status === "attention") return { kind: "task", stageId: stage.id, taskId: task.id };
		if (stage.integration.status === "attention") return { kind: "integration", stageId: stage.id };
		if (stage.verification.status === "attention") return { kind: "stage-verification", stageId: stage.id };
		if (stage.review.status === "attention") return { kind: "stage-review", stageId: stage.id };
	}
	if (state.finalReview.status === "attention") return { kind: "final-review" };
	if (state.e2e.status === "attention") return { kind: "e2e" };
	return undefined;
}

function mergeExecutionCorrection(overrides: RuntimeExecutionOverrides, correction: RuntimeExecutionCorrection): void {
	const target = correction.target;
	if (target.kind === "task" && correction.task) {
		const index = overrides.tasks.findIndex((entry) => entry.stageId === target.stageId && entry.taskId === target.taskId);
		const prior = index >= 0 ? overrides.tasks[index]! : { stageId: target.stageId, taskId: target.taskId, task: {} };
		const merged: RuntimeTaskExecutionOverride = {
			...prior,
			task: { ...prior.task, ...structuredClone(correction.task) },
			...(correction.prompt !== undefined ? { prompt: correction.prompt } : {}),
		};
		if (index >= 0) overrides.tasks[index] = merged; else overrides.tasks.push(merged);
	} else if (target.kind === "stage-verification" && correction.stageVerification) {
		const index = overrides.stageVerifications.findIndex((entry) => entry.stageId === target.stageId);
		const merged = { stageId: target.stageId, checks: structuredClone(correction.stageVerification.checks) };
		if (index >= 0) overrides.stageVerifications[index] = merged; else overrides.stageVerifications.push(merged);
	} else if (correction.prompt && !correction.task && !correction.stageVerification) {
		const target = correction.target as RuntimeGuidanceTarget;
		const index = overrides.guidance.findIndex((entry) => sameCorrectionTarget(entry.target, target));
		const merged = { target: structuredClone(target), prompt: correction.prompt };
		if (index >= 0) overrides.guidance[index] = merged; else overrides.guidance.push(merged);
	}
}

/**
 * Project cumulative effective overrides for readers. New states materialize this
 * projection; legacy states are upgraded in memory from their correction history.
 */
export function effectiveExecutionOverrides(state: Pick<StoryRuntimeState, "executionOverrides" | "executionCorrections">): RuntimeExecutionOverrides {
	const overrides: RuntimeExecutionOverrides = state.executionOverrides
		? structuredClone(state.executionOverrides)
		: { tasks: [], stageVerifications: [], guidance: [] };
	for (const correction of state.executionCorrections ?? []) mergeExecutionCorrection(overrides, correction);
	return overrides;
}

export function hasWorkflowAttention(state: StoryRuntimeState): boolean {
	return state.status === "attention" || Boolean(state.attention) || Object.keys(state.ledgerRecoveries ?? {}).length > 0
		|| state.stages.some((stage) => stage.tasks.some((task) => task.status === "attention")
			|| stage.integration.status === "attention" || stage.verification.status === "attention" || stage.review.status === "attention")
		|| state.finalReview.status === "attention" || state.e2e.status === "attention";
}

export interface LedgerEntry {
	id: string;
	updatedAt: string;
	sourceRole: string;
	summary: string;
	evidence?: string[];
}

export interface StoryLedger {
	schemaVersion: 1;
	entries: LedgerEntry[];
}

export interface DebugRoute {
	provider: string;
	model: string;
	effort?: string;
}

export interface DebugUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** Deliberately has no generic data field: debug events cannot carry content bodies or state patches. */
export interface StoryDebugEvent {
	type: string;
	stageId?: string;
	taskId?: string;
	slotId?: string;
	attemptToken?: string;
	durationMs?: number;
	route?: DebugRoute;
	usage?: DebugUsage;
	resultCode?: string;
}

export interface StoredStoryDebugEvent extends StoryDebugEvent {
	at: string;
	storyId: string;
}

export interface DebugTailFilter {
	types?: readonly string[];
	stageId?: string;
	taskId?: string;
	resultCodes?: readonly string[];
}

export interface StoryRuntimeStoreOptions {
	maxDebugTailEntries?: number;
	maxDebugReadBytes?: number;
	now?: () => Date;
}

export interface StoryStateWriteResult {
	state: StoryRuntimeState;
	stateWritten: boolean;
	debugEventAppended: boolean;
}

const STORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_MAX_DEBUG_TAIL_ENTRIES = 50;
const ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES = 200;
const DEFAULT_MAX_DEBUG_READ_BYTES = 256 * 1024;

export function emptyWorkflowMetrics(): StoryWorkflowMetrics {
	return {
		workflowMs: 0,
		categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0, repair: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	};
}

function timestamp(value: string): number {
	const result = Date.parse(value);
	if (!Number.isFinite(result)) throw new Error(`Invalid workflow clock timestamp: ${value}`);
	return result;
}

function emptyMetricBreakdown(): WorkflowMetricBreakdown {
	return {
		workflowMs: 0,
		categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0, repair: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	};
}

/** Close the current exclusive interval at a durable transition and optionally open the next category. */
export function transitionWorkflowClock(metrics: StoryWorkflowMetrics, category: WorkflowMetricCategory | undefined, at: string, stageId?: string): StoryWorkflowMetrics {
	const next = structuredClone(metrics);
	const atMs = timestamp(at);
	if (next.open) {
		const elapsed = atMs - timestamp(next.open.since);
		if (elapsed < 0) throw new Error("Workflow clock cannot move backwards");
		next.workflowMs += elapsed;
		next.categories[next.open.category] += elapsed;
		if (next.open.stageId) {
			const stage = next.stageBreakdown?.[next.open.stageId] ?? emptyMetricBreakdown();
			stage.workflowMs += elapsed;
			stage.categories[next.open.category] += elapsed;
			next.stageBreakdown = { ...next.stageBreakdown, [next.open.stageId]: stage };
		}
	}
	if (category) {
		if (stageId && !next.stageBreakdown?.[stageId]) next.stageBreakdown = { ...next.stageBreakdown, [stageId]: emptyMetricBreakdown() };
		next.open = { category, since: at, ...(stageId ? { stageId } : {}) };
	} else delete next.open;
	return next;
}

/** Owner-loss recovery does not guess at the uncheckpointed interval. */
export function markWorkflowClockIncomplete(metrics: StoryWorkflowMetrics): StoryWorkflowMetrics {
	const next = structuredClone(metrics);
	if (next.open) {
		if (!next.incompleteCategories.includes(next.open.category)) next.incompleteCategories.push(next.open.category);
		if (next.open.stageId) {
			const stage = next.stageBreakdown?.[next.open.stageId] ?? emptyMetricBreakdown();
			if (!stage.incompleteCategories.includes(next.open.category)) stage.incompleteCategories.push(next.open.category);
			stage.incompleteIntervals += 1;
			next.stageBreakdown = { ...next.stageBreakdown, [next.open.stageId]: stage };
		}
		delete next.open;
		next.incompleteIntervals += 1;
	}
	return next;
}

export function createAttemptToken(): string {
	return randomUUID();
}

export function isCurrentAttempt(slot: { status: string; attempt?: ActiveSlotAttempt }, token: string, owner: RuntimeOwner): boolean {
	return slot.attempt?.token === token
		&& slot.attempt.owner.activationId === owner.activationId
		&& slot.attempt.owner.processInstanceId === owner.processInstanceId
		&& slot.attempt.owner.sessionId === owner.sessionId;
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const permitted = new Set(allowed);
	return Object.keys(value).every((key) => permitted.has(key));
}
function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function oneOf(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === "string" && allowed.includes(value);
}
function nonNegativeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function boundedArray(value: unknown, maximum: number): value is unknown[] {
	return Array.isArray(value) && value.length <= maximum;
}
function validDiagnostic(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["checkId", "command", "exitCode", "stdout", "stderr", "outputTruncated"])
		&& nonEmptyString(value.checkId) && nonEmptyString(value.command) && Number.isSafeInteger(value.exitCode)
		&& typeof value.stdout === "string" && !value.stdout.includes("\0")
		&& typeof value.stderr === "string" && !value.stderr.includes("\0")
		&& typeof value.outputTruncated === "boolean";
}
function validSummary(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["code", "summary", "causeCode", "diagnostic"])
		&& nonEmptyString(value.code) && nonEmptyString(value.summary)
		&& (value.causeCode === undefined || nonEmptyString(value.causeCode))
		&& (value.diagnostic === undefined || validDiagnostic(value.diagnostic));
}
function validOptionalSummary(value: unknown): boolean {
	return value === undefined || validSummary(value);
}
function validOwner(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["sessionId", "processInstanceId", "activationId"]) && nonEmptyString(value.sessionId) && nonEmptyString(value.processInstanceId) && nonEmptyString(value.activationId);
}
function validAttempt(value: unknown): boolean {
	return value === undefined || (record(value) && onlyKeys(value, ["token", "owner", "activatedAt"]) && nonEmptyString(value.token) && nonEmptyString(value.activatedAt)
		&& Number.isFinite(Date.parse(value.activatedAt as string)) && validOwner(value.owner));
}
function validCheck(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "status", "failure"]) && nonEmptyString(value.id) && oneOf(value.status, ["pending", "running", "passed", "failed"])
		&& validOptionalSummary(value.failure);
}
function validChecks(value: unknown): boolean {
	return Array.isArray(value) && value.every(validCheck);
}
function validFinding(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "severity", "code", "summary", "path", "line"]) && nonEmptyString(value.id) && oneOf(value.severity, ["critical", "major", "minor"])
		&& nonEmptyString(value.code) && nonEmptyString(value.summary) && (value.path === undefined || nonEmptyString(value.path))
		&& (value.line === undefined || (Number.isSafeInteger(value.line) && (value.line as number) >= 1));
}
function validCurrentEvidenceReference(value: unknown): value is string {
	if (!nonEmptyString(value) || value.includes("\\")) return false;
	const segments = value.split("/");
	return segments[0] === "evidence" && segments.length > 1 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
function validCurrentReportReference(value: unknown): value is string {
	return nonEmptyString(value) && /^evidence\/e2e-[A-Za-z0-9_-]+\/report\.json$/.test(value);
}
function validReview(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "iteration", "repairCount", "attempt", "interruptedFrom", "currentFindings", "acceptedRisks", "result", "failure"])
		&& oneOf(value.status, ["pending", "reviewing", "fix_pending", "fixing", "interrupted", "completed", "skipped", "attention"])
		&& nonNegativeInteger(value.iteration) && nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["reviewing", "fixing"]))
		&& Array.isArray(value.currentFindings) && value.currentFindings.every(validFinding)
		&& (value.acceptedRisks === undefined || (Array.isArray(value.acceptedRisks) && value.acceptedRisks.every((risk) => record(risk) && onlyKeys(risk, ["findingId", "rationale", "acceptedAt"])
			&& nonEmptyString(risk.findingId) && nonEmptyString(risk.rationale) && nonEmptyString(risk.acceptedAt) && Number.isFinite(Date.parse(risk.acceptedAt as string)))))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validTask(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "status", "repairCount", "attempt", "interruptedFrom", "checks", "contributionCommit", "result", "failure"]) && typeof value.id === "string" && STORY_ID.test(value.id)
		&& oneOf(value.status, ["pending", "implementing", "check_pending", "checking", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["implementing", "checking", "repairing"]))
		&& validChecks(value.checks) && (value.contributionCommit === undefined || nonEmptyString(value.contributionCommit))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validIntegration(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "contributionCommits", "integratedCommit", "result", "failure"])
		&& oneOf(value.status, ["pending", "integrating", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["integrating", "repairing"]))
		&& Array.isArray(value.contributionCommits) && value.contributionCommits.every((commit) => nonEmptyString(commit))
		&& (value.integratedCommit === undefined || nonEmptyString(value.integratedCommit))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validVerification(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "checks", "result", "failure"])
		&& oneOf(value.status, ["pending", "checking", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["checking", "repairing"]))
		&& validChecks(value.checks) && validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validWorkspaceReportReference(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["workspaceId", "sessionId", "runId", "reportPath", "reportSha256"])
		&& nonEmptyString(value.workspaceId) && nonEmptyString(value.sessionId) && nonEmptyString(value.runId)
		&& nonEmptyString(value.reportPath) && typeof value.reportSha256 === "string" && /^[a-f0-9]{64}$/.test(value.reportSha256);
}
function validE2E(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "evidenceRefs", "currentFindings", "currentEvidenceRefs", "currentReportRef", "workspaceReport", "result", "failure"])
		|| !oneOf(value.status, ["pending", "testing", "fix_pending", "fixing", "interrupted", "completed", "attention"])
		|| !nonNegativeInteger(value.repairCount) || !validAttempt(value.attempt)
		|| (value.interruptedFrom !== undefined && !oneOf(value.interruptedFrom, ["testing", "fixing"]))
		|| !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.every((reference) => nonEmptyString(reference))
		|| (value.currentFindings !== undefined && (!Array.isArray(value.currentFindings) || !value.currentFindings.every(validFinding)))
		|| (value.currentEvidenceRefs !== undefined && (!Array.isArray(value.currentEvidenceRefs) || !value.currentEvidenceRefs.every(validCurrentEvidenceReference)))
		|| (value.currentReportRef !== undefined && !validCurrentReportReference(value.currentReportRef))
		|| (value.workspaceReport !== undefined && !validWorkspaceReportReference(value.workspaceReport))
		|| !validOptionalSummary(value.result) || !validOptionalSummary(value.failure)) return false;
	if (value.currentFindings !== undefined && new Set(value.currentFindings.map((finding) => (finding as StructuredFinding).id)).size !== value.currentFindings.length) return false;
	const evidenceRefs = value.evidenceRefs as string[];
	if (value.currentReportRef !== undefined && !evidenceRefs.includes(value.currentReportRef as string)) return false;
	if (value.currentEvidenceRefs === undefined) return true;
	const currentEvidenceRefs = value.currentEvidenceRefs as string[];
	return new Set(currentEvidenceRefs).size === currentEvidenceRefs.length
		&& currentEvidenceRefs.every((reference) => evidenceRefs.includes(reference))
		&& (value.currentReportRef === undefined || currentEvidenceRefs.includes(value.currentReportRef as string));
}
function validMetricBreakdown(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["workflowMs", "categories", "incompleteIntervals", "incompleteCategories"])
		|| !nonNegativeInteger(value.workflowMs) || !nonNegativeInteger(value.incompleteIntervals)
		|| !boundedArray(value.incompleteCategories, WORKFLOW_METRIC_CATEGORIES.length)
		|| value.incompleteCategories.some((category) => !oneOf(category, WORKFLOW_METRIC_CATEGORIES))
		|| new Set(value.incompleteCategories).size !== value.incompleteCategories.length) return false;
	const categories = value.categories;
	if (!record(categories) || Object.keys(categories).length !== WORKFLOW_METRIC_CATEGORIES.length
		|| !Object.keys(categories).every((category) => (WORKFLOW_METRIC_CATEGORIES as readonly string[]).includes(category))
		|| !WORKFLOW_METRIC_CATEGORIES.every((category) => nonNegativeInteger(categories[category]))) return false;
	return WORKFLOW_METRIC_CATEGORIES.reduce((sum, category) => sum + (categories[category] as number), 0) === value.workflowMs;
}
function validMetrics(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["workflowMs", "categories", "open", "incompleteIntervals", "incompleteCategories", "stageBreakdown"])) return false;
	const { open, stageBreakdown, ...breakdown } = value;
	if (!validMetricBreakdown(breakdown)) return false;
	if (stageBreakdown !== undefined && (!record(stageBreakdown)
		|| Object.entries(stageBreakdown).some(([stageId, stage]) => !STORY_ID.test(stageId) || !validMetricBreakdown(stage)))) return false;
	return open === undefined || (record(open) && onlyKeys(open, ["category", "since", "stageId"]) && oneOf(open.category, WORKFLOW_METRIC_CATEGORIES)
		&& nonEmptyString(open.since) && Number.isFinite(Date.parse(open.since)) && (open.stageId === undefined || (typeof open.stageId === "string" && STORY_ID.test(open.stageId))));
}

const LEGACY_WORKFLOW_METRIC_CATEGORIES = WORKFLOW_METRIC_CATEGORIES.filter((category) => category !== "repair");

/** Add only missing Repair totals from five-category persisted states; never infer a historical split. */
function normalizeLegacyWorkflowMetrics(value: unknown): unknown {
	if (!record(value) || !record(value.categories)) return value;
	const next = structuredClone(value);
	const normalizeBreakdown = (breakdown: Record<string, unknown>): void => {
		if (!record(breakdown.categories)) return;
		const keys = Object.keys(breakdown.categories);
		if (keys.length === LEGACY_WORKFLOW_METRIC_CATEGORIES.length
			&& LEGACY_WORKFLOW_METRIC_CATEGORIES.every((category) => keys.includes(category))) {
			breakdown.categories.repair = 0;
		}
	};
	normalizeBreakdown(next);
	if (record(next.stageBreakdown)) {
		for (const stage of Object.values(next.stageBreakdown)) if (record(stage)) normalizeBreakdown(stage);
	}
	return next;
}
function validGit(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["canonicalBranch", "baseCommit", "integrationBranch", "integrationWorktree"])
		&& nonEmptyString(value.canonicalBranch) && nonEmptyString(value.baseCommit)
		&& (value.integrationBranch === undefined || nonEmptyString(value.integrationBranch))
		&& (value.integrationWorktree === undefined || nonEmptyString(value.integrationWorktree));
}
function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function validContracts(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["story", "plan", "tasks"]) || !validDigest(value.story) || !validDigest(value.plan) || !record(value.tasks)) return false;
	const entries = Object.entries(value.tasks);
	return entries.every(([id, digest]) => STORY_ID.test(id) && validDigest(digest));
}
function validCorrectionChecks(value: unknown): boolean {
	if (!Array.isArray(value)) return false;
	return value.every((check) => typeof check === "string"
		? nonEmptyString(check)
		: record(check) && onlyKeys(check, ["id", "command", "profile"])
			&& (check.id === undefined || (typeof check.id === "string" && STORY_ID.test(check.id)))
			&& nonEmptyString(check.command)
			&& (check.profile === undefined || (typeof check.profile === "string" && STORY_ID.test(check.profile))));
}
function validCorrectionTarget(value: unknown): boolean {
	if (!record(value)) return false;
	if (value.kind === "task") return onlyKeys(value, ["kind", "stageId", "taskId"])
		&& typeof value.stageId === "string" && STORY_ID.test(value.stageId) && typeof value.taskId === "string" && STORY_ID.test(value.taskId);
	if (["stage-verification", "integration", "stage-review"].includes(value.kind as string)) return onlyKeys(value, ["kind", "stageId"])
		&& typeof value.stageId === "string" && STORY_ID.test(value.stageId);
	return (value.kind === "final-review" || value.kind === "e2e") && onlyKeys(value, ["kind"]);
}
function validCorrection(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["sequence", "attentionEpoch", "appliedAt", "target", "prompt", "task", "stageVerification", "priorFailure", "priorChecks", "priorChecksTruncated", "priorRepairCount"])
		|| !nonNegativeInteger(value.sequence) || (value.sequence as number) < 1 || !nonNegativeInteger(value.attentionEpoch) || (value.attentionEpoch as number) < 1
		|| !nonEmptyString(value.appliedAt) || !Number.isFinite(Date.parse(value.appliedAt)) || !validCorrectionTarget(value.target)
		|| (value.prompt !== undefined && !nonEmptyString(value.prompt)) || !validSummary(value.priorFailure)
		|| (value.priorChecks !== undefined && (!Array.isArray(value.priorChecks) || !value.priorChecks.every(validCheck)))
		|| (value.priorChecksTruncated !== undefined && typeof value.priorChecksTruncated !== "boolean")
		|| (value.priorRepairCount !== undefined && !nonNegativeInteger(value.priorRepairCount))) return false;
	if (value.task !== undefined && (!record(value.task) || !onlyKeys(value.task, ["description", "scope", "delivery", "checks"])
		|| ![value.task.description, value.task.scope, value.task.delivery].every((field) => field === undefined || nonEmptyString(field))
		|| (value.task.checks !== undefined && !validCorrectionChecks(value.task.checks)))) return false;
	if (value.stageVerification !== undefined && (!record(value.stageVerification) || !onlyKeys(value.stageVerification, ["checks"]) || !validCorrectionChecks(value.stageVerification.checks))) return false;
	const target = value.target as RuntimeCorrectionTarget;
	if (target.kind === "task") return value.stageVerification === undefined && value.task !== undefined;
	if (target.kind === "stage-verification") return value.task === undefined && value.stageVerification !== undefined;
	return value.task === undefined && value.stageVerification === undefined && nonEmptyString(value.prompt);
}
function validExecutionOverrides(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["tasks", "stageVerifications", "guidance"])
		|| !Array.isArray(value.tasks) || !Array.isArray(value.stageVerifications) || !Array.isArray(value.guidance)) return false;
	const tasksValid = value.tasks.every((entry) => record(entry) && onlyKeys(entry, ["stageId", "taskId", "task", "prompt"])
		&& typeof entry.stageId === "string" && STORY_ID.test(entry.stageId) && typeof entry.taskId === "string" && STORY_ID.test(entry.taskId)
		&& record(entry.task) && onlyKeys(entry.task, ["description", "scope", "delivery", "checks"])
		&& [entry.task.description, entry.task.scope, entry.task.delivery].every((field) => field === undefined || nonEmptyString(field))
		&& (entry.task.checks === undefined || validCorrectionChecks(entry.task.checks))
		&& (entry.prompt === undefined || nonEmptyString(entry.prompt)));
	const stagesValid = value.stageVerifications.every((entry) => record(entry) && onlyKeys(entry, ["stageId", "checks"])
		&& typeof entry.stageId === "string" && STORY_ID.test(entry.stageId) && validCorrectionChecks(entry.checks));
	const guidanceValid = value.guidance.every((entry) => record(entry) && onlyKeys(entry, ["target", "prompt"])
		&& validCorrectionTarget(entry.target) && !["task", "stage-verification"].includes((entry.target as Record<string, unknown>).kind as string)
		&& nonEmptyString(entry.prompt));
	if (!tasksValid || !stagesValid || !guidanceValid) return false;
	return new Set(value.tasks.map((entry) => `${(entry as RuntimeTaskExecutionOverride).stageId}\0${(entry as RuntimeTaskExecutionOverride).taskId}`)).size === value.tasks.length
		&& new Set(value.stageVerifications.map((entry) => (entry as { stageId: string }).stageId)).size === value.stageVerifications.length
		&& new Set(value.guidance.map((entry) => JSON.stringify((entry as { target: RuntimeGuidanceTarget }).target))).size === value.guidance.length;
}
function validCorrectionReferences(state: Record<string, unknown>): boolean {
	const corrections = state.executionCorrections as RuntimeExecutionCorrection[] | undefined;
	const overrides = state.executionOverrides as RuntimeExecutionOverrides | undefined;
	if (!corrections?.length && !overrides) return true;
	if (!nonNegativeInteger(state.attentionEpoch)) return false;
	const stages = state.stages as Array<Record<string, unknown>>;
	const validTargetReference = (target: RuntimeCorrectionTarget): boolean => {
		if (target.kind === "final-review" || target.kind === "e2e") return true;
		const stage = stages.find((candidate) => candidate.id === target.stageId);
		if (!stage) return false;
		return target.kind !== "task" || (stage.tasks as Array<Record<string, unknown>>).some((task) => task.id === target.taskId);
	};
	return (corrections ?? []).every((correction) => correction.attentionEpoch <= (state.attentionEpoch as number) && validTargetReference(correction.target))
		&& (overrides?.tasks ?? []).every((entry) => validTargetReference({ kind: "task", stageId: entry.stageId, taskId: entry.taskId }))
		&& (overrides?.stageVerifications ?? []).every((entry) => validTargetReference({ kind: "stage-verification", stageId: entry.stageId }))
		&& (overrides?.guidance ?? []).every((entry) => validTargetReference(entry.target));
}
function validLedgerRecovery(value: unknown): value is PendingLedgerRecovery {
	return record(value) && onlyKeys(value, ["action", "attemptToken", "sourceRole", "reportPath", "error", "submission"])
		&& nonEmptyString(value.action) && nonEmptyString(value.attemptToken) && nonEmptyString(value.sourceRole)
		&& nonEmptyString(value.reportPath) && nonEmptyString(value.error)
		&& (value.submission === undefined || (record(value.submission) && onlyKeys(value.submission, ["summary", "evidence"])
			&& nonEmptyString(value.submission.summary)
			&& (value.submission.evidence === undefined || (Array.isArray(value.submission.evidence) && value.submission.evidence.every(nonEmptyString)))));
}
function validLedgerRecoveries(value: unknown): boolean {
	return record(value) && Object.entries(value).every(([token, recovery]) => nonEmptyString(token) && validLedgerRecovery(recovery) && recovery.attemptToken === token);
}
function validAttentionReference(state: Record<string, unknown>): boolean {
	const target = state.attentionTarget as RuntimeCorrectionTarget | undefined;
	if (!target) return true;
	const runtime = state as unknown as StoryRuntimeState;
	if (target.kind === "final-review") return runtime.finalReview.status === "attention";
	if (target.kind === "e2e") return runtime.e2e.status === "attention";
	const stage = runtime.stages.find((candidate) => candidate.id === target.stageId);
	if (!stage) return false;
	if (target.kind === "task") return stage.tasks.some((task) => task.id === target.taskId && task.status === "attention");
	if (target.kind === "integration") return stage.integration.status === "attention";
	if (target.kind === "stage-verification") return stage.verification.status === "attention";
	return stage.review.status === "attention";
}
function validMetricStageReferences(state: Record<string, unknown>): boolean {
	const stageIds = new Set((state.stages as Array<Record<string, unknown>>).map((stage) => stage.id as string));
	const metrics = state.metrics as Record<string, unknown>;
	const open = metrics.open as Record<string, unknown> | undefined;
	const stageBreakdown = metrics.stageBreakdown as Record<string, WorkflowMetricBreakdown> | undefined;
	if (open?.stageId !== undefined && (!stageIds.has(open.stageId as string) || !stageBreakdown?.[open.stageId as string])) return false;
	if (stageBreakdown === undefined) return true;
	if (!Object.keys(stageBreakdown).every((stageId) => stageIds.has(stageId))) return false;
	const globalCategories = metrics.categories as Record<WorkflowMetricCategory, number>;
	for (const category of WORKFLOW_METRIC_CATEGORIES) {
		const attributed = Object.values(stageBreakdown).reduce((sum, stage) => sum + stage.categories[category], 0);
		if (attributed > globalCategories[category]) return false;
	}
	const globalIncompleteIntervals = metrics.incompleteIntervals as number;
	if (Object.values(stageBreakdown).reduce((sum, stage) => sum + stage.incompleteIntervals, 0) > globalIncompleteIntervals) return false;
	const globalIncompleteCategories = new Set(metrics.incompleteCategories as WorkflowMetricCategory[]);
	return Object.values(stageBreakdown).every((stage) => stage.incompleteCategories.every((category) => globalIncompleteCategories.has(category)));
}
function validStateShape(state: Record<string, unknown>): boolean {
	const recent = state.executionCorrections as RuntimeExecutionCorrection[] | undefined;
	const total = state.correctionSequence as number | undefined;
	const sequenceValid = recent === undefined || (Array.isArray(recent) && recent.every(validCorrection)
		&& (total === undefined
			? recent.every((entry, index) => entry.sequence === index + 1)
			: recent.every((entry, index) => entry.sequence === total - recent.length + index + 1)));
	return onlyKeys(state, ["schemaVersion", "storyId", "status", "activationOwner", "attention", "attentionEpoch", "attentionTarget", "ledgerRecoveries", "correctionSequence", "executionOverrides", "executionCorrections", "contracts", "git", "stages", "finalReview", "e2e", "metrics", "outcomeStatus"])
		&& oneOf(state.status, ["ready", "running", "paused", "attention", "completed", "failed", "stopped"])
		&& (state.activationOwner === undefined || validOwner(state.activationOwner)) && validOptionalSummary(state.attention)
		&& (state.attentionEpoch === undefined || (nonNegativeInteger(state.attentionEpoch) && (state.attentionEpoch as number) >= 1))
		&& (state.attentionTarget === undefined || validCorrectionTarget(state.attentionTarget))
		&& (state.ledgerRecoveries === undefined || validLedgerRecoveries(state.ledgerRecoveries))
		&& (total === undefined || (nonNegativeInteger(total) && total >= 1 && total >= (recent?.length ?? 0)))
		&& ((state.executionOverrides === undefined) === (total === undefined))
		&& (state.executionOverrides === undefined || validExecutionOverrides(state.executionOverrides))
		&& sequenceValid
		&& validContracts(state.contracts) && validGit(state.git) && validMetrics(state.metrics) && Array.isArray(state.stages)
		&& state.stages.every((stage) => record(stage) && onlyKeys(stage, ["id", "status", "tasks", "integration", "verification", "review"])
			&& typeof stage.id === "string" && STORY_ID.test(stage.id) && oneOf(stage.status, ["pending", "running", "completed", "attention"])
			&& Array.isArray(stage.tasks) && stage.tasks.every(validTask) && validIntegration(stage.integration)
			&& validVerification(stage.verification) && validReview(stage.review))
		&& validReview(state.finalReview) && validE2E(state.e2e)
		&& (state.outcomeStatus === undefined || oneOf(state.outcomeStatus, ["pending", "written", "failed"]))
		&& validAttentionReference(state) && validCorrectionReferences(state) && validMetricStageReferences(state);
}
export function parseStoryRuntimeState(value: unknown, storyId: string): StoryRuntimeState {
	const normalized = record(value) ? { ...value, metrics: normalizeLegacyWorkflowMetrics(value.metrics) } : value;
	if (!record(normalized) || normalized.schemaVersion !== 1 || normalized.storyId !== storyId || !validStateShape(normalized)) {
		throw new Error(`Unsupported or invalid runtime state for ${storyId}`);
	}
	const state = normalized as unknown as StoryRuntimeState;
	if (!state.attentionTarget) {
		const migrated = authoritativeAttentionTarget(state);
		if (migrated) state.attentionTarget = migrated;
	}
	return state;
}

const validateState = parseStoryRuntimeState;

function validateLedgerEntry(entry: LedgerEntry): void {
	if (!record(entry) || !onlyKeys(entry as unknown as Record<string, unknown>, ["id", "summary", "sourceRole", "updatedAt", "evidence"])) throw new Error("Ledger entries contain unsupported fields");
	if (!nonEmptyString(entry.id) || !entry.id.trim() || !nonEmptyString(entry.summary) || !entry.summary.trim()) throw new Error("Ledger entries require a non-empty id and summary");
	if (!nonEmptyString(entry.sourceRole) || !entry.sourceRole.trim() || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error("Ledger entries require a role and timestamp");
	if (entry.evidence !== undefined && (!Array.isArray(entry.evidence) || entry.evidence.some((reference) => !nonEmptyString(reference)))) throw new Error("Ledger evidence references must be non-empty strings");
}

function validateLedger(value: unknown, storyId: string): StoryLedger {
	if (!value || typeof value !== "object") throw new Error(`Invalid workflow ledger for ${storyId}`);
	const ledger = value as Partial<StoryLedger>;
	if (!onlyKeys(value as Record<string, unknown>, ["schemaVersion", "entries"]) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) throw new Error(`Invalid workflow ledger for ${storyId}`);
	for (const entry of ledger.entries) validateLedgerEntry(entry);
	return ledger as StoryLedger;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new Error("Store bounds must be positive integers");
	return maximum === undefined ? value : Math.min(value, maximum);
}

export class StoryRuntimeStore {
	readonly storyRoot: string;
	readonly statePath: string;
	readonly ledgerPath: string;
	readonly eventsPath: string;
	readonly #storyId: string;
	readonly #maxDebugTailEntries: number;
	readonly #maxDebugReadBytes: number;
	readonly #now: () => Date;
	#tail: Promise<void> = Promise.resolve();

	constructor(repositoryRoot: string, storyId: string, options: StoryRuntimeStoreOptions = {}) {
		if (!STORY_ID.test(storyId)) throw new Error("Invalid story identity");
		this.#storyId = storyId;
		this.storyRoot = join(repositoryRoot, "agent-artifacts", storyId);
		this.statePath = join(this.storyRoot, "state.yaml");
		this.ledgerPath = join(this.storyRoot, "ledger.yaml");
		this.eventsPath = join(this.storyRoot, "events.jsonl");
		this.#maxDebugTailEntries = boundedPositiveInteger(options.maxDebugTailEntries, DEFAULT_MAX_DEBUG_TAIL_ENTRIES, ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES);
		this.#maxDebugReadBytes = boundedPositiveInteger(options.maxDebugReadBytes, DEFAULT_MAX_DEBUG_READ_BYTES);
		this.#now = options.now ?? (() => new Date());
	}

	async readState(): Promise<StoryRuntimeState | undefined> {
		await this.#tail;
		return this.#readStateUnlocked();
	}

	async writeState(state: StoryRuntimeState, event?: StoryDebugEvent): Promise<StoryStateWriteResult> {
		return this.#serialize(() => this.#commitStateUnlocked(state, event));
	}

	async updateState(update: (current: StoryRuntimeState | undefined) => StoryRuntimeState, event?: StoryDebugEvent | ((state: StoryRuntimeState) => StoryDebugEvent | undefined)): Promise<StoryStateWriteResult> {
		return this.#serialize(async () => {
			const current = await this.#readStateUnlocked();
			const state = update(current);
			if (current && state === current) return { state, stateWritten: false, debugEventAppended: false };
			return this.#commitStateUnlocked(state, typeof event === "function" ? event(state) : event);
		});
	}

	async readLedger(): Promise<StoryLedger> {
		await this.#tail;
		return this.#readLedgerUnlocked();
	}

	async upsertLedger(entry: LedgerEntry): Promise<StoryLedger> {
		return this.#serialize(async () => {
			validateLedgerEntry(entry);
			const current = await this.#readLedgerUnlocked();
			const entries = current.entries.filter((candidate) => candidate.id !== entry.id);
			entries.push(structuredClone(entry));
			const ledger: StoryLedger = { schemaVersion: 1, entries };
			await atomicWriteFile(this.ledgerPath, stringify(ledger), 0o600);
			return ledger;
		});
	}

	async pruneLedger(ids: readonly string[]): Promise<StoryLedger> {
		return this.#serialize(async () => {
			const removed = new Set(ids);
			const current = await this.#readLedgerUnlocked();
			const ledger: StoryLedger = { schemaVersion: 1, entries: current.entries.filter((entry) => !removed.has(entry.id)) };
			await atomicWriteFile(this.ledgerPath, stringify(ledger), 0o600);
			return ledger;
		});
	}

	async appendDebug(event: StoryDebugEvent): Promise<boolean> {
		return this.#serialize(() => this.#appendDebugBestEffort(event));
	}

	async readDebugTail(limit = this.#maxDebugTailEntries, filter: DebugTailFilter = {}): Promise<StoredStoryDebugEvent[]> {
		await this.#tail;
		const boundedLimit = Math.min(boundedPositiveInteger(limit, this.#maxDebugTailEntries), this.#maxDebugTailEntries, ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES);
		const fileStat = await stat(this.eventsPath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!fileStat) return [];
		const offset = Math.max(0, fileStat.size - this.#maxDebugReadBytes);
		const handle = await open(this.eventsPath, "r");
		let content: string;
		try {
			const buffer = Buffer.alloc(fileStat.size - offset);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			content = buffer.subarray(0, bytesRead).toString("utf8");
		} finally { await handle.close(); }
		const lines = content.split("\n");
		if (offset > 0) lines.shift(); // the bounded read may begin in the middle of an event
		const types = filter.types && new Set(filter.types);
		const resultCodes = filter.resultCodes && new Set(filter.resultCodes);
		const events: StoredStoryDebugEvent[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: StoredStoryDebugEvent;
			try { event = JSON.parse(line) as StoredStoryDebugEvent; }
			catch { continue; } // a crash may leave a malformed trailing debug line
			if (event.storyId !== this.#storyId || typeof event.type !== "string" || typeof event.at !== "string") continue;
			if (types && !types.has(event.type)) continue;
			if (filter.stageId !== undefined && event.stageId !== filter.stageId) continue;
			if (filter.taskId !== undefined && event.taskId !== filter.taskId) continue;
			if (resultCodes && (!event.resultCode || !resultCodes.has(event.resultCode))) continue;
			events.push(event);
		}
		return events.slice(-boundedLimit);
	}

	async #readStateUnlocked(): Promise<StoryRuntimeState | undefined> {
		const content = await readTextIfExists(this.statePath);
		return content === undefined ? undefined : validateState(parse(content), this.#storyId);
	}

	async #readLedgerUnlocked(): Promise<StoryLedger> {
		const content = await readTextIfExists(this.ledgerPath);
		return content === undefined ? { schemaVersion: 1, entries: [] } : validateLedger(parse(content), this.#storyId);
	}

	async #commitStateUnlocked(state: StoryRuntimeState, event?: StoryDebugEvent): Promise<StoryStateWriteResult> {
		validateState(state, this.#storyId);
		await atomicWriteFile(this.statePath, stringify(state), 0o600);
		const debugEventAppended = event ? await this.#appendDebugBestEffort(event) : false;
		return { state, stateWritten: true, debugEventAppended };
	}

	async #appendDebugBestEffort(event: StoryDebugEvent): Promise<boolean> {
		try {
			const compact = (value: string, label: string, maximum: number, pattern: RegExp): string => {
				if (value.length > maximum || !pattern.test(value)) throw new Error(`Invalid debug ${label}`);
				return value;
			};
			const identifier = (value: string, label: string) => compact(value, label, 200, /^[^\r\n\0]+$/);
			const token = (value: string, label: string) => compact(value, label, 80, /^[a-z0-9][a-z0-9._-]*$/i);
			const numeric = (value: number, label: string): number => {
				if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid debug ${label}`);
				return value;
			};
			const usage = event.usage && {
				...(event.usage.inputTokens === undefined ? {} : { inputTokens: numeric(event.usage.inputTokens, "input usage") }),
				...(event.usage.outputTokens === undefined ? {} : { outputTokens: numeric(event.usage.outputTokens, "output usage") }),
				...(event.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: numeric(event.usage.cacheReadTokens, "cache-read usage") }),
				...(event.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: numeric(event.usage.cacheWriteTokens, "cache-write usage") }),
			};
			const route = event.route && {
				provider: compact(event.route.provider, "provider", 128, /^[a-z0-9][a-z0-9._/-]*$/i),
				model: compact(event.route.model, "model", 128, /^[a-z0-9][a-z0-9._/#:-]*$/i),
				...(event.route.effort === undefined ? {} : { effort: token(event.route.effort, "effort") }),
			};
			const stored: StoredStoryDebugEvent = {
				at: this.#now().toISOString(),
				storyId: this.#storyId,
				type: compact(event.type, "type", 80, /^[a-z0-9][a-z0-9._-]*$/),
				...(event.stageId === undefined ? {} : { stageId: identifier(event.stageId, "stage id") }),
				...(event.taskId === undefined ? {} : { taskId: identifier(event.taskId, "task id") }),
				...(event.slotId === undefined ? {} : { slotId: identifier(event.slotId, "slot id") }),
				...(event.attemptToken === undefined ? {} : { attemptToken: identifier(event.attemptToken, "attempt token") }),
				...(event.durationMs === undefined ? {} : { durationMs: numeric(event.durationMs, "duration") }),
				...(route === undefined ? {} : { route }),
				...(usage === undefined ? {} : { usage }),
				...(event.resultCode === undefined ? {} : { resultCode: token(event.resultCode, "result code") }),
			};
			await mkdir(this.storyRoot, { recursive: true, mode: 0o700 });
			const handle = await open(this.eventsPath, "a+", 0o600);
			try {
				const size = (await handle.stat()).size;
				let prefix = "";
				if (size > 0) {
					const finalByte = Buffer.alloc(1);
					await handle.read(finalByte, 0, 1, size - 1);
					if (finalByte[0] !== 0x0a) prefix = "\n";
				}
				await handle.writeFile(`${prefix}${JSON.stringify(stored)}\n`, "utf8");
				await handle.sync();
			} finally { await handle.close(); }
			return true;
		} catch { return false; }
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(() => undefined, () => undefined);
		return result;
	}
}
