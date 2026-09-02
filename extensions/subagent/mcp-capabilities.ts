export const ALL_TOOLS_SELECTOR = "*";
export const MCP_TOOL_SELECTOR_PREFIX = "mcp:";
export const PIBOX_ALLOWED_MCP_SERVERS_ENV = "PIBOX_ALLOWED_MCP_SERVERS";

export function parseMcpToolSelector(selector: string): string | undefined {
	if (!selector.startsWith(MCP_TOOL_SELECTOR_PREFIX)) return undefined;
	const server = selector.slice(MCP_TOOL_SELECTOR_PREFIX.length).trim();
	if (!server || server.includes("/")) throw new Error("MCP tool selectors must use mcp:<server>");
	return server;
}

export function mcpServerAllowlist(selectors: readonly string[]): string[] {
	return [...new Set(selectors.map(parseMcpToolSelector).filter((server): server is string => Boolean(server)))];
}

export function mcpLaunchEnvironment(selectors: readonly string[]): Record<string, string> {
	if (selectors.includes(ALL_TOOLS_SELECTOR)) return {};
	const servers = mcpServerAllowlist(selectors);
	return servers.length > 0 ? { [PIBOX_ALLOWED_MCP_SERVERS_ENV]: servers.join(",") } : {};
}

export function configuredMcpServerAllowlist(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const value = env[PIBOX_ALLOWED_MCP_SERVERS_ENV];
	if (value === undefined) return undefined;
	return [...new Set(value.split(",").map((server) => server.trim()).filter(Boolean))];
}

export function authorizeMcpProxyCall(input: Record<string, unknown>, allowedServers: readonly string[]): { block: true; reason: string } | undefined {
	if (allowedServers.length === 0) return { block: true, reason: "This agent was not granted an MCP server." };
	if (input.action === "ui-messages") return { block: true, reason: "Restricted agents cannot read cross-server MCP UI messages." };
	if (typeof input.describe === "string") return { block: true, reason: "Use an MCP search scoped with `server` and `includeSchemas` instead of an unscoped describe call." };

	const explicitServers = [input.server, input.connect, input.instructions].filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
	for (const server of explicitServers) {
		if (!allowedServers.includes(server)) return { block: true, reason: `MCP server '${server}' is not allowed for this agent. Allowed: ${allowedServers.join(", ")}.` };
	}
	if (explicitServers.length === 0) {
		if (allowedServers.length !== 1) return { block: true, reason: `Specify one allowed MCP server with the server field: ${allowedServers.join(", ")}.` };
		input.server = allowedServers[0];
	}
	return undefined;
}
