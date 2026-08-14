import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, CapabilityTier, ConfigDiagnostic } from "./types.js";
import { validateToolSelectors } from "./tool-groups.js";

const TIERS = new Set<CapabilityTier>(["low", "medium", "high", "max"]);

type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	tier?: unknown;
};

function toolList(value: unknown): string[] | undefined {
	if (value === undefined) return undefined;
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
	if (!raw || raw.some((tool) => typeof tool !== "string")) throw new Error("tools must be a comma-separated string or string array");
	const tools = raw.map((tool) => tool.trim()).filter(Boolean);
	if (tools.length === 0) throw new Error("tools must contain at least one tool");
	validateToolSelectors(tools);
	return tools;
}

export function discoverAgentDefinitions(
	directory: string,
	options: { defaultTier?: CapabilityTier } = {},
): { agents: Record<string, AgentConfig>; diagnostics: ConfigDiagnostic[] } {
	const agents: Record<string, AgentConfig> = {};
	const diagnostics: ConfigDiagnostic[] = [];
	let entries;
	try { entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
	catch { return { agents, diagnostics }; }

	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
		const source = join(directory, entry.name);
		try {
			const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(readFileSync(source, "utf8"));
			if (typeof frontmatter.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(frontmatter.name)) throw new Error("name must be a lowercase kebab-case identifier");
			if (typeof frontmatter.description !== "string" || !frontmatter.description.trim() || frontmatter.description.length > 240) throw new Error("description must be a non-empty string of at most 240 characters");
			if (!body.trim()) throw new Error("agent prompt body must not be empty");
			if (frontmatter.model !== undefined && (typeof frontmatter.model !== "string" || !frontmatter.model.trim())) throw new Error("model must be a non-empty string");
			if (frontmatter.tier !== undefined && (typeof frontmatter.tier !== "string" || !TIERS.has(frontmatter.tier as CapabilityTier))) throw new Error("tier must be one of low, medium, high, or max");
			const tools = toolList(frontmatter.tools);
			if (agents[frontmatter.name]) throw new Error(`duplicate agent name: ${frontmatter.name}`);
			agents[frontmatter.name] = {
				description: frontmatter.description.trim().replace(/\s+/g, " "),
				prompt: source,
				tier: (frontmatter.tier as CapabilityTier | undefined) ?? options.defaultTier ?? "medium",
				workspace: "repository",
				canDelegate: false,
				...(tools ? { tools } : {}),
				...(typeof frontmatter.model === "string" ? { model: frontmatter.model.trim() } : {}),
			};
		} catch (error) {
			diagnostics.push({ level: "warning", source, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return { agents, diagnostics };
}

/** Discover trusted repository-local Pi agents. */
export function discoverProjectAgents(repositoryRoot: string): { agents: Record<string, AgentConfig>; diagnostics: ConfigDiagnostic[] } {
	return discoverAgentDefinitions(join(repositoryRoot, ".pi", "agents"));
}
