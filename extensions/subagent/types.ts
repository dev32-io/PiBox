import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export type HarnessEffort = ModelThinkingLevel;
export type CapabilityTier = "low" | "medium" | "high" | "max";
/** Direct launches may explicitly select the provider-isolated local route group. */
export type ModelTier = CapabilityTier | "local";
/** Compact provider/model#effort route persisted in harness policy. */
export type TierModelRouteConfig = string;
export type ModelTierLists = Record<ModelTier, TierModelRouteConfig[]>;

export interface ModelTierListProfilesConfig {
	defaultProfile: string;
	profiles: Record<string, ModelTierLists>;
}

/** Generic agent catalog entry shared by direct and workflow-managed launches. */
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

export interface ConfigDiagnostic {
	level: "warning" | "error";
	source: string;
	path?: string;
	message: string;
}

/** Narrow routing contract accepted by standalone model resolution. */
export interface ModelRoutingConfig {
	modelTierListProfiles: ModelTierListProfilesConfig;
	modelTierProfile: string;
}

export interface SubagentCatalogConfig extends ModelRoutingConfig {
	agents: Record<string, AgentConfig>;
}

export interface LoadedSubagentCatalog {
	config: SubagentCatalogConfig;
	digest: string;
	sources: string[];
	diagnostics: ConfigDiagnostic[];
}
