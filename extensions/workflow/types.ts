import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type WorkItemKind = "change" | "story";
export type WorkingBranchKind = "feature" | "fix";

export interface WorkItemDelivery {
	/** The sole user-facing branch identity for this work item. */
	workingBranch: string;
	/** Immutable harness-owned anchor captured before the working branch is created. */
	createdFromCommit: string;
	/** Immutable harness-owned anchor captured when execution first starts. */
	executionStartCommit?: string;
}
export type WorkItemPhase = "planning" | "execution" | "evaluation" | "complete";
export type WorkItemState = "active" | "waiting_user" | "paused" | "postponed" | "blocked" | "failed" | "complete" | "archived";
export type ExecutionDisposition = "continue" | "resume-requesting-agent" | "pause-affected";

/** Mutation rationale and provenance retained for audit; this is not an execution gate. */
export interface MutationAuthority {
	rationale: string;
	sources?: string[];
}
export type Complexity = "low" | "medium" | "high" | "critical";
export type HarnessEffort = ModelThinkingLevel;
export type CapabilityTier = "low" | "medium" | "high" | "max";

/** One concrete `provider/model#effort` route inside an ordered capability tier. */
export type TierModelRouteConfig = string;

export interface AgentConfig {
	extends?: string;
	description?: string;
	prompt?: string;
	skills?: string[];
	tools?: string[];
	model?: string;
	workspace?: "repository" | "worktree" | "none";
	canDelegate?: boolean;
	completionSchema?: string;
	tier?: CapabilityTier;
}

export interface HarnessConfig {
	schemaVersion: 2;
	modelTiers: Record<CapabilityTier, TierModelRouteConfig[]>;
	agents: Record<string, AgentConfig>;
	orchestrator: {
		modelSwitching: "off" | "suggest" | "auto-visible";
	};
	limits: {
		/** Legacy process-concurrency preference retained for schema-v1 policy compatibility. */
		maxConcurrency: number;
		maxActiveSubagentsPerSession: number;
		maxSubagentDepth: number;
		protocolNudges: number;
		repairRounds: number;
	};
}

export interface ConfigDiagnostic {
	level: "warning" | "error";
	source: string;
	path?: string;
	message: string;
}

export interface LoadedHarnessConfig {
	config: HarnessConfig;
	digest: string;
	sources: string[];
	diagnostics: ConfigDiagnostic[];
}

export interface ArtifactIndexEntry {
	id: string;
	type: "intent" | "spec" | "design" | "decision" | "e2e-matrix" | "outcome";
	path: string;
	status: string;
	tags?: string[];
	links?: string[];
	narrativeSchemaVersion?: 1 | 2;
}

export type TaskStatus =
	| "draft"
	| "blocked"
	| "ready"
	| "running"
	| "paused"
	| "contribution_complete"
	| "reviewing"
	| "changes_requested"
	| "accepted"
	| "merge_queued"
	| "merging"
	| "merged"
	| "staged"
	| "integrating"
	| "integrated"
	| "failed"
	| "protocol_failed"
	| "cancelled";

export interface TaskManifest {
	schemaVersion: 1;
	id: string;
	title: string;
	status: TaskStatus;
	dependsOn: string[];
	/** Legacy artifact-driven context selection. New task contracts are self-contained and omit this field. */
	references?: {
		specs: string[];
		designs: string[];
		decisions: string[];
	};
	execution: {
		/** Legacy planner-selected mechanics; accepted for reading but ignored for new execution. */
		isolation?: "worktree" | "repository";
		parallelism?: "allowed" | "serial";
		resourceClaims: string[];
		/** Legacy schema-v1 planning field. New task plans express capability through assignment.tier. */
		complexity?: Complexity;
		assignment:
			| {
				agent: string;
				tier: CapabilityTier;
				rationale: string;
				/** Required by planning policy for high/max routing; optional for compatibility. */
				tierJustification?: string;
			}
			| {
				/** Legacy assignment retained only so existing plans remain readable and replannable. */
				role: string;
				tier: CapabilityTier;
				deliberation?: "standard" | "deep";
				modelOverride?: { model: string; effort?: HarnessEffort; strict?: boolean };
				rationale: string;
			}
			| {
				/** Legacy model assignment retained only so existing plans remain readable and replannable. */
				role: string;
				model: string;
				effort: HarnessEffort;
				minimumCapabilityRank: number;
				allowFallback: boolean;
				rationale: string;
			};
	};
	assembly: {
		stageId?: string;
		/** Legacy schema-v1 name; interpreted as the execution stage when stageId is absent. */
		integrationUnit?: string;
		intermediateState: "complete" | "partial";
	};
	verification: {
		timing: "task" | "integration-unit" | "work-item" | "skipped";
		methods: string[];
		taskChecks: string[];
		rationale: string;
	};
	runtime?: {
		/** Persisted once execution starts so recovery preserves the original allocation. */
		executionMode?: "repository" | "worktree";
		branch?: string;
		worktree?: string;
		baseCommit?: string;
		completedCommit?: string;
		mergedCommit?: string;
		/** Set by harness when a stage merge is left conflicted for managed repair. */
		integrationConflict?: { stageId: string; taskIds: string[]; evidencePath: string; recordedAt: string };
		lastRunId?: string;
	};
}

