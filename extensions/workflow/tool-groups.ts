import {
	resolveSubagentToolSelectors,
	validateSubagentToolSelectors,
} from "../subagent/tool-policy.js";

export {
	ALL_TOOLS_SELECTOR,
	ALL_TOOLS_SUBAGENT_ENV,
	DEFAULT_SUBAGENT_TOOLS,
	RECURSIVE_SUBAGENT_CONTROL_EXCLUSIONS,
	SUBAGENT_CONTROL_TOOLS,
	usesAllTools,
} from "../subagent/tool-policy.js";

/** Workflow-only capability groups appended to generic agent tool policy. */
export const PIBOX_TOOL_GROUPS = {
	"pibox:task": ["task_clarify", "task_checkpoint", "task_request_change", "task_report_decision", "task_blocked", "task_complete"],
	"pibox:evaluation": ["evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete"],
	"pibox:ledger": ["workflow_ledger"],
} as const satisfies Record<string, readonly string[]>;

export type PiBoxToolGroup = keyof typeof PIBOX_TOOL_GROUPS;
export const PIBOX_TASK_TOOL_GROUP: PiBoxToolGroup = "pibox:task";
export const PIBOX_EVALUATION_TOOL_GROUP: PiBoxToolGroup = "pibox:evaluation";
export const PIBOX_LEDGER_TOOL_GROUP: PiBoxToolGroup = "pibox:ledger";

export function validateToolSelectors(selectors: readonly string[]): void {
	validateSubagentToolSelectors(selectors);
	for (const selector of selectors) {
		if (selector.startsWith("pibox:") && !(selector in PIBOX_TOOL_GROUPS)) throw new Error(`Unknown PiBox tool group: ${selector}`);
	}
}

export function resolveToolSelectors(selectors: readonly string[], runtimeGroups: readonly PiBoxToolGroup[] = []): string[] {
	const combined = [...selectors, ...runtimeGroups];
	validateToolSelectors(combined);
	const resolved: string[] = [];
	for (const selector of combined) {
		const tools = selector in PIBOX_TOOL_GROUPS
			? PIBOX_TOOL_GROUPS[selector as PiBoxToolGroup]
			: resolveSubagentToolSelectors([selector]);
		for (const tool of tools) if (!resolved.includes(tool)) resolved.push(tool);
	}
	return resolved;
}
