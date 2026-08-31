import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessError } from "./errors.js";
import type {
	ConfigDiagnostic,
	HarnessConfig,
	LoadedHarnessConfig,
} from "./types.js";
import {
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	normalizeLegacyModelTiers,
	validateModelTierListProfiles,
} from "../model-tier-list-profiles/profiles.js";
import { discoverProjectAgents } from "../subagent/agent-definitions.js";
import { DEFAULT_SUBAGENT_CATALOG_CONFIG, resolveAgentConfigs } from "../subagent/catalog.js";
import { validateToolSelectors } from "./tool-groups.js";
import { DEFAULT_REVIEW_FIX_ITERATIONS } from "./review-loop.js";

const TOP_LEVEL_KEYS = new Set(["schemaVersion", "modelTierListProfiles", "agents", "roles", "orchestrator", "limits"]);
const ORCHESTRATOR_KEYS = new Set(["modelSwitching"]);
const LIMIT_KEYS = new Set(["maxConcurrency", "maxActiveSubagentsPerSession", "maxSubagentDepth", "protocolNudges", "repairRounds"]);

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
	schemaVersion: 2,
	modelTierListProfiles: structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES),
	modelTierProfile: DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile,
	agents: {
		...structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG.agents),
		implementer: { ...DEFAULT_SUBAGENT_CATALOG_CONFIG.agents.implementer!, completionSchema: "implementer-v1" },
	},
	orchestrator: { modelSwitching: "auto-visible" },
	limits: { maxConcurrency: 4, maxActiveSubagentsPerSession: 16, maxSubagentDepth: 1, protocolNudges: 1, repairRounds: DEFAULT_REVIEW_FIX_ITERATIONS },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeConfigValues(base: unknown, override: unknown): unknown {
	if (!isRecord(base) || !isRecord(override)) return structuredClone(override);
	const merged: UnknownRecord = structuredClone(base);
	for (const [key, value] of Object.entries(override)) merged[key] = key in merged ? mergeConfigValues(merged[key], value) : structuredClone(value);
	return merged;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new HarnessError("CONFIG_INVALID", `${path} must be a non-empty string`);
	return value;
}

function expectInteger(value: unknown, path: string, minimum = 0): number {
	if (!Number.isInteger(value) || (value as number) < minimum) throw new HarnessError("CONFIG_INVALID", `${path} must be an integer >= ${minimum}`);
	return value as number;
}

