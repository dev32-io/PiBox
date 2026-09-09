import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
	CAPABILITY_TIERS,
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	loadGlobalModelTierListProfiles,
	normalizeLegacyModelTiers,
	resolveModelTierAgentDir,
	validateModelTierListProfiles,
} from "../model-tier-list-profiles/profiles.js";
import { discoverAgentDefinitions, discoverProjectAgents } from "./agent-definitions.js";
import { validateSubagentToolSelectors } from "./tool-policy.js";
import type {
	AgentConfig,
	CapabilityTier,
	ConfigDiagnostic,
	LoadedSubagentCatalog,
	SubagentCatalogConfig,
} from "./types.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BUILT_IN_AGENT_ROOT = resolve(REPOSITORY_ROOT, "agent-definitions");

const AGENT_KEYS = new Set(["extends", "description", "prompt", "skills", "tools", "model", "workspace", "canDelegate", "completionSchema", "tier", "deliberation"]);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeCatalogValues(base: unknown, override: unknown): unknown {
	if (!isRecord(base) || !isRecord(override)) return structuredClone(override);
	const merged: UnknownRecord = structuredClone(base);
	for (const [key, value] of Object.entries(override)) merged[key] = key in merged ? mergeCatalogValues(merged[key], value) : structuredClone(value);
	return merged;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
	return value;
}

