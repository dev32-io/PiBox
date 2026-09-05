import type { LoadedSubagentCatalog } from "./types.js";

const SPAWN_DESCRIPTION = "Launch one configured standalone subagent with a self-contained bounded assignment. Foreground waits and streams semantic progress. Background is for independent work: it returns immediately, steers terminal results into ongoing work, and wakes an idle parent.";

function compareNames(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Render the names and current descriptions from one loaded catalog. */
export function availableAgentCatalogDescription(catalog: LoadedSubagentCatalog): string {
	const entries = Object.entries(catalog.config.agents).sort(([left], [right]) => compareNames(left, right));
	if (entries.length === 0) return "No agents are currently configured.";
	return [
		"Available configured agents:",
		...entries.map(([name, config]) => config.description ? `- ${name}: ${config.description}` : `- ${name}`),
	].join("\n");
}

/** Build the complete dynamic description for the subagent_spawn tool. */
export function subagentSpawnToolDescription(catalog: LoadedSubagentCatalog): string {
	return `${SPAWN_DESCRIPTION}\n\n${availableAgentCatalogDescription(catalog)}`;
}