function rejectUnknownKeys(value: UnknownRecord, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown configuration field: ${path}.${key}`);
}

/** Agent tool allowlists belong to agent-definition frontmatter, never harness policy. */
function ignoreHarnessAgentTools(value: UnknownRecord): void {
	for (const key of ["agents", "roles"] as const) {
		const agents = value[key];
		if (!isRecord(agents)) continue;
		for (const agent of Object.values(agents)) if (isRecord(agent)) delete agent.tools;
	}
}

export function validateHarnessConfig(value: unknown, requestedModelTierProfile?: string): HarnessConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", "Workflow configuration must be a mapping");
	const normalized = structuredClone(value);
	normalizeLegacyModelTiers(normalized);
	delete normalized.modelTierProfile; // Effective session state is derived, never repository policy.
	for (const key of Object.keys(normalized)) if (!TOP_LEVEL_KEYS.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown top-level configuration field: ${key}`);
	if (normalized.schemaVersion !== 2) throw new HarnessError("CONFIG_INVALID", "schemaVersion must be 2; migrate model aliases to modelTierListProfiles and roles to agents");
	const rawAgents = isRecord(normalized.agents) ? normalized.agents : normalized.roles;
	if (!isRecord(normalized.modelTierListProfiles) || !isRecord(rawAgents) || !isRecord(normalized.orchestrator) || !isRecord(normalized.limits)) throw new HarnessError("CONFIG_INVALID", "modelTierListProfiles, agents, orchestrator, and limits must be mappings");
	let modelTierListProfiles;
	try { modelTierListProfiles = validateModelTierListProfiles(normalized.modelTierListProfiles); }
	catch (error) { throw new HarnessError("CONFIG_INVALID", error instanceof Error ? error.message : String(error)); }
	const modelTierProfile = requestedModelTierProfile && modelTierListProfiles.profiles[requestedModelTierProfile]
		? requestedModelTierProfile
		: modelTierListProfiles.defaultProfile;

	let agents;
	try { agents = resolveAgentConfigs(rawAgents, { validateTools: validateToolSelectors }); }
	catch (error) { throw new HarnessError("CONFIG_INVALID", error instanceof Error ? error.message : String(error)); }

	rejectUnknownKeys(normalized.orchestrator, ORCHESTRATOR_KEYS, "orchestrator");
	rejectUnknownKeys(normalized.limits, LIMIT_KEYS, "limits");
	const switching = expectString(normalized.orchestrator.modelSwitching, "orchestrator.modelSwitching");
	if (switching !== "off" && switching !== "suggest" && switching !== "auto-visible") throw new HarnessError("CONFIG_INVALID", "orchestrator.modelSwitching is unsupported");

	return {
		schemaVersion: 2,
		modelTierListProfiles,
		modelTierProfile,
		agents,
		orchestrator: { modelSwitching: switching },
		limits: {
			maxConcurrency: expectInteger(normalized.limits.maxConcurrency, "limits.maxConcurrency", 1),
			maxActiveSubagentsPerSession: expectInteger(normalized.limits.maxActiveSubagentsPerSession, "limits.maxActiveSubagentsPerSession", 1),
			maxSubagentDepth: expectInteger(normalized.limits.maxSubagentDepth, "limits.maxSubagentDepth"),
			protocolNudges: expectInteger(normalized.limits.protocolNudges, "limits.protocolNudges"),
			repairRounds: expectInteger(normalized.limits.repairRounds, "limits.repairRounds"),
		},
	};
}

function digestConfig(config: HarnessConfig): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
}

export function loadHarnessConfig(
	repositoryRoot: string,
	options: { home?: string; readFile?: (path: string) => string; exists?: (path: string) => boolean; modelTierProfile?: string } = {},
): LoadedHarnessConfig {
	const home = options.home ?? homedir();
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const exists = options.exists ?? existsSync;
	const candidates = [join(home, ".pi", "agent", "harness", "config.yaml"), join(repositoryRoot, ".pi", "harness.yaml")];
	let merged: unknown = structuredClone(DEFAULT_HARNESS_CONFIG);
	const sources = ["built-in"];
	const diagnostics: ConfigDiagnostic[] = [];

	for (const source of candidates) {
		if (!exists(source)) continue;
		try {
			const parsed = parse(readFile(source));
			if (!isRecord(parsed)) throw new HarnessError("CONFIG_INVALID", "Configuration file must contain a mapping");
			if (parsed.schemaVersion === 1 || "models" in parsed) throw new HarnessError("CONFIG_INVALID", "Legacy model aliases are unsupported; migrate this policy to schemaVersion 2 modelTierListProfiles");
			normalizeLegacyModelTiers(parsed);
			ignoreHarnessAgentTools(parsed);
			if (isRecord(parsed.roles) && !isRecord(parsed.agents)) parsed.agents = parsed.roles;
			delete parsed.roles;
			merged = mergeConfigValues(merged, parsed);
			sources.push(source);
		} catch (error) {
			diagnostics.push({ level: "error", source, message: error instanceof Error ? error.message : String(error) });
		}
	}

	if (diagnostics.some((diagnostic) => diagnostic.level === "error")) throw new HarnessError("CONFIG_INVALID", diagnostics.map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n"), { diagnostics });
	const config = validateHarnessConfig(merged, options.modelTierProfile);
	const projectAgents = discoverProjectAgents(repositoryRoot, { validateTools: validateToolSelectors });
	for (const [name, definition] of Object.entries(projectAgents.agents)) config.agents[name] = definition;
	diagnostics.push(...projectAgents.diagnostics);
	if (Object.keys(projectAgents.agents).length > 0) sources.push(join(repositoryRoot, ".pi", "agents"));
	return { config, digest: digestConfig(config), sources, diagnostics };
}