function rejectUnknownKeys(value: UnknownRecord, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${path}.${key}`);
}

function parseAgent(value: unknown, path: string, validateTools: (selectors: readonly string[]) => void): AgentConfig {
	if (!isRecord(value)) throw new Error(`${path} must be a mapping`);
	rejectUnknownKeys(value, AGENT_KEYS, path);
	const agent: AgentConfig = {};
	if (value.extends !== undefined) agent.extends = expectString(value.extends, `${path}.extends`);
	if (value.description !== undefined) agent.description = expectString(value.description, `${path}.description`);
	if (value.prompt !== undefined) agent.prompt = expectString(value.prompt, `${path}.prompt`);
	if (value.skills !== undefined) {
		if (!Array.isArray(value.skills)) throw new Error(`${path}.skills must be an array`);
		agent.skills = value.skills.map((item, index) => expectString(item, `${path}.skills[${index}]`));
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) throw new Error(`${path}.tools must be an array`);
		agent.tools = value.tools.map((item, index) => expectString(item, `${path}.tools[${index}]`));
		try { validateTools(agent.tools); }
		catch (error) { throw new Error(`${path}.tools: ${error instanceof Error ? error.message : String(error)}`); }
	}
	if (value.model !== undefined) agent.model = expectString(value.model, `${path}.model`);
	if (value.workspace !== undefined) {
		const workspace = expectString(value.workspace, `${path}.workspace`);
		if (workspace !== "repository" && workspace !== "worktree" && workspace !== "none") throw new Error(`${path}.workspace is unsupported`);
		agent.workspace = workspace;
	}
	if (value.canDelegate !== undefined) {
		if (typeof value.canDelegate !== "boolean") throw new Error(`${path}.canDelegate must be boolean`);
		agent.canDelegate = value.canDelegate;
	}
	if (value.completionSchema !== undefined) agent.completionSchema = expectString(value.completionSchema, `${path}.completionSchema`);
	if (value.tier !== undefined) {
		const tier = expectString(value.tier, `${path}.tier`) as CapabilityTier;
		if (!CAPABILITY_TIERS.includes(tier)) throw new Error(`${path}.tier is unsupported`);
		agent.tier = tier;
	}
	if (value.deliberation !== undefined && !["standard", "deep"].includes(expectString(value.deliberation, `${path}.deliberation`))) throw new Error(`${path}.deliberation is unsupported`);
	return agent;
}

export function resolveAgentConfigs(
	value: unknown,
	options: { validateTools?: (selectors: readonly string[]) => void } = {},
): Record<string, AgentConfig> {
	if (!isRecord(value)) throw new Error("agents must be a mapping");
	const parsed: Record<string, AgentConfig> = {};
	for (const [name, raw] of Object.entries(value)) parsed[name] = parseAgent(raw, `agents.${name}`, options.validateTools ?? validateSubagentToolSelectors);
	const resolved: Record<string, AgentConfig> = {};
	const resolveAgent = (name: string, stack: string[] = []): AgentConfig => {
		if (resolved[name]) return resolved[name];
		const agent = parsed[name];
		if (!agent) throw new Error(`Unknown extended agent: ${name}`);
		if (stack.includes(name)) throw new Error(`Agent inheritance cycle: ${[...stack, name].join(" -> ")}`);
		const parent = agent.extends ? resolveAgent(agent.extends, [...stack, name]) : {};
		const entry = mergeCatalogValues(parent, agent) as AgentConfig;
		delete entry.extends;
		if (!entry.tier) throw new Error(`Agent ${name} must resolve a tier default`);
		resolved[name] = entry;
		return entry;
	};
	for (const name of Object.keys(parsed)) resolveAgent(name);
	return resolved;
}

/** Selection descriptions and tool allowlists are owned by Markdown definitions. */
function withoutHarnessDefinitionFields(value: UnknownRecord): UnknownRecord {
	const copy = structuredClone(value);
	for (const agent of Object.values(copy)) if (isRecord(agent)) {
		delete agent.tools;
		delete agent.description;
	}
	return copy;
}

const builtInDefinitions = discoverAgentDefinitions(BUILT_IN_AGENT_ROOT);
if (builtInDefinitions.diagnostics.length > 0) throw new Error(`Invalid built-in agent definitions:\n${builtInDefinitions.diagnostics.map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n")}`);

export const DEFAULT_SUBAGENT_CATALOG_CONFIG: SubagentCatalogConfig = {
	modelTierListProfiles: structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES),
	modelTierProfile: DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile,
	agents: structuredClone(builtInDefinitions.agents),
};

export interface LoadSubagentCatalogOptions {
	home?: string;
	agentDir?: string;
	readFile?: (path: string) => string;
	exists?: (path: string) => boolean;
	modelTierProfile?: string;
	/** Project-controlled policy and definitions are loaded only after trust. */
	includeProject?: boolean;
}

/**
 * Load only generic launch policy. This intentionally does not construct any
 * workflow stores, schedulers, registries, or repository runtime state.
 */
export function loadSubagentCatalog(repositoryRoot: string, options: LoadSubagentCatalogOptions = {}): LoadedSubagentCatalog {
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const exists = options.exists ?? existsSync;
	const agentDir = resolveModelTierAgentDir(options);
	let profiles: unknown = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	let agents: unknown = structuredClone(builtInDefinitions.agents);
	const sources = ["built-in"];
	const diagnostics: ConfigDiagnostic[] = [];

	try {
		const globalProfiles = loadGlobalModelTierListProfiles(options);
		profiles = globalProfiles.config;
		if (globalProfiles.present) sources.push(globalProfiles.path);
	} catch (error) {
		diagnostics.push({ level: "error", source: join(agentDir, "settings.json"), message: error instanceof Error ? error.message : String(error) });
	}

	const candidates = [
		{ source: join(agentDir, "harness", "config.yaml"), global: true },
		...(options.includeProject === false ? [] : [{ source: join(repositoryRoot, ".pi", "harness.yaml"), global: false }]),
	];
	for (const { source, global } of candidates) {
		if (!exists(source)) continue;
		try {
			const parsed = parse(readFile(source)) as unknown;
			if (!isRecord(parsed)) throw new Error("Configuration file must contain a mapping");
			if (parsed.schemaVersion === 1 || "models" in parsed) throw new Error("Legacy model aliases are unsupported; migrate this policy to schemaVersion 2 modelTierListProfiles");
			if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) throw new Error("schemaVersion must be 2");
			if (global) {
				if ("modelTierListProfiles" in parsed || "modelTiers" in parsed) diagnostics.push({
					level: "warning",
					source,
					message: "Global YAML tier routes are ignored; move modelTierListProfiles to the global Pi settings.json file",
				});
				delete parsed.modelTierListProfiles;
				delete parsed.modelTiers;
			} else {
				const inheritedDefault = isRecord(profiles) && typeof profiles.defaultProfile === "string" ? profiles.defaultProfile : DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile;
				normalizeLegacyModelTiers(parsed, inheritedDefault);
				if (parsed.modelTierListProfiles !== undefined) profiles = mergeCatalogValues(profiles, parsed.modelTierListProfiles);
			}
			const rawAgents = isRecord(parsed.agents) ? parsed.agents : parsed.roles;
			if (isRecord(rawAgents)) agents = mergeCatalogValues(agents, withoutHarnessDefinitionFields(rawAgents));
			sources.push(source);
		} catch (error) {
			diagnostics.push({ level: "error", source, message: error instanceof Error ? error.message : String(error) });
		}
	}
	if (diagnostics.some((diagnostic) => diagnostic.level === "error")) throw new Error(diagnostics.filter((diagnostic) => diagnostic.level === "error").map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n"));

	const modelTierListProfiles = validateModelTierListProfiles(profiles);
	const modelTierProfile = options.modelTierProfile && modelTierListProfiles.profiles[options.modelTierProfile]
		? options.modelTierProfile
		: modelTierListProfiles.defaultProfile;
	const config: SubagentCatalogConfig = { modelTierListProfiles, modelTierProfile, agents: resolveAgentConfigs(agents) };
	const projectAgents = options.includeProject === false ? { agents: {}, diagnostics: [] } : discoverProjectAgents(repositoryRoot);
	for (const [name, definition] of Object.entries(projectAgents.agents)) config.agents[name] = definition;
	diagnostics.push(...projectAgents.diagnostics);
	if (Object.keys(projectAgents.agents).length > 0) sources.push(join(repositoryRoot, ".pi", "agents"));
	const digest = `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
	return { config, digest, sources, diagnostics };
}
