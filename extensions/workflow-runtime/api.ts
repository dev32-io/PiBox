import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentProgress } from "../subagent/agent-progress.js";

export const WORKFLOW_CONTROL_EVENT = "pibox:workflow:control";
export const WORKFLOW_LIFECYCLE_EVENT = "pibox:workflow:lifecycle";

export interface WorkflowLifecycleEvent {
	type: "stage-completed" | "error";
	workflowRef: string;
	stepRef?: string;
	kind?: string;
	stageId?: string;
	stageIndex?: number;
	title: string;
	detail?: string;
	fromStatus?: string;
	toStatus?: string;
	cause?: string;
	attempt?: number;
	iteration?: number;
	nextAction?: string;
	/** Correlates workflow feedback with the turn that caused it when available. */
	correlationId?: string;
}

export type WorkflowStepStatus = "pending" | "ready" | "running" | "done" | "attention" | "cancelled";

export type WorkflowStepPhase = "implementing" | "contribution-ready" | "ready-to-integrate" | "assembling-candidate" | "integration-conflict" | "repairing-candidate" | "verifying-candidate" | "candidate-ci-failed" | "verification-failed" | "integrated";

export interface WorkflowStep {
	ref: string;
	title: string;
	kind: string;
	status: WorkflowStepStatus;
	phase?: WorkflowStepPhase;
	/** Harness checkpoint semantics used for truthful final-validation rendering. */
	checkpoint?: "stage-review" | "final-e2e" | "final-review";
	dependsOn: string[];
	parallelism: "allowed" | "serial";
	resourceClaims: string[];
	detail?: string;
	progress?: AgentProgress;
	/** Effective Fast mode for the active subagent process, omitted when inactive. */
	fast?: boolean;
}

export interface WorkflowStageSnapshot {
	id: string;
	index: number;
	nodes: string[];
	parallel: boolean;
	group?: "planner" | "runtime";
}

export type WorkflowMetricCategory = "implementation" | "integration" | "verification" | "review" | "e2e" | "orchestration";

export interface WorkflowMetricLiveProjection {
	/** Wall-clock instant represented by the durable metric totals. */
	sampledAtMs: number;
	/** Open intervals that can be advanced locally without another repository read. */
	elapsed: boolean;
	running: boolean;
	/** The one exclusive workflow phase currently consuming active wall time. */
	activeCategory?: WorkflowMetricCategory;
	activeAgents: number;
	activeVerifications: number;
	/** Open process intervals by displayed role; these are independent rates. */
	activeImplementers?: number;
	activeReviewers?: number;
	activeFixers?: number;
	activeE2e?: number;
	/** Attempts still between launch and first observable child readiness/activity. */
	activeScheduling?: number;
	/** True while active workflow wall time is not covered by a child or deterministic step. */
	orchestrator?: boolean;
}

export interface WorkflowMetrics {
	/** First-start span retained for detailed diagnostics; the widget uses runningMs. */
	elapsedMs: number;
	/** Active workflow wall time, excluding pause, detach/quit, stop, and completion. */
	runningMs: number;
	/** Summed agent-process work; may exceed wall time under concurrency. */
	agentActiveMs: number;
	/** Non-exclusive process-runtime sums used by the workflow widget. */
	implementerMs?: number;
	reviewerMs?: number;
	fixerMs?: number;
	e2eAgentMs?: number;
	/** Summed verification/check attempt runtime, not a wall-clock union. */
	deterministicMs?: number;
	/** Summed launch-to-ready/first-activity intervals across process attempts. */
	harnessSchedulingMs?: number;
	implementationMs?: number;
	integrationMs?: number;
	verificationMs: number;
	reviewMs?: number;
	e2eMs?: number;
	orchestrationMs?: number;
	fixes: number;
	retries: number;
	agentCount: number;
	verificationAttempts: number;
	inputTokens: number;
	outputTokens: number;
	toolErrors: number;
	/** Optional for third-party adapters; managed workflows always provide it. */
	live?: WorkflowMetricLiveProjection;
}

export interface WorkflowRepairLoopSnapshot {
	label: string;
	/** Settled rounds plus the currently authorized fixing round, when one is active. */
	iteration: number;
	maxIterations: number;
	evaluationRef: string;
}

