import { ALL_TOOLS_SELECTOR, parseMcpToolSelector } from "./mcp-capabilities.js";

export { ALL_TOOLS_SELECTOR } from "./mcp-capabilities.js";
export { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE, isSubagentRuntime } from "../core/runtime-role.js";

/** Conventional Pi tools available when an agent definition omits a tool list. */
export const DEFAULT_SUBAGENT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
/** Marks a wildcard launch so the child can restore all extension tools before exclusions. */
export const ALL_TOOLS_SUBAGENT_ENV = "PIBOX_SUBAGENT_ALL_TOOLS";
/** Recursive child controls are never inherited by a spawned agent. */
export const SUBAGENT_CONTROL_TOOLS = ["subagent_spawn", "subagent_status", "subagent_control", "subagent_continue"] as const;
export const RECURSIVE_SUBAGENT_CONTROL_EXCLUSIONS = SUBAGENT_CONTROL_TOOLS;

export function validateSubagentToolSelectors(selectors: readonly string[]): void {
	for (const selector of selectors) {
		if (!selector.trim()) throw new Error("tool selectors must be non-empty strings");
		parseMcpToolSelector(selector);
	}
}

/** Resolve generic selectors without knowledge of workflow-owned tool groups. */
export function resolveSubagentToolSelectors(selectors: readonly string[]): string[] {
	validateSubagentToolSelectors(selectors);
	const resolved: string[] = [];
	for (const selector of selectors) {
		const tools = parseMcpToolSelector(selector) ? ["mcp"] : [selector];
		for (const tool of tools) if (!resolved.includes(tool)) resolved.push(tool);
	}
	return resolved;
}

export function usesAllTools(selectors: readonly string[]): boolean {
	return selectors.includes(ALL_TOOLS_SELECTOR);
}
