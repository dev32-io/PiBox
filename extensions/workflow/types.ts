import type {
	AgentConfig,
	CapabilityTier,
	ConfigDiagnostic,
	HarnessEffort,
	ModelTier,
	ModelTierListProfilesConfig,
} from "../subagent/types.js";

export type {
	AgentConfig,
	CapabilityTier,
	ConfigDiagnostic,
	HarnessEffort,
	ModelTier,
	TierModelRouteConfig,
} from "../subagent/types.js";

export type WorkItemKind = "change" | "story";
export type WorkingBranchKind = "feature" | "fix";

export interface WorkItemDelivery {
	workingBranch: string;
	createdFromCommit: string;
	executionStartCommit?: string;
}

export interface MutationAuthority {
	rationale: string;
	sources?: string[];
}

export interface VerificationProfile {
	shell: string;
	bootstrap?: string;
	requiredEnvironment: string[];
}

export interface VerificationPolicy {
	defaultProfile?: string;
	profiles: Record<string, VerificationProfile>;
}

export interface HarnessConfig {
	schemaVersion: 2;
	modelTierListProfiles: ModelTierListProfilesConfig;
	modelTierProfile: string;
	agents: Record<string, AgentConfig>;
	orchestrator: { modelSwitching: "off" | "suggest" | "auto-visible" };
	limits: {
		maxConcurrency: number;
		maxActiveSubagentsPerSession: number;
		maxSubagentDepth: number;
		protocolNudges: number;
		repairRounds: number;
	};
	verification?: VerificationPolicy;
}

export interface LoadedHarnessConfig {
	config: HarnessConfig;
	digest: string;
	sources: string[];
	diagnostics: ConfigDiagnostic[];
}

export interface StoryDocument {
	schemaVersion: 1;
	id: string;
	title: string;
	kind: WorkItemKind;
	spec: string;
	design: string;
	e2e: string;
}

export interface TaskAssignment {
	agent: string;
	tier: ModelTier;
	rationale: string;
	tierJustification?: string;
}

export interface VerificationCheck {
	id?: string;
	command: string;
	/** Named profile from the optional .pi/harness.yaml verification section. */
	profile?: string;
}

export type VerificationCheckSpec = string | VerificationCheck;

export interface AuthoredTaskDocument {
	schemaVersion: 1;
	id: string;
	title: string;
	dependsOn: string[];
	description: string;
	scope: string;
	delivery: string;
	checks: VerificationCheckSpec[];
	assignment: TaskAssignment;
}

export interface AuthoredExecutionStage {
	id: string;
	tasks: string[];
	mode: "sequential" | "concurrent";
	checks: VerificationCheckSpec[];
	review?: { mode: "required" | "skip"; focus?: string };
}

export interface StoryPlanDocument {
	schemaVersion: 1;
	stages: AuthoredExecutionStage[];
}

/** Read projection only; lifecycle authority remains story-local state.yaml. */
export interface TargetWorkItem {
	id: string;
	title: string;
	kind: WorkItemKind;
	phase: "planning" | "execution";
	state: "active";
	planning: { revision: 1 };
	tasks: Array<{ id: string; path: string }>;
	stages: AuthoredExecutionStage[];
	delivery?: WorkItemDelivery;
}

export interface LegacyWorkItemSummary {
	id: string;
	title: string;
	phase: string;
	state: string;
	active: boolean;
}
