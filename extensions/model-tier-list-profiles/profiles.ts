import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { parse } from "yaml";
import type {
	CapabilityTier,
	HarnessEffort,
	ModelTier,
	ModelTierListProfilesConfig,
	ModelTierLists,
	TierModelRouteConfig,
} from "../subagent/types.js";

export type {
	CapabilityTier,
	HarnessEffort,
	ModelTier,
	ModelTierListProfilesConfig,
	ModelTierLists,
	TierModelRouteConfig,
} from "../subagent/types.js";

export const DEFAULT_MODEL_TIER_PROFILE = "performance";
export const CAPABILITY_TIERS: CapabilityTier[] = ["low", "medium", "high", "max"];
export const MODEL_TIERS: ModelTier[] = [...CAPABILITY_TIERS, "local"];
const EFFORTS = new Set<HarnessEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const PROFILE_KEYS = new Set(["defaultProfile", "profiles"]);
const ROUTE_KEYS = new Set(["provider", "model", "effort"]);
const LOCAL_PROVIDER_ID = "local-llm";

const COMMON_LOCAL = ["local-llm/meta/muse-glimmer#high"];
const COMMON_MAX = ["openai-codex/gpt-5.6-sol#max", "ollama-cloud/deepseek-v4-pro#max"];
const COMMON_HIGH = ["openai-codex/gpt-5.6-sol#high", "ollama-cloud/deepseek-v4-pro:0813#high"];
const COMMON_LOW = ["openai-codex/gpt-5.6-luna#high", "ollama-cloud/deepseek-v4-flash#low"];

export const DEFAULT_MODEL_TIER_LIST_PROFILES: ModelTierListProfilesConfig = Object.freeze({
	defaultProfile: DEFAULT_MODEL_TIER_PROFILE,
	profiles: {
		nuke: {
			max: ["openai-codex/gpt-6-astra#max", ...COMMON_MAX],
			high: ["openai-codex/gpt-6-astra#high", ...COMMON_HIGH],
			medium: ["openai-codex/gpt-6-astra#medium", "openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-flash#max"],
			low: [...COMMON_LOW],
			local: [...COMMON_LOCAL],
		},
		performance: {
			max: [...COMMON_MAX],
			high: [...COMMON_HIGH],
			medium: ["openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-flash#max"],
			low: [...COMMON_LOW],
			local: [...COMMON_LOCAL],
		},
		"token-conservative": {
			max: [...COMMON_MAX],
			high: [...COMMON_HIGH],
			medium: ["openai-codex/gpt-5.6-luna#max", "ollama-cloud/deepseek-v4-flash#max"],
			low: [...COMMON_LOW],
			local: [...COMMON_LOCAL],
		},
	},
});

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${path} must be a non-empty string`);
	return value.trim();
}

function rejectUnknownKeys(value: UnknownRecord, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${path}.${key}`);
}

export function mergeModelTierProfileValues(base: unknown, override: unknown): unknown {
	if (!isRecord(base) || !isRecord(override)) return structuredClone(override);
	const merged: UnknownRecord = structuredClone(base);
	for (const [key, value] of Object.entries(override)) merged[key] = key in merged ? mergeModelTierProfileValues(merged[key], value) : structuredClone(value);
	return merged;
}

export function parseTierModelRoute(value: unknown, path: string): TierModelRouteConfig {
	if (typeof value === "string") {
		const separator = value.lastIndexOf("#");
		const providerSeparator = value.indexOf("/");
		if (separator <= providerSeparator || providerSeparator <= 0 || separator === value.length - 1) throw new Error(`${path} must use provider/model#effort`);
		const effort = value.slice(separator + 1).toLowerCase() as HarnessEffort;
		if (!EFFORTS.has(effort)) throw new Error(`${path} effort is unsupported`);
		return `${value.slice(0, separator)}#${effort}`;
	}
	if (!isRecord(value)) throw new Error(`${path} must use provider/model#effort`);
	// Keep the prior mapping form readable while normalizing all runtime routes.
	rejectUnknownKeys(value, ROUTE_KEYS, path);
	const provider = expectString(value.provider, `${path}.provider`);
	const model = expectString(value.model, `${path}.model`);
	const legacyEffort = isRecord(value.effort) ? value.effort.standard : value.effort;
	const effort = expectString(legacyEffort, `${path}.effort`).toLowerCase() as HarnessEffort;
	if (!EFFORTS.has(effort)) throw new Error(`${path}.effort is unsupported`);
	return `${provider}/${model}#${effort}`;
}

