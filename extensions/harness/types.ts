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
	evaluations: Array<{ id: string; path: string }>;
}

export interface HarnessStatusSnapshot {
	repositoryRoot: string;
	repositoryId: string;
	configDigest: string;
	workItems: WorkItemIndex[];
}
