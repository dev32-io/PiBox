import type {
	CapabilityTier,
	HarnessEffort,
	ModelTier,
	ModelTierListProfilesConfig,
} from "../model-tier-list-profiles/profiles.js";

export type { CapabilityTier, HarnessEffort, ModelTier, TierModelRouteConfig } from "../model-tier-list-profiles/profiles.js";

export type WorkItemKind = "change" | "story";
export type WorkingBranchKind = "feature" | "fix";

export interface WorkItemDelivery {
	/** The sole user-facing branch identity for this work item. */
	workingBranch: string;
	/** Immutable harness-owned anchor captured before the work item is written to its working branch. */
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
	modelTierListProfiles: ModelTierListProfilesConfig;
	/** Effective session selection; profile definitions remain repository policy. */
	modelTierProfile: string;
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
	| "submitted"
	| "awaiting_ci"
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

export interface DeterministicFailureEvidence {
	schemaVersion: 1;
	kind: "task_check" | "merge_conflict" | "candidate_check" | "post_repair_check" | "infrastructure";
	generation: number;
	ownerAgentId?: string;
	stageId?: string;
	baseCommit?: string;
	candidateCommit: string;
	contributionCommits?: string[];
	checkId?: string;
	command?: string;
	attemptPath?: string;
	summary: string;
	signature: string;
	recordedAt: string;
}

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
				/** Local is permission-gated planner routing; agent defaults remain capability tiers. */
				tier: ModelTier;
				rationale: string;
				/** Required by planning policy for high/max routing; optional for compatibility. */
				tierJustification?: string;
			}
			| {
				/** Legacy assignment retained only so existing plans remain readable and replannable. */
				role: string;
				tier: ModelTier;
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
		/** Latest deterministic CI failure routed back to this task's logical owner. */
		deterministicFailure?: DeterministicFailureEvidence | undefined;
		/** Bounded repair generation for the current deterministic failure signature. */
		ciRepairGeneration?: number | undefined;
		/** Set by harness when a stage merge is left conflicted for managed repair. */
		integrationConflict?: { stageId: string; taskIds: string[]; evidencePath: string; recordedAt: string };
		lastRunId?: string;
	};
}

export function isTierTaskAssignment(
	assignment: TaskManifest["execution"]["assignment"],
): assignment is Extract<TaskManifest["execution"]["assignment"], { tier: ModelTier }> {
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

export type StageReviewPolicy =
	| {
		/** Omitted mode is the legacy-compatible required review policy. */
		mode?: "required";
		/** Medium is the default. High is reserved for a substantively focused risk boundary. */
		tier: "medium" | "high";
		focus?: string[];
		rationale?: string;
	}
	| {
		/** Explicit opt-out; omission never silently skips a legacy stage review. */
		mode: "skip";
		rationale: string;
		tier?: never;
		focus?: never;
	};

export interface E2ECaseResult {
	caseId: string;
	status: "pass" | "fail" | "blocked";
	executedActions: string[];
	observations: string[];
	evidenceRefs: string[];
}

export interface VerificationCheck {
	/** Stable within one stage; omitted legacy checks receive check-N identifiers. */
	id?: string;
	command: string;
	/** Named execution profile from .pibox/verification.yaml. */
	profile?: string;
}

export type VerificationCheckSpec = string | VerificationCheck;

export interface ExecutionStageContract {
	id: string;
	tasks: string[];
	/** Explicit execution topology; omitted stages retain legacy resolution behavior. */
	mode?: "sequential" | "concurrent";
	checks?: VerificationCheckSpec[];
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
	result?: { verdict: "pass" | "fail" | "blocked" | "not_applicable"; report: string; evidence?: string; riskAcceptance?: string; caseResults?: E2ECaseResult[] };
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

export interface WorkItemAmendment {
	/** Immutable completed work item this generation amends. */
	baselineWorkItemId: string;
	/** First completed work item in the amendment chain. */
	rootWorkItemId: string;
	generation: number;
	baselineRevision: number;
	baselineCommit: string;
	createdAt: string;
	reason: string;
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
	/** Present only on linked amendment generations; the completed baseline remains immutable. */
	amendment?: WorkItemAmendment;
	evaluations: Array<{ id: string; path: string }>;
	finalization?: { locked: boolean; reason: string; lockedAt: string };
}

export interface HarnessStatusSnapshot {
	repositoryRoot: string;
	repositoryId: string;
	workItems: WorkItemIndex[];
	taskCounts: Record<string, Record<string, number>>;
	runs: Array<{ id: string; workItemId: string; taskId?: string; role: string; state: string; model?: string; handoffReady?: boolean }>;
	executionControls: Array<{ workflowRef: string; mode: "running" | "paused" | "stopped" | "completed"; generation: number; updatedAt: string }>;
	agents: Array<{ id: string; role: string; state: string; model: string; processActive: boolean; runId?: string; taskId?: string; evaluationId?: string }>;
}