function validateTierLists(value: unknown, path: string): ModelTierLists {
	if (!isRecord(value)) throw new Error(`${path} must be a mapping`);
	const result = {} as ModelTierLists;
	for (const tier of MODEL_TIERS) {
		const routes = value[tier];
		if (!Array.isArray(routes) || routes.length === 0) throw new Error(`${path}.${tier} must be a non-empty array`);
		result[tier] = routes.map((route, index) => parseTierModelRoute(route, `${path}.${tier}[${index}]`));
	}
	for (const tier of Object.keys(value)) if (!MODEL_TIERS.includes(tier as ModelTier)) throw new Error(`Unknown model tier: ${path}.${tier}`);
	if (result.local.some((route) => !route.startsWith(`${LOCAL_PROVIDER_ID}/`))) throw new Error(`${path}.local routes must use the ${LOCAL_PROVIDER_ID} provider`);
	return result;
}

export function validateModelTierListProfiles(value: unknown): ModelTierListProfilesConfig {
	if (!isRecord(value)) throw new Error("modelTierListProfiles must be a mapping");
	rejectUnknownKeys(value, PROFILE_KEYS, "modelTierListProfiles");
	const defaultProfile = expectString(value.defaultProfile, "modelTierListProfiles.defaultProfile");
	if (!isRecord(value.profiles) || Object.keys(value.profiles).length === 0) throw new Error("modelTierListProfiles.profiles must be a non-empty mapping");
	const profiles: Record<string, ModelTierLists> = {};
	for (const [name, tiers] of Object.entries(value.profiles)) {
		if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`Invalid model tier profile name: ${name}`);
		profiles[name] = validateTierLists(tiers, `modelTierListProfiles.profiles.${name}`);
	}
	if (!profiles[defaultProfile]) throw new Error(`Unknown default model tier profile: ${defaultProfile}`);
	return { defaultProfile, profiles };
}

export function activeModelTierLists(config: ModelTierListProfilesConfig, requested?: string): { name: string; tiers: ModelTierLists } {
	const name = requested && config.profiles[requested] ? requested : config.defaultProfile;
	const tiers = config.profiles[name];
	if (!tiers) throw new Error(`Unknown model tier profile: ${name}`);
	return { name, tiers };
}

/** Convert the former top-level modelTiers field into the configured default profile. */
export function normalizeLegacyModelTiers(value: UnknownRecord, inheritedDefaultProfile = DEFAULT_MODEL_TIER_PROFILE): void {
	if (!("modelTiers" in value)) return;
	const current = isRecord(value.modelTierListProfiles) ? value.modelTierListProfiles : {};
	const defaultProfile = typeof current.defaultProfile === "string" && current.defaultProfile.trim() ? current.defaultProfile.trim() : inheritedDefaultProfile;
	const profiles = isRecord(current.profiles) ? current.profiles : {};
	value.modelTierListProfiles = {
		...current,
		defaultProfile,
		profiles: {
			...profiles,
			[defaultProfile]: mergeModelTierProfileValues(profiles[defaultProfile] ?? {}, value.modelTiers),
		},
	};
	delete value.modelTiers;
}

