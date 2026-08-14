/**
 * Namespaced tool selectors keep harness capabilities out of launch-site lists.
 * Agent definitions may use these selectors directly; managed workflows may add
 * a selector at runtime before the concrete Pi tool list is resolved.
 */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export const PIBOX_TOOL_GROUPS = {
	"pibox:task": ["task_clarify", "task_checkpoint", "task_request_change", "task_report_decision", "task_blocked", "task_complete"],
	"pibox:evaluation": ["evaluation_context", "evidence_record", "finding_report", "evaluation_checkpoint", "evaluation_complete"],
} as const satisfies Record<string, readonly string[]>;

export type PiBoxToolGroup = keyof typeof PIBOX_TOOL_GROUPS;
export const PIBOX_TASK_TOOL_GROUP: PiBoxToolGroup = "pibox:task";
export const PIBOX_EVALUATION_TOOL_GROUP: PiBoxToolGroup = "pibox:evaluation";

export function validateToolSelectors(selectors: readonly string[]): void {
	for (const selector of selectors) {
		if (!selector.trim()) throw new Error("tool selectors must be non-empty strings");
		if (selector.startsWith("pibox:") && !(selector in PIBOX_TOOL_GROUPS)) throw new Error(`Unknown PiBox tool group: ${selector}`);
	}
}

export function resolveToolSelectors(selectors: readonly string[], runtimeGroups: readonly PiBoxToolGroup[] = []): string[] {
	const combined = [...selectors, ...runtimeGroups];
	validateToolSelectors(combined);
	const resolved: string[] = [];
	for (const selector of combined) {
		const tools = selector in PIBOX_TOOL_GROUPS ? PIBOX_TOOL_GROUPS[selector as PiBoxToolGroup] : [selector];
		for (const tool of tools) if (!resolved.includes(tool)) resolved.push(tool);
	}
	return resolved;
}
