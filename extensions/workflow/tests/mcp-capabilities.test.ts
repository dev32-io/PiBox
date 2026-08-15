import assert from "node:assert/strict";
import test from "node:test";
import { authorizeMcpProxyCall, configuredMcpServerAllowlist, mcpLaunchEnvironment, mcpServerAllowlist, PIBOX_ALLOWED_MCP_SERVERS_ENV } from "../mcp-capabilities.js";

test("derives a deduplicated MCP server allowlist from ordinary tool selectors", () => {
	const selectors = ["read", "mcp:playwright", "mcp:context7", "mcp:playwright"];
	assert.deepEqual(mcpServerAllowlist(selectors), ["playwright", "context7"]);
	assert.deepEqual(mcpLaunchEnvironment(selectors), { [PIBOX_ALLOWED_MCP_SERVERS_ENV]: "playwright,context7" });
	assert.deepEqual(configuredMcpServerAllowlist({ [PIBOX_ALLOWED_MCP_SERVERS_ENV]: "playwright, context7" } as NodeJS.ProcessEnv), ["playwright", "context7"]);
	assert.equal(configuredMcpServerAllowlist({} as NodeJS.ProcessEnv), undefined);
});

test("scopes single-server MCP proxy calls automatically", () => {
	const input: Record<string, unknown> = { search: "browser snapshot" };
	assert.equal(authorizeMcpProxyCall(input, ["playwright"]), undefined);
	assert.equal(input.server, "playwright");
	assert.equal(authorizeMcpProxyCall({ tool: "browser_navigate", server: "context7" }, ["playwright"])?.block, true);
});

test("requires an explicit server when an agent has multiple MCP capabilities", () => {
	const blocked = authorizeMcpProxyCall({ search: "docs" }, ["playwright", "context7"]);
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /Specify one allowed MCP server/);
	assert.equal(authorizeMcpProxyCall({ search: "docs", server: "context7" }, ["playwright", "context7"]), undefined);
});

test("blocks unscoped adapter surfaces that can cross server boundaries", () => {
	assert.equal(authorizeMcpProxyCall({ action: "ui-messages" }, ["playwright"])?.block, true);
	assert.equal(authorizeMcpProxyCall({ describe: "other_tool" }, ["playwright"])?.block, true);
});
