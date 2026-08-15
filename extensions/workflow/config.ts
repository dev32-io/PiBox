import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { HarnessError } from "./errors.js";
import type {
	CapabilityTier,
	ConfigDiagnostic,
	HarnessConfig,
	HarnessEffort,
	LoadedHarnessConfig,
	AgentConfig,
	TierModelRouteConfig,
} from "./types.js";
import { discoverAgentDefinitions, discoverProjectAgents } from "./agent-definitions.js";
import { BUILT_IN_AGENT_ROOT } from "./prompt-loader.js";
import { validateToolSelectors } from "./tool-groups.js";

const EFFORTS = new Set<HarnessEffort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TIERS: CapabilityTier[] = ["low", "medium", "high", "max"];
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "modelTiers", "agents", "roles", "orchestrator", "limits"]);
const ROUTE_KEYS = new Set(["provider", "model", "effort"]);
const AGENT_KEYS = new Set(["extends", "description", "prompt", "skills", "tools", "model", "workspace", "canDelegate", "completionSchema", "tier", "deliberation"]); // deliberation is accepted only for legacy policy compatibility
const ORCHESTRATOR_KEYS = new Set(["modelSwitching"]);
const LIMIT_KEYS = new Set(["maxConcurrency", "maxActiveSubagentsPerSession", "maxSubagentDepth", "protocolNudges", "repairRounds"]);

const builtInAgentDefinitions = discoverAgentDefinitions(BUILT_IN_AGENT_ROOT);
if (builtInAgentDefinitions.diagnostics.length > 0) throw new Error(`Invalid built-in agent definitions:\n${builtInAgentDefinitions.diagnostics.map((diagnostic) => `${diagnostic.source}: ${diagnostic.message}`).join("\n")}`);

export const DEFAULT_HARNESS_CONFIG: HarnessConfig = {
	schemaVersion: 2,
	modelTiers: {
		max: ["openai-codex/gpt-5.6-sol#high"],
		high: ["openai-codex/gpt-5.6-sol#medium"],
		medium: ["openai-codex/gpt-5.6-luna#max"],
		low: ["openai-codex/gpt-5.6-luna#medium"],
	},
	agents: {
		...builtInAgentDefinitions.agents,
		implementer: { ...builtInAgentDefinitions.agents.implementer!, completionSchema: "implementer-v1" },
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

/** Agent tool allowlists belong to agent-definition frontmatter, never harness policy. */
function ignoreHarnessAgentTools(value: UnknownRecord): void {
	for (const key of ["agents", "roles"] as const) {
		const agents = value[key];
		if (!isRecord(agents)) continue;
		for (const agent of Object.values(agents)) if (isRecord(agent)) delete agent.tools;
	}
}

function parseRoute(value: unknown, path: string): TierModelRouteConfig {
	if (typeof value === "string") {
		const separator = value.lastIndexOf("#");
		const providerSeparator = value.indexOf("/");
		if (separator <= providerSeparator || providerSeparator <= 0 || separator === value.length - 1) throw new HarnessError("CONFIG_INVALID", `${path} must use provider/model#effort`);
		const effort = expectEffort(value.slice(separator + 1), `${path} effort`);
		return `${value.slice(0, separator)}#${effort}`;
	}
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must use provider/model#effort`);
	// Normalize the previous mapping form so existing repository policies remain loadable.
	rejectUnknownKeys(value, ROUTE_KEYS, path);
	const provider = expectString(value.provider, `${path}.provider`);
	const model = expectString(value.model, `${path}.model`);
	const legacyEffort = isRecord(value.effort) ? value.effort.standard : value.effort;
	return `${provider}/${model}#${expectEffort(legacyEffort, `${path}.effort`)}`;
}

function parseAgent(value: unknown, path: string): AgentConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", `${path} must be a mapping`);
	rejectUnknownKeys(value, AGENT_KEYS, path);
	const agent: AgentConfig = {};
	if (value.extends !== undefined) agent.extends = expectString(value.extends, `${path}.extends`);
	if (value.description !== undefined) agent.description = expectString(value.description, `${path}.description`);
	if (value.prompt !== undefined) agent.prompt = expectString(value.prompt, `${path}.prompt`);
	if (value.skills !== undefined) {
		if (!Array.isArray(value.skills)) throw new HarnessError("CONFIG_INVALID", `${path}.skills must be an array`);
		agent.skills = value.skills.map((item, index) => expectString(item, `${path}.skills[${index}]`));
	}
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools)) throw new HarnessError("CONFIG_INVALID", `${path}.tools must be an array`);
		agent.tools = value.tools.map((item, index) => expectString(item, `${path}.tools[${index}]`));
		try { validateToolSelectors(agent.tools); } catch (error) { throw new HarnessError("CONFIG_INVALID", `${path}.tools: ${error instanceof Error ? error.message : String(error)}`); }
	}
	if (value.model !== undefined) agent.model = expectString(value.model, `${path}.model`);
	if (value.workspace !== undefined) {
		const workspace = expectString(value.workspace, `${path}.workspace`);
		if (workspace !== "repository" && workspace !== "worktree" && workspace !== "none") throw new HarnessError("CONFIG_INVALID", `${path}.workspace is unsupported`);
		agent.workspace = workspace;
	}
	if (value.canDelegate !== undefined) {
		if (typeof value.canDelegate !== "boolean") throw new HarnessError("CONFIG_INVALID", `${path}.canDelegate must be boolean`);
		agent.canDelegate = value.canDelegate;
	}
	if (value.completionSchema !== undefined) agent.completionSchema = expectString(value.completionSchema, `${path}.completionSchema`);
	if (value.tier !== undefined) {
		const tier = expectString(value.tier, `${path}.tier`) as CapabilityTier;
		if (!TIERS.includes(tier)) throw new HarnessError("CONFIG_INVALID", `${path}.tier is unsupported`);
		agent.tier = tier;
	}
	if (value.deliberation !== undefined && !["standard", "deep"].includes(expectString(value.deliberation, `${path}.deliberation`))) throw new HarnessError("CONFIG_INVALID", `${path}.deliberation is unsupported`);
	return agent;
}

