import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import e2eWorkspaceExtension from "../index.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../core/runtime-role.js";
import { PIBOX_SUBAGENT_AGENT_ENV } from "../../subagent/invocation.js";

function registered(env: Record<string, string | undefined>): string[] {
	const previous = { role: process.env[PIBOX_RUNTIME_ROLE_ENV], agent: process.env[PIBOX_SUBAGENT_AGENT_ENV] };
	for (const [key, value] of Object.entries(env)) value === undefined ? delete process.env[key] : process.env[key] = value;
	const tools: string[] = [];
	try { e2eWorkspaceExtension({ registerTool(tool: { name: string }) { tools.push(tool.name); }, on() {} } as unknown as ExtensionAPI); }
	finally {
		previous.role === undefined ? delete process.env[PIBOX_RUNTIME_ROLE_ENV] : process.env[PIBOX_RUNTIME_ROLE_ENV] = previous.role;
		previous.agent === undefined ? delete process.env[PIBOX_SUBAGENT_AGENT_ENV] : process.env[PIBOX_SUBAGENT_AGENT_ENV] = previous.agent;
	}
	return tools;
}

test("capability registers only for trusted e2e-tester child identity", () => {
	assert.deepEqual(registered({ [PIBOX_RUNTIME_ROLE_ENV]: undefined, [PIBOX_SUBAGENT_AGENT_ENV]: "e2e-tester" }), []);
	assert.deepEqual(registered({ [PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE, [PIBOX_SUBAGENT_AGENT_ENV]: "general-purpose" }), []);
	assert.deepEqual(registered({ [PIBOX_RUNTIME_ROLE_ENV]: PIBOX_SUBAGENT_RUNTIME_ROLE, [PIBOX_SUBAGENT_AGENT_ENV]: "e2e-tester" }), ["e2e_workspace"]);
});

test("same child session restores workspace; missing saved storage reports continuity loss before replacement", async (t) => {
	const oldRole = process.env[PIBOX_RUNTIME_ROLE_ENV]; const oldAgent = process.env[PIBOX_SUBAGENT_AGENT_ENV];
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE; process.env[PIBOX_SUBAGENT_AGENT_ENV] = "e2e-tester";
	t.after(() => { oldRole === undefined ? delete process.env[PIBOX_RUNTIME_ROLE_ENV] : process.env[PIBOX_RUNTIME_ROLE_ENV] = oldRole; oldAgent === undefined ? delete process.env[PIBOX_SUBAGENT_AGENT_ENV] : process.env[PIBOX_SUBAGENT_AGENT_ENV] = oldAgent; });
	const entries: any[] = [];
	const host = () => {
		const tools = new Map<string, any>(); const handlers = new Map<string, any>();
		const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: any) { handlers.set(name, handler); }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		e2eWorkspaceExtension(pi);
		const ctx = { sessionManager: { getSessionId: () => "session-one", getBranch: () => entries, getEntries: () => entries } } as any;
		return { tools, handlers, ctx };
	};
	const first = host(); first.handlers.get("session_start")({}, first.ctx);
	const initialized = await first.tools.get("e2e_workspace").execute("init", { action: "init" });
	const workspaceId = initialized.details.workspaceId; const firstRun = initialized.details.runId;
	t.after(() => rm(`/tmp/pibox-e2e-workspace-${workspaceId}`, { recursive: true, force: true }));
	first.handlers.get("session_shutdown")();
	const continued = host(); continued.handlers.get("session_start")({}, continued.ctx);
	const restored = await continued.tools.get("e2e_workspace").execute("init", { action: "init" });
	assert.equal(restored.details.workspaceId, workspaceId);
	assert.notEqual(restored.details.runId, firstRun);
	continued.handlers.get("session_shutdown")();
	await rm(`/tmp/pibox-e2e-workspace-${workspaceId}`, { recursive: true, force: true });
	const replacedHost = host(); replacedHost.handlers.get("session_start")({}, replacedHost.ctx);
	const replaced = await replacedHost.tools.get("e2e_workspace").execute("init", { action: "init" });
	assert.equal(replaced.details.continuityLost, true);
	assert.notEqual(replaced.details.workspaceId, workspaceId);
	assert.match(replaced.content[0].text, /continuity was lost.*Fresh workspace created/s);
	t.after(() => rm(`/tmp/pibox-e2e-workspace-${replaced.details.workspaceId}`, { recursive: true, force: true }));
});
