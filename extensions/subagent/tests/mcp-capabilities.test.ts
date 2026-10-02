import assert from "node:assert/strict";
import test from "node:test";
import { mcpLaunchEnvironment, parseMcpToolSelector, PIBOX_MCP_ENABLED_ENV, resolveMcpTools } from "../mcp-capabilities.js";

const registry = [
	{ name: "read" }, { name: "unrelated_extension" }, { name: "codemode" }, { name: "tool_search" },
	{ name: "mcp__one__hashed", namespace: { name: "mcp__one" } },
	{ name: "mcp__two__echo", namespace: { name: "mcp__two" } },
	{ name: "list_mcp_resources" }, { name: "list_mcp_resource_templates" }, { name: "read_mcp_resource" },
];

test("binary grant expands only MCP, shared resources and discovery, not unrelated tools", () => {
	assert.deepEqual(resolveMcpTools(["read", "mcp", "read"], registry), ["read", ...registry.slice(2).map((tool) => tool.name)]);
	assert.deepEqual(mcpLaunchEnvironment(["mcp"]), { [PIBOX_MCP_ENABLED_ENV]: "1" });
	assert.deepEqual(mcpLaunchEnvironment(["*"]), { [PIBOX_MCP_ENABLED_ENV]: "1" });
	assert.deepEqual(mcpLaunchEnvironment(["read"]), { [PIBOX_MCP_ENABLED_ENV]: "0" });
});

test("omission removes MCP even when exact native/resource names are listed; ordinary codemode remains", () => {
	assert.deepEqual(resolveMcpTools(["read", "codemode", "mcp__two__echo", "read_mcp_resource", "mcpScript"], registry), ["read", "codemode"]);
	assert.deepEqual(resolveMcpTools(["read", "mcp"], []), ["read"], "missing optional servers degrade gracefully");
	assert.deepEqual(resolveMcpTools(["read", "mcp"], [{ name: "mcp" }, { name: "mcpScript" }, { name: "other" }]), ["read", "mcp"], "transitional adapter gateway is all-or-none");
});

test("snapshot bounds late tools; wildcard stays wildcard; obsolete selectors always fail", () => {
	const before = resolveMcpTools(["mcp"], registry);
	const later = [...registry, { name: "mcp__one__late", namespace: { name: "mcp__one" } }];
	assert.ok(!before.includes("mcp__one__late"));
	assert.ok(resolveMcpTools(["mcp"], later).includes("mcp__one__late"));
	assert.deepEqual(resolveMcpTools(["*"], later), ["*"]);
	for (const selector of ["mcp:", "mcp:playwright"]) {
		assert.throws(() => parseMcpToolSelector(selector), /Obsolete MCP selector.*replace mcp:<server> with mcp/);
		assert.throws(() => resolveMcpTools(["*", selector], registry), /Obsolete MCP selector/);
	}
});
