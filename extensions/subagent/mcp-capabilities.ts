export const ALL_TOOLS_SELECTOR = "*";
export const PIBOX_MCP_ENABLED_ENV = "PIBOX_MCP_ENABLED";
export const MCP_RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"] as const;

export interface CapabilityTool {
	name: string;
	namespace?: { name: string };
}

export function parseMcpToolSelector(selector: string): boolean {
	if (selector.startsWith("mcp:")) throw new Error(`Obsolete MCP selector '${selector}': replace mcp:<server> with mcp (all configured MCP tools and resources), or omit MCP entirely.`);
	return selector === "mcp";
}

export function mcpEnabled(selectors: readonly string[]): boolean {
	for (const selector of selectors) parseMcpToolSelector(selector);
	return selectors.includes(ALL_TOOLS_SELECTOR) || selectors.includes("mcp");
}

export function mcpLaunchEnvironment(selectors: readonly string[]): Record<string, string> {
	return { [PIBOX_MCP_ENABLED_ENV]: mcpEnabled(selectors) ? "1" : "0" };
}

/** Names classify capability only; never reconstruct permission identity from mangled names. */
export function isMcpTool(tool: CapabilityTool): boolean {
	return tool.name === "mcp" || tool.name === "mcpScript" || tool.namespace?.name.startsWith("mcp__") === true
		|| tool.name.startsWith("mcp__") || (MCP_RESOURCE_TOOLS as readonly string[]).includes(tool.name);
}

/** Called at launch after awaitNativeMcpReady; Pi 0.99.2 first prompts do not await indirect servers. */
export function resolveMcpTools(selectors: readonly string[], registry: readonly CapabilityTool[]): string[] {
	const enabled = mcpEnabled(selectors);
	if (selectors.includes(ALL_TOOLS_SELECTOR)) return [...selectors];
	const mcpNames = new Set(registry.filter(isMcpTool).map((tool) => tool.name));
	const ordinary = selectors.filter((name) => !isMcpTool({ name }) && !mcpNames.has(name));
	// Transitional adapter support stays on its existing mcp gateway, not its opaque script runner.
	// Exact native registry snapshot fails closed for later registrations until a fresh launch.
	return [...new Set([...ordinary, ...(enabled ? registry.filter((tool) => (isMcpTool(tool) && tool.name !== "mcpScript") || tool.name === "codemode" || tool.name === "tool_search").map((tool) => tool.name) : [])])];
}
