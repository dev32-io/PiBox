import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessError } from "./errors.js";
import type {
	ConfigDiagnostic,
	HarnessConfig,
	HarnessEffort,
	LoadedHarnessConfig,
	ModelAliasConfig,
	ModelCandidateConfig,
	RoleConfig,
} from "./types.js";

const EFFORTS = new Set<HarnessEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "models", "roles", "orchestrator", "limits"]);
const MODEL_KEYS = new Set(["provider", "model", "capabilityRank"]);
const ROLE_KEYS = new Set(["prompt", "skills", "tools", "workspace", "canDelegate", "completionSchema", "models"]);
const ORCHESTRATOR_KEYS = new Set(["modelSwitching"]);
const LIMIT_KEYS = new Set(["maxConcurrency", "protocolNudges", "repairRounds"]);

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
	schemaVersion: 1,
	models: {
		sol: { provider: "openai-codex", model: "gpt-5.6-sol", capabilityRank: 300 },
		terra: { provider: "openai-codex", model: "gpt-5.6-terra", capabilityRank: 200 },
		luna: { provider: "openai-codex", model: "gpt-5.6-luna", capabilityRank: 100 },
	},
	roles: {
		researcher: { workspace: "none", canDelegate: false, models: [{ model: "terra", effort: "high" }] },
		explorer: { workspace: "repository", canDelegate: false, models: [{ model: "terra", effort: "high" }] },
		"plan-critic": { workspace: "repository", canDelegate: false, models: [{ model: "sol", effort: "high" }] },
		implementer: {
			workspace: "worktree",
			canDelegate: false,
			completionSchema: "implementer-v1",
			models: [
				{ model: "sol", effort: "high" },
				{ model: "terra", effort: "high" },
			],
		},
		"spec-reviewer": { workspace: "repository", canDelegate: false, models: [{ model: "sol", effort: "high" }] },
		"quality-reviewer": { workspace: "repository", canDelegate: false, models: [{ model: "sol", effort: "high" }] },
		"test-implementer": { workspace: "worktree", canDelegate: false, completionSchema: "implementer-v1", models: [{ model: "terra", effort: "high" }] },
		"e2e-tester": { workspace: "repository", canDelegate: false, models: [{ model: "terra", effort: "high" }] },
		"repair-implementer": { workspace: "worktree", canDelegate: false, models: [{ model: "sol", effort: "high" }] },
	},
	orchestrator: { modelSwitching: "auto-visible" },
	limits: { maxConcurrency: 4, protocolNudges: 1, repairRounds: 2 },
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeConfigValues(base: unknown, override: unknown): unknown {
	if (!isRecord(base) || !isRecord(override)) return structuredClone(override);
	const merged: UnknownRecord = structuredClone(base);
	for (const [key, value] of Object.entries(override)) {
		merged[key] = key in merged ? mergeConfigValues(merged[key], value) : structuredClone(value);
	}
	return merged;
}

function expectString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) throw new HarnessError("CONFIG_INVALID", `${path} must be a non-empty string`);
	return value;
}

function expectInteger(value: unknown, path: string, minimum = 0): number {
	if (!Number.isInteger(value) || (value as number) < minimum) {
		throw new HarnessError("CONFIG_INVALID", `${path} must be an integer >= ${minimum}`);
	}
	return value as number;
}

function parseCandidate(value: unknown, path: string): ModelCandidateConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must be a mapping`);
	const effort = expectString(value.effort, `${path}.effort`) as HarnessEffort;
	if (!EFFORTS.has(effort)) throw new HarnessError("CONFIG_INVALID", `${path}.effort is unsupported`);
	return { model: expectString(value.model, `${path}.model`), effort };
}

function rejectUnknownKeys(value: UnknownRecord, allowed: Set<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown configuration field: ${path}.${key}`);
	}
}

function parseRole(value: unknown, path: string): RoleConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must be a mapping`);
	rejectUnknownKeys(value, ROLE_KEYS, path);
	const role: RoleConfig = {};
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
		if (workspace !== "repository" && workspace !== "worktree" && workspace !== "none") {
			throw new HarnessError("CONFIG_INVALID", `${path}.workspace is unsupported`);
		}
		role.workspace = workspace;
	}
	if (value.canDelegate !== undefined) {
		if (typeof value.canDelegate !== "boolean") throw new HarnessError("CONFIG_INVALID", `${path}.canDelegate must be boolean`);
		role.canDelegate = value.canDelegate;
	}
	if (value.completionSchema !== undefined) role.completionSchema = expectString(value.completionSchema, `${path}.completionSchema`);
	if (value.models !== undefined) {
		if (!Array.isArray(value.models)) throw new HarnessError("CONFIG_INVALID", `${path}.models must be an array`);
		role.models = value.models.map((item, index) => parseCandidate(item, `${path}.models[${index}]`));
	}
	return role;
}

export function validateHarnessConfig(value: unknown): HarnessConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", "Harness configuration must be a mapping");
	for (const key of Object.keys(value)) {
		if (!TOP_LEVEL_KEYS.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown top-level configuration field: ${key}`);
	}
	if (value.schemaVersion !== 1) throw new HarnessError("CONFIG_INVALID", "schemaVersion must be 1");
	if (!isRecord(value.models) || !isRecord(value.roles) || !isRecord(value.orchestrator) || !isRecord(value.limits)) {
		throw new HarnessError("CONFIG_INVALID", "models, roles, orchestrator, and limits must be mappings");
	}

	const models: Record<string, ModelAliasConfig> = {};
	for (const [alias, raw] of Object.entries(value.models)) {
		if (!isRecord(raw)) throw new HarnessError("CONFIG_INVALID", `models.${alias} must be a mapping`);
		rejectUnknownKeys(raw, MODEL_KEYS, `models.${alias}`);
		models[alias] = {
			provider: expectString(raw.provider, `models.${alias}.provider`),
			model: expectString(raw.model, `models.${alias}.model`),
			capabilityRank: expectInteger(raw.capabilityRank, `models.${alias}.capabilityRank`),
		};
	}

	const roles: Record<string, RoleConfig> = {};
	for (const [name, raw] of Object.entries(value.roles)) roles[name] = parseRole(raw, `roles.${name}`);

	rejectUnknownKeys(value.orchestrator, ORCHESTRATOR_KEYS, "orchestrator");
	rejectUnknownKeys(value.limits, LIMIT_KEYS, "limits");
	const switching = expectString(value.orchestrator.modelSwitching, "orchestrator.modelSwitching");
	if (switching !== "off" && switching !== "suggest" && switching !== "auto-visible") {
		throw new HarnessError("CONFIG_INVALID", "orchestrator.modelSwitching is unsupported");
	}

	return {
		schemaVersion: 1,
		models,
		roles,
		orchestrator: { modelSwitching: switching },
		limits: {
			maxConcurrency: expectInteger(value.limits.maxConcurrency, "limits.maxConcurrency", 1),
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
			merged = mergeConfigValues(merged, parsed);
			sources.push(source);
		} catch (error) {
			diagnostics.push({ level: "error", source, message: error instanceof Error ? error.message : String(error) });
		}
	}

	if (diagnostics.some((diagnostic) => diagnostic.level === "error")) {
		throw new HarnessError("CONFIG_INVALID", diagnostics.map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n"), {
			diagnostics,
		});
	}
	const config = validateHarnessConfig(merged);
	return { config, digest: digestConfig(config), sources, diagnostics };
}
