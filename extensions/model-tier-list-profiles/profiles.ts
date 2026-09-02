import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
export function normalizeLegacyModelTiers(value: UnknownRecord): void {
	if (!("modelTiers" in value)) return;
	const current = isRecord(value.modelTierListProfiles) ? value.modelTierListProfiles : {};
	const defaultProfile = typeof current.defaultProfile === "string" && current.defaultProfile.trim() ? current.defaultProfile.trim() : DEFAULT_MODEL_TIER_PROFILE;
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

export function loadModelTierListProfiles(
	cwd: string,
	options: { home?: string; readFile?: (path: string) => string; exists?: (path: string) => boolean; includeProject?: boolean } = {},
): ModelTierListProfilesConfig {
	const home = options.home ?? homedir();
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const exists = options.exists ?? existsSync;
	const repositoryRoot = findRepositoryRoot(cwd, exists);
	const candidates = [join(home, ".pi", "agent", "harness", "config.yaml"), ...(options.includeProject === false ? [] : [join(repositoryRoot, ".pi", "harness.yaml")])];
	let merged: unknown = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	for (const source of candidates) {
		if (!exists(source)) continue;
		const parsed = parse(readFile(source)) as unknown;
		if (!isRecord(parsed)) throw new Error(`${source}: configuration must contain a mapping`);
		normalizeLegacyModelTiers(parsed);
		if (parsed.modelTierListProfiles !== undefined) merged = mergeModelTierProfileValues(merged, parsed.modelTierListProfiles);
	}
	return validateModelTierListProfiles(merged);
}
