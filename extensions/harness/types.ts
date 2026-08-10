import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type WorkItemKind = "change" | "story";
export type WorkItemPhase = "planning" | "execution" | "evaluation" | "complete";
export type WorkItemState = "active" | "waiting_user" | "paused" | "blocked" | "failed" | "complete";
export type PlanningStatus = "draft" | "awaiting_approval" | "approved" | "stale";
export type Complexity = "low" | "medium" | "high" | "critical";
export type HarnessEffort = ModelThinkingLevel;

export interface ModelAliasConfig {
	provider: string;
	model: string;
	capabilityRank: number;
}

export interface ModelCandidateConfig {
	model: string;
	effort: HarnessEffort;
}

export interface RoleConfig {
	extends?: string;
	prompt?: string;
	skills?: string[];
	tools?: string[];
	workspace?: "repository" | "worktree" | "none";
	canDelegate?: boolean;
	completionSchema?: string;
	models?: ModelCandidateConfig[];
}

export interface HarnessConfig {
	schemaVersion: 1;
	models: Record<string, ModelAliasConfig>;
	roles: Record<string, RoleConfig>;
	orchestrator: {
		modelSwitching: "off" | "suggest" | "auto-visible";
	};
	limits: {
		maxConcurrency: number;
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
	type: "intent" | "spec" | "design" | "decision" | "outcome";
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
	references: {
		specs: string[];
		designs: string[];
		decisions: string[];
	};
	execution: {
		isolation: "worktree" | "repository";
		parallelism: "allowed" | "serial";
		resourceClaims: string[];
		complexity: Complexity;
		assignment: {
			role: string;
			model: string;
			effort: HarnessEffort;
			minimumCapabilityRank: number;
			allowFallback: boolean;
			rationale: string;
		};
	};
	assembly: {
		integrationUnit: string;
		intermediateState: "complete" | "partial";
	};
	verification: {
		timing: "task" | "integration-unit" | "work-item" | "skipped";
		methods: string[];
		taskChecks: string[];
		rationale: string;
	};
	runtime?: {
		branch?: string;
		worktree?: string;
		baseCommit?: string;
		completedCommit?: string;
		lastRunId?: string;
	};
}

export interface EvaluationFinding {
	id: string;
	severity: "low" | "medium" | "high" | "critical";
	status: "open" | "accepted" | "rejected" | "duplicate" | "deferred" | "resolved" | "needs_user";
	criterion?: string;
	location?: string;
	summary: string;
	blocking: boolean;
}

export interface EvaluationManifest {
	schemaVersion: 1;
	id: string;
	type: "deterministic" | "spec-review" | "quality-review" | "combined-review" | "regression" | "e2e";
	scope: { task?: string; integrationUnit?: string; workItem?: string };
	status: "planned" | "running" | "passed" | "failed" | "blocked" | "not_applicable";
	required: boolean;
	attempt: number;
	methods: string[];
	criteria?: string[];
	findings?: EvaluationFinding[];
	result?: { verdict: "pass" | "fail" | "blocked" | "not_applicable"; report: string; evidence?: string };
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
		status: PlanningStatus;
		approvedRevision?: number;
		approvedAt?: string;
		contractDigest: string;
	};
	artifacts: ArtifactIndexEntry[];
	tasks: Array<{ id: string; path: string }>;
	integrationUnits: Array<{ id: string; tasks: string[]; intermediatePolicy: "coherent" | "partial-allowed" }>;
	evaluations: Array<{ id: string; path: string }>;
}

export interface HarnessStatusSnapshot {
	repositoryRoot: string;
	repositoryId: string;
	configDigest: string;
	workItems: WorkItemIndex[];
	taskCounts: Record<string, Record<string, number>>;
	runs: Array<{ id: string; workItemId: string; taskId?: string; role: string; state: string; model?: string }>;
}
