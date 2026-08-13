import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessError } from "./errors.js";
import type {
	CapabilityTier,
	ConfigDiagnostic,
	Deliberation,
	HarnessConfig,
	HarnessEffort,
	LoadedHarnessConfig,
	RoleConfig,
	TierModelRouteConfig,
} from "./types.js";

const EFFORTS = new Set<HarnessEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TIERS: CapabilityTier[] = ["low", "medium", "high", "max"];
const DELIBERATIONS = new Set<Deliberation>(["standard", "deep"]);
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "modelTiers", "roles", "orchestrator", "limits"]);
const ROUTE_KEYS = new Set(["provider", "model", "effort"]);
const EFFORT_KEYS = new Set(["standard", "deep"]);
const ROLE_KEYS = new Set(["extends", "prompt", "skills", "tools", "workspace", "canDelegate", "completionSchema", "tier", "deliberation"]);
const ORCHESTRATOR_KEYS = new Set(["modelSwitching"]);
const LIMIT_KEYS = new Set(["maxConcurrency", "maxActiveSubagentsPerSession", "maxSubagentDepth", "protocolNudges", "repairRounds"]);

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
	schemaVersion: 2,
	modelTiers: {
		max: [
			{ provider: "openai-codex", model: "gpt-5.6-sol", effort: { standard: "high", deep: "max" } },
		],
		high: [
			{ provider: "openai-codex", model: "gpt-5.6-terra", effort: { standard: "medium", deep: "high" } },
			{ provider: "openai-codex", model: "gpt-5.6-sol", effort: { standard: "medium", deep: "high" } },
		],
		medium: [
			{ provider: "openai-codex", model: "gpt-5.6-luna", effort: { standard: "medium", deep: "high" } },
			{ provider: "openai-codex", model: "gpt-5.6-terra", effort: { standard: "low", deep: "high" } },
		],
		low: [
			{ provider: "openai-codex", model: "gpt-5.6-luna", effort: { standard: "low", deep: "medium" } },
		],
	},
	roles: {
		researcher: { workspace: "none", canDelegate: false, tier: "high", deliberation: "standard" },
		explorer: { workspace: "repository", canDelegate: false, tier: "medium", deliberation: "standard" },
		"plan-critic": { workspace: "repository", canDelegate: false, tier: "max", deliberation: "deep" },
		implementer: { workspace: "repository", canDelegate: false, completionSchema: "implementer-v1", tier: "medium", deliberation: "standard" },
		"spec-reviewer": { workspace: "repository", canDelegate: false, tier: "high", deliberation: "deep" },
		"quality-reviewer": { workspace: "repository", canDelegate: false, tier: "high", deliberation: "deep" },
		"test-implementer": { workspace: "repository", canDelegate: false, completionSchema: "implementer-v1", tier: "medium", deliberation: "standard" },
		"e2e-tester": { workspace: "repository", canDelegate: false, tier: "medium", deliberation: "standard" },
		"repair-implementer": { workspace: "repository", canDelegate: false, tier: "high", deliberation: "standard" },
	},
	orchestrator: { modelSwitching: "auto-visible" },
	limits: { maxConcurrency: 4, maxActiveSubagentsPerSession: 16, maxSubagentDepth: 1, protocolNudges: 1, repairRounds: 2 },
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

function expectEffort(value: unknown, path: string): HarnessEffort {
	const effort = expectString(value, path) as HarnessEffort;
	if (!EFFORTS.has(effort)) throw new HarnessError("CONFIG_INVALID", `${path} is unsupported`);
	return effort;
}

function rejectUnknownKeys(value: UnknownRecord, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) if (!allowed.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown configuration field: ${path}.${key}`);
}

function parseRoute(value: unknown, path: string): TierModelRouteConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must be a mapping`);
	rejectUnknownKeys(value, ROUTE_KEYS, path);
	if (!isRecord(value.effort)) throw new HarnessError("CONFIG_INVALID", `${path}.effort must be a mapping`);
	rejectUnknownKeys(value.effort, EFFORT_KEYS, `${path}.effort`);
	return {
		provider: expectString(value.provider, `${path}.provider`),
		model: expectString(value.model, `${path}.model`),
		effort: {
			standard: expectEffort(value.effort.standard, `${path}.effort.standard`),
			...(value.effort.deep === undefined ? {} : { deep: expectEffort(value.effort.deep, `${path}.effort.deep`) }),
		},
	};
}