function findRepositoryRoot(cwd: string, exists: (path: string) => boolean): string {
	let current = cwd;
	while (true) {
		if (exists(join(current, ".pi", "harness.yaml")) || exists(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return cwd;
		current = parent;
	}
}

export interface ModelTierProfileSourceOptions {
	home?: string;
	agentDir?: string;
	readFile?: (path: string) => string;
	exists?: (path: string) => boolean;
	includeProject?: boolean;
}

export function resolveModelTierAgentDir(options: Pick<ModelTierProfileSourceOptions, "home" | "agentDir"> = {}): string {
	const configured = options.agentDir !== undefined
		? options.agentDir
		: options.home !== undefined
			? join(options.home, ".pi", "agent")
			: getAgentDir();
	const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
	return resolve(expanded);
}

export function resolveModelTierSettingsPath(options: Pick<ModelTierProfileSourceOptions, "home" | "agentDir"> = {}): string {
	return join(resolveModelTierAgentDir(options), "settings.json");
}

export interface LoadedGlobalModelTierListProfiles {
	config: ModelTierListProfilesConfig;
	path: string;
	present: boolean;
}

function profilesFromGlobalSettings(settings: unknown, path: string, present: boolean): LoadedGlobalModelTierListProfiles {
	if (!isRecord(settings)) throw new Error(`${path}: settings must contain a JSON object`);
	if (settings.modelTierListProfiles === undefined) return { config: structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES), path, present };
	const merged = mergeModelTierProfileValues(DEFAULT_MODEL_TIER_LIST_PROFILES, settings.modelTierListProfiles);
	try { return { config: validateModelTierListProfiles(merged), path, present }; }
	catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Read only the official global settings source; project settings are intentionally excluded. */
export function loadGlobalModelTierListProfiles(options: ModelTierProfileSourceOptions = {}): LoadedGlobalModelTierListProfiles {
	const path = resolveModelTierSettingsPath(options);
	if (options.home === undefined && options.readFile === undefined && options.exists === undefined) {
		const manager = SettingsManager.create(process.cwd(), resolveModelTierAgentDir(options), { projectTrusted: false });
		const settings = manager.getGlobalSettings() as unknown;
		const errors = manager.drainErrors().filter((entry) => entry.scope === "global");
		if (errors.length > 0) throw new Error(errors.map((entry) => {
			const locked = (entry.error as NodeJS.ErrnoException).code === "ELOCKED";
			return `${locked ? `${path}.lock` : path}: ${entry.error.message}`;
		}).join("; "));
		return profilesFromGlobalSettings(settings, path, existsSync(path));
	}
	const readFile = options.readFile ?? ((source: string) => readFileSync(source, "utf8"));
	const exists = options.exists ?? existsSync;
	if (!exists(path)) return { config: structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES), path, present: false };
	let settings: unknown;
	try { settings = JSON.parse(readFile(path).replace(/^\uFEFF/, "")); }
	catch (error) { throw new Error(`${path}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`); }
	return profilesFromGlobalSettings(settings, path, true);
}

export function loadModelTierListProfiles(
	cwd: string,
	options: ModelTierProfileSourceOptions = {},
): ModelTierListProfilesConfig {
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const exists = options.exists ?? existsSync;
	let merged: unknown = loadGlobalModelTierListProfiles(options).config;
	if (options.includeProject === false) return validateModelTierListProfiles(merged);
	const repositoryRoot = findRepositoryRoot(cwd, exists);
	const source = join(repositoryRoot, ".pi", "harness.yaml");
	if (!exists(source)) return validateModelTierListProfiles(merged);
	const parsed = parse(readFile(source)) as unknown;
	if (!isRecord(parsed)) throw new Error(`${source}: configuration must contain a mapping`);
	if (parsed.schemaVersion === 1 || "models" in parsed) throw new Error(`${source}: Legacy model aliases are unsupported; migrate this policy to schemaVersion 2 modelTierListProfiles`);
	if (parsed.schemaVersion !== undefined && parsed.schemaVersion !== 2) throw new Error(`${source}: schemaVersion must be 2`);
	const inheritedDefault = isRecord(merged) && typeof merged.defaultProfile === "string" ? merged.defaultProfile : DEFAULT_MODEL_TIER_PROFILE;
	normalizeLegacyModelTiers(parsed, inheritedDefault);
	if (parsed.modelTierListProfiles !== undefined) merged = mergeModelTierProfileValues(merged, parsed.modelTierListProfiles);
	return validateModelTierListProfiles(merged);
}
