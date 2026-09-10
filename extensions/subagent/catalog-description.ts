import type { LoadedSubagentCatalog } from "./types.js";

const SPAWN_DESCRIPTION = [
	"Launch one configured standalone subagent with a self-contained bounded assignment. Foreground waits and streams semantic progress. Background is for independent work: it returns immediately, steers terminal results into ongoing work, and wakes an idle parent.",
	"Use the configured agent's default tier; normally omit tier. Ordinary implementation, multi-file integration, debugging, and review do not need an upward override. Use a higher tier only for complex architecture/design or unusually demanding reasoning; briefly explain the task-specific need and why the default is insufficient. Failed attempts do not by themselves justify escalation. Max is a very rare exception; explain why High is insufficient and the expected benefit. Nuke profiles upgrade routed models, not task tiers.",
	"A configured agent model takes precedence over its default or requested tier; only an explicit model override replaces it. A local-llm model requires tier local, so up/down tier overrides do not apply while that model is selected. Existing strict explicit-model, fallback, and local-isolation semantics still apply.",
].join("\n\n");

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Render the names and current descriptions from one loaded catalog. */
export function availableAgentCatalogDescription(catalog: LoadedSubagentCatalog): string {
	const entries = Object.entries(catalog.config.agents).sort(([left], [right]) => compareNames(left, right));
	if (entries.length === 0) return "No agents are currently configured.";
	return [
		"Available configured agents:",
		...entries.map(([name, config]) => {
			const localPinned = config.model?.trim().startsWith("local-llm/") === true;
			const routing = `default tier: ${localPinned ? "local" : config.tier ?? "medium"}${config.model ? "; configured model takes precedence" : ""}`;
			return config.description ? `- ${name} [${routing}]: ${config.description}` : `- ${name} [${routing}]`;
		}),
	].join("\n");
}

/** Build the complete dynamic description for the subagent_spawn tool. */
export function subagentSpawnToolDescription(catalog: LoadedSubagentCatalog): string {
	return `${SPAWN_DESCRIPTION}\n\n${availableAgentCatalogDescription(catalog)}`;
}