export function isTierTaskAssignment(
	assignment: TaskManifest["execution"]["assignment"],
): assignment is Extract<TaskManifest["execution"]["assignment"], { tier: CapabilityTier }> {
	return "tier" in assignment;
}

export function taskAgentName(task: TaskManifest): string {
	const assignment = task.execution.assignment;
	return "agent" in assignment ? assignment.agent : assignment.role;
}

export interface EvaluationFinding {
	id: string;
	/** Human review language is normalized at persistence boundaries: low/medium/high remain legacy-compatible with Minor/Major, critical is Critical. */
	severity: "low" | "medium" | "high" | "critical";
	status: "open" | "accepted" | "rejected" | "duplicate" | "deferred" | "resolved" | "needs_user";
	criterion?: string;
	location?: string;
	summary: string;
	blocking: boolean;
}

export type ReviewLoopState = "planned" | "reviewing" | "awaiting_manager" | "fixing" | "rereviewing" | "passed" | "skipped";

export interface StageReviewPolicy {
	/** Medium is the default. High is reserved for a substantively focused risk boundary. */
	tier: "medium" | "high";
	focus?: string[];
	rationale?: string;
}

export interface ExecutionStageContract {
	id: string;
	tasks: string[];
	/** Explicit execution topology; omitted stages retain legacy resolution behavior. */
	mode?: "sequential" | "concurrent";
	checks?: string[];
	review?: StageReviewPolicy;
}

export interface EvaluationManifest {
	schemaVersion: 1;
	id: string;
	type: "deterministic" | "spec-review" | "quality-review" | "combined-review" | "regression" | "e2e";
	/** Runtime stage association or final work-item scope. */
	stageId?: string;
	dependsOn?: string[];
	scope: { task?: string; integrationUnit?: string; workItem?: string };
	/** Every checkpoint is harness-owned. */
	checkpoint?: "stage-review" | "final-e2e" | "final-review";
	status: "planned" | "running" | "passed" | "failed" | "blocked" | "not_applicable";
	required: boolean;
	attempt: number;
	methods: string[];
	criteria?: string[];
	findings?: EvaluationFinding[];
	result?: { verdict: "pass" | "fail" | "blocked" | "not_applicable"; report: string; evidence?: string; riskAcceptance?: string };
	/** Durable state for one visible review/fix loop and stable reviewer/fixer identities. */
	loop?: {
		state: ReviewLoopState;
		iteration: number;
		maxIterations: number;
		reviewerAgentId?: string;
		fixerAgentId?: string;
		reviewedCommit?: string;
		managerPrompt?: string;
		acceptedRisks?: Array<{ findingId: string; rationale: string; userConfirmed?: boolean }>;
	};
}

export interface WorkItemIndex {
	schemaVersion: 1;
	id: string;
	kind: WorkItemKind;
	title: string;
	phase: WorkItemPhase;
	state: WorkItemState;
	planning: {
		revision: number;
	};
	artifacts: ArtifactIndexEntry[];
	tasks: Array<{ id: string; path: string }>;
	/** Ordered workflow stages. Tasks within one stage form a deliberate concurrency batch and merge in listed order. */
	executionStages?: Array<ExecutionStageContract>;
	/** Legacy schema-v1 grouping, migrated to executionStages when the latter is absent. */
	integrationUnits: Array<{ id: string; tasks: string[]; intermediatePolicy: "coherent" | "partial-allowed" }>;
	delivery?: WorkItemDelivery;
	evaluations: Array<{ id: string; path: string }>;
	finalization?: { locked: boolean; reason: string; lockedAt: string };
}

export interface HarnessStatusSnapshot {
	repositoryRoot: string;
	repositoryId: string;
	workItems: WorkItemIndex[];
	taskCounts: Record<string, Record<string, number>>;
	runs: Array<{ id: string; workItemId: string; taskId?: string; role: string; state: string; model?: string }>;
	agents: Array<{ id: string; role: string; state: string; model: string; processActive: boolean; runId?: string; taskId?: string; evaluationId?: string }>;
}
