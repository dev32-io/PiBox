import { resolveSubagentToolSelectors, validateSubagentToolSelectors } from "../subagent/tool-policy.js";

export {
	ALL_TOOLS_SELECTOR,
	ALL_TOOLS_SUBAGENT_ENV,
	DEFAULT_SUBAGENT_TOOLS,
	RECURSIVE_SUBAGENT_CONTROL_EXCLUSIONS,
	SUBAGENT_CONTROL_TOOLS,
	usesAllTools,
} from "../subagent/tool-policy.js";

/** Agent definitions remain generic. Managed target task launches add task_clarify directly. */
export function validateToolSelectors(selectors: readonly string[]): void {
	validateSubagentToolSelectors(selectors);
	for (const selector of selectors) if (selector.startsWith("pibox:")) throw new Error(`Obsolete PiBox tool group: ${selector}`);
}

export function resolveToolSelectors(selectors: readonly string[]): string[] {
	validateToolSelectors(selectors);
	const resolved: string[] = [];
	for (const selector of selectors) for (const tool of resolveSubagentToolSelectors([selector])) if (!resolved.includes(tool)) resolved.push(tool);
	return resolved;
}