export interface WorkflowSnapshot {
	ref: string;
	title: string;
	status: "ready" | "running" | "paused" | "attention" | "done";
	steps: WorkflowStep[];
	/** Stage-aware rendering metadata; absent on third-party/legacy adapters. */
	stages?: WorkflowStageSnapshot[];
	/** Durable detailed metrics; optional for third-party/legacy adapters. */
	metrics?: WorkflowMetrics;
	/** The independent repair budget at the current stage/E2E/final-review boundary. */
	repairLoop?: WorkflowRepairLoopSnapshot;
}

export interface WorkflowRunResult {
	ref: string;
	state: "completed" | "blocked" | "failed" | "cancelled";
	summary: string;
	agentId?: string;
	attention?: boolean;
}

export interface WorkflowStartProgress {
	phase: "Validating prerequisites" | "Finalizing reviewed plan" | "Validating working branch" | "Creating runtime verification gates" | "Activating tasks" | "Building execution snapshot" | "Starting workflow";
	elapsedMs: number;
}

export interface WorkflowPreflight {
	ok: boolean;
	detail?: string;
	missingCommands?: string[];
	missingEnvironment?: string[];
}

export interface WorkflowExecutionControl {
	workflowRef: string;
	mode: "running" | "paused" | "stopped" | "completed";
	generation: number;
	/** Destructive ownership boundary; unchanged by same-activation reload attach. */
	executionFence?: number;
	ownerSessionId?: string;
	ownerProcessInstanceId?: string;
	ownerActivationId?: string;
}

export interface WorkflowLifecycleUpdate {
	workflowRef: string;
	/** Optional adapter-owned semantic transition. Snapshot projections never synthesize lifecycle. */
	lifecycle?: WorkflowLifecycleEvent;
	title: string;
	detail?: string;
	attention: boolean;
	kind?: string;
	toStatus?: WorkflowStepStatus;
	cause?: string;
}

export interface WorkflowAdapter {
	id: string;
	canHandle(ref: string): boolean;
	/** Subscribe to adapter-owned semantic workflow transitions and projection wake-ups. */
	subscribeLifecycle?(ref: string, ctx: ExtensionContext, listener: (update?: WorkflowLifecycleUpdate) => void, signal?: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
	/** Durable workflow ownership boundary. Commands are idempotent by operationId. */
	controlExecution?(ref: string, command: "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach", operationId: string, ctx: ExtensionContext): Promise<WorkflowExecutionControl>;
	listExecutionControls?(ctx: ExtensionContext): Promise<WorkflowExecutionControl[]>;
	assertExecutionCurrent?(ref: string, generation: number, ctx: ExtensionContext): Promise<void>;
	/** Explicit supervisor reconciliation command; snapshots remain pure reads. */
	reconcileWorkflow?(ref: string, ctx: ExtensionContext): Promise<void>;
	/** Cheap, side-effect-free validation performed before any worker is launched. */
	preflightWorkflow?(ref: string, ctx: ExtensionContext): Promise<WorkflowPreflight>;
	prepareWorkflow?(ref: string, ctx: ExtensionContext, onUpdate?: (progress: WorkflowStartProgress) => void): Promise<void>;
	completionPrompt?(ref: string, ctx: ExtensionContext): Promise<string>;
	snapshot(ref: string, ctx: ExtensionContext): Promise<WorkflowSnapshot>;
	runStep(ref: string, ctx: ExtensionContext, signal?: AbortSignal, expectedExecution?: WorkflowExecutionControl): Promise<WorkflowRunResult>;
	/** Workflow-domain preparation/teardown; durable mode changes are owned by controlExecution. */
	controlWorkflow(ref: string, action: "pause" | "resume" | "stop", ctx: ExtensionContext): Promise<void>;
	controlCheckpoint?(ref: string, action: "approve" | "request_changes", options: { prompt?: string; acceptedRisks?: Array<{ findingId: string; rationale: string }> } | undefined, ctx: ExtensionContext): Promise<unknown>;
}

export interface WorkflowControlEvent { ref: string; action: "pause" | "resume" | "stop"; operationId?: string; }