function parseRole(value: unknown, path: string): RoleConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must be a mapping`);
	rejectUnknownKeys(value, ROLE_KEYS, path);
	const role: RoleConfig = {};
	if (value.extends !== undefined) role.extends = expectString(value.extends, `${path}.extends`);
	if (value.prompt !== undefined) role.prompt = expectString(value.prompt, `${path}.prompt`);
	if (value.skills !== undefined) {
		if (!Array.isArray(value.skills)) throw new HarnessError("CONFIG_INVALID", `${path}.skills must be an array`);
		role.skills = value.skills.map((item, index) => expectString(item, `${path}.skills[${index}]`));
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) throw new HarnessError("CONFIG_INVALID", `${path}.tools must be an array`);
		role.tools = value.tools.map((item, index) => expectString(item, `${path}.tools[${index}]`));
	}
	if (value.workspace !== undefined) {
		const workspace = expectString(value.workspace, `${path}.workspace`);
		if (workspace !== "repository" && workspace !== "worktree" && workspace !== "none") throw new HarnessError("CONFIG_INVALID", `${path}.workspace is unsupported`);
		role.workspace = workspace;
	}
	if (value.canDelegate !== undefined) {
		if (typeof value.canDelegate !== "boolean") throw new HarnessError("CONFIG_INVALID", `${path}.canDelegate must be boolean`);
		role.canDelegate = value.canDelegate;
	}
	if (value.completionSchema !== undefined) role.completionSchema = expectString(value.completionSchema, `${path}.completionSchema`);
	if (value.tier !== undefined) {
		const tier = expectString(value.tier, `${path}.tier`) as CapabilityTier;
		if (!TIERS.includes(tier)) throw new HarnessError("CONFIG_INVALID", `${path}.tier is unsupported`);
		role.tier = tier;
	}
	if (value.deliberation !== undefined) {
		const deliberation = expectString(value.deliberation, `${path}.deliberation`) as Deliberation;
		if (!DELIBERATIONS.has(deliberation)) throw new HarnessError("CONFIG_INVALID", `${path}.deliberation is unsupported`);
		role.deliberation = deliberation;
	}
	return role;
}

export function validateHarnessConfig(value: unknown): HarnessConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", "Workflow configuration must be a mapping");
	for (const key of Object.keys(value)) if (!TOP_LEVEL_KEYS.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown top-level configuration field: ${key}`);
	if (value.schemaVersion !== 2) throw new HarnessError("CONFIG_INVALID", "schemaVersion must be 2; migrate model aliases and role candidates to modelTiers");
	if (!isRecord(value.modelTiers) || !isRecord(value.roles) || !isRecord(value.orchestrator) || !isRecord(value.limits)) throw new HarnessError("CONFIG_INVALID", "modelTiers, roles, orchestrator, and limits must be mappings");

	const modelTiers = {} as Record<CapabilityTier, TierModelRouteConfig[]>;
	for (const tier of TIERS) {
		const raw = value.modelTiers[tier];
		if (!Array.isArray(raw) || raw.length === 0) throw new HarnessError("CONFIG_INVALID", `modelTiers.${tier} must be a non-empty array`);
		modelTiers[tier] = raw.map((route, index) => parseRoute(route, `modelTiers.${tier}[${index}]`));
	}
	for (const tier of Object.keys(value.modelTiers)) if (!TIERS.includes(tier as CapabilityTier)) throw new HarnessError("CONFIG_INVALID", `Unknown model tier: ${tier}`);

	const parsedRoles: Record<string, RoleConfig> = {};
	for (const [name, raw] of Object.entries(value.roles)) parsedRoles[name] = parseRole(raw, `roles.${name}`);
	const roles: Record<string, RoleConfig> = {};
	const resolveRole = (name: string, stack: string[] = []): RoleConfig => {
		if (roles[name]) return roles[name];
		const role = parsedRoles[name];
		if (!role) throw new HarnessError("CONFIG_INVALID", `Unknown extended role: ${name}`);
		if (stack.includes(name)) throw new HarnessError("CONFIG_INVALID", `Role inheritance cycle: ${[...stack, name].join(" -> ")}`);
		const parent = role.extends ? resolveRole(role.extends, [...stack, name]) : {};
		const resolved = mergeConfigValues(parent, role) as RoleConfig;
		delete resolved.extends;
		if (!resolved.tier || !resolved.deliberation) throw new HarnessError("CONFIG_INVALID", `Role ${name} must resolve tier and deliberation defaults`);
		roles[name] = resolved;
		return resolved;
	};
	for (const name of Object.keys(parsedRoles)) resolveRole(name);

	rejectUnknownKeys(value.orchestrator, ORCHESTRATOR_KEYS, "orchestrator");
	rejectUnknownKeys(value.limits, LIMIT_KEYS, "limits");
	const switching = expectString(value.orchestrator.modelSwitching, "orchestrator.modelSwitching");
	if (switching !== "off" && switching !== "suggest" && switching !== "auto-visible") throw new HarnessError("CONFIG_INVALID", "orchestrator.modelSwitching is unsupported");

	return {
		schemaVersion: 2,
		modelTiers,
		roles,
		orchestrator: { modelSwitching: switching },
		limits: {
			maxConcurrency: expectInteger(value.limits.maxConcurrency, "limits.maxConcurrency", 1),
			maxActiveSubagentsPerSession: expectInteger(value.limits.maxActiveSubagentsPerSession, "limits.maxActiveSubagentsPerSession", 1),
			maxSubagentDepth: expectInteger(value.limits.maxSubagentDepth, "limits.maxSubagentDepth"),
			protocolNudges: expectInteger(value.limits.protocolNudges, "limits.protocolNudges"),
			repairRounds: expectInteger(value.limits.repairRounds, "limits.repairRounds"),
		},
	};
}

function digestConfig(config: HarnessConfig): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(config)).digest("hex")}`;
}

export function loadHarnessConfig(
	repositoryRoot: string,
	options: { home?: string; readFile?: (path: string) => string; exists?: (path: string) => boolean } = {},
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
			if (parsed.schemaVersion === 1 || "models" in parsed) throw new HarnessError("CONFIG_INVALID", "Legacy model aliases are unsupported; migrate this policy to schemaVersion 2 modelTiers");
			merged = mergeConfigValues(merged, parsed);
			sources.push(source);
		} catch (error) {
			diagnostics.push({ level: "error", source, message: error instanceof Error ? error.message : String(error) });
		}
	}

	if (diagnostics.some((diagnostic) => diagnostic.level === "error")) throw new HarnessError("CONFIG_INVALID", diagnostics.map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n"), { diagnostics });
	const config = validateHarnessConfig(merged);
	return { config, digest: digestConfig(config), sources, diagnostics };
}