export function validateHarnessConfig(value: unknown): HarnessConfig {
	if (!isRecord(value)) throw new HarnessError("CONFIG_INVALID", "Workflow configuration must be a mapping");
	for (const key of Object.keys(value)) if (!TOP_LEVEL_KEYS.has(key)) throw new HarnessError("CONFIG_INVALID", `Unknown top-level configuration field: ${key}`);
	if (value.schemaVersion !== 2) throw new HarnessError("CONFIG_INVALID", "schemaVersion must be 2; migrate model aliases to modelTiers and roles to agents");
	const rawAgents = isRecord(value.agents) ? value.agents : value.roles;
	if (!isRecord(value.modelTiers) || !isRecord(rawAgents) || !isRecord(value.orchestrator) || !isRecord(value.limits)) throw new HarnessError("CONFIG_INVALID", "modelTiers, agents, orchestrator, and limits must be mappings");

	const modelTiers = {} as Record<CapabilityTier, TierModelRouteConfig[]>;
	for (const tier of TIERS) {
		const raw = value.modelTiers[tier];
		if (!Array.isArray(raw) || raw.length === 0) throw new HarnessError("CONFIG_INVALID", `modelTiers.${tier} must be a non-empty array`);
		modelTiers[tier] = raw.map((route, index) => parseRoute(route, `modelTiers.${tier}[${index}]`));
	}
	for (const tier of Object.keys(value.modelTiers)) if (!TIERS.includes(tier as CapabilityTier)) throw new HarnessError("CONFIG_INVALID", `Unknown model tier: ${tier}`);

	const parsedAgents: Record<string, AgentConfig> = {};
	for (const [name, raw] of Object.entries(rawAgents)) parsedAgents[name] = parseAgent(raw, `agents.${name}`);
	const agents: Record<string, AgentConfig> = {};
	const resolveAgent = (name: string, stack: string[] = []): AgentConfig => {
		if (agents[name]) return agents[name];
		const agent = parsedAgents[name];
		if (!agent) throw new HarnessError("CONFIG_INVALID", `Unknown extended agent: ${name}`);
		if (stack.includes(name)) throw new HarnessError("CONFIG_INVALID", `Agent inheritance cycle: ${[...stack, name].join(" -> ")}`);
		const parent = agent.extends ? resolveAgent(agent.extends, [...stack, name]) : {};
		const resolved = mergeConfigValues(parent, agent) as AgentConfig;
		delete resolved.extends;
		if (!resolved.tier) throw new HarnessError("CONFIG_INVALID", `Agent ${name} must resolve a tier default`);
		agents[name] = resolved;
		return resolved;
	};
	for (const name of Object.keys(parsedAgents)) resolveAgent(name);

	rejectUnknownKeys(value.orchestrator, ORCHESTRATOR_KEYS, "orchestrator");
	rejectUnknownKeys(value.limits, LIMIT_KEYS, "limits");
	const switching = expectString(value.orchestrator.modelSwitching, "orchestrator.modelSwitching");
	if (switching !== "off" && switching !== "suggest" && switching !== "auto-visible") throw new HarnessError("CONFIG_INVALID", "orchestrator.modelSwitching is unsupported");

	return {
		schemaVersion: 2,
		modelTiers,
		agents,
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
	const config = validateHarnessConfig(merged);
	const projectAgents = discoverProjectAgents(repositoryRoot);
	for (const [name, definition] of Object.entries(projectAgents.agents)) config.agents[name] = definition;
	diagnostics.push(...projectAgents.diagnostics);
	if (Object.keys(projectAgents.agents).length > 0) sources.push(join(repositoryRoot, ".pi", "agents"));
	return { config, digest: digestConfig(config), sources, diagnostics };
}
