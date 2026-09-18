import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import e2eWorkspaceExtension from "../index.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../core/runtime-role.js";
import { PIBOX_SUBAGENT_AGENT_ENV } from "../../subagent/invocation.js";

function on(handlers: Map<string, any>, name: string, handler: any) {
	const previous = handlers.get(name);
	handlers.set(name, async (...args: any[]) => { await previous?.(...args); return handler(...args); });
}

async function request(handlers: Map<string, any>, ctx: any, messages: any[] = [{ role: "user", content: "continue" }]) {
	ctx.model = { api: "openai-completions" };
	const context = await handlers.get("context")({ messages }, ctx);
	const payload = { messages: [{ role: "system", content: "E2E AGENT INSTRUCTIONS" }, ...context.messages.map((message: any) => ({ ...message, role: message.role === "custom" ? "user" : message.role }))] };
	const result = await handlers.get("before_provider_request")({ payload }, ctx);
	return { system: result.messages[0].content as string, messages: result.messages.slice(1) };
}

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
		const pi = { registerTool(tool: any) { tools.set(tool.name, tool); }, on(name: string, handler: any) { on(handlers, name, handler); }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		e2eWorkspaceExtension(pi);
		const ctx = { sessionManager: { getSessionId: () => "session-one", getBranch: () => entries, getEntries: () => entries } } as any;
		return { tools, handlers, ctx };
	};
	const first = host(); await first.handlers.get("session_start")({}, first.ctx);
	const beforeInit = await request(first.handlers, first.ctx);
	assert.match(beforeInit.system, /No E2E workspace exists/);
	assert.equal(entries.length, 0, "system rendering never initializes evaluation storage");
	assert.doesNotMatch(beforeInit.system, /PiBox Orchestrator Mode/);
	const initialized = await first.tools.get("e2e_workspace").execute("init", { action: "init" });
	const workspaceId = initialized.details.workspaceId; const firstRun = initialized.details.runId;
	const ready = await request(first.handlers, first.ctx);
	assert.ok(ready.system.includes(initialized.details.outputDirectory));
	assert.match(ready.system, /^E2E AGENT INSTRUCTIONS[\s\S]+Output directory:/);
	assert.deepEqual(ready.messages, [{ role: "user", content: "continue" }]);
	assert.equal((await request(first.handlers, first.ctx, [{ role: "compactionSummary", summary: "Evaluation pending" }])).system, ready.system);
	t.after(() => rm(`/tmp/pibox-e2e-workspace-${workspaceId}`, { recursive: true, force: true }));
	await first.handlers.get("session_shutdown")({}, first.ctx);
	const continued = host(); await continued.handlers.get("session_start")({}, continued.ctx);
	assert.match((await request(continued.handlers, continued.ctx)).system, /Call e2e_workspace init to begin/);
	assert.ok(!(await request(continued.handlers, continued.ctx)).system.includes(initialized.details.outputDirectory));
	const restored = await continued.tools.get("e2e_workspace").execute("init", { action: "init" });
	assert.equal(restored.details.workspaceId, workspaceId);
	assert.notEqual(restored.details.runId, firstRun);
	await continued.handlers.get("session_shutdown")({}, continued.ctx);
	await rm(`/tmp/pibox-e2e-workspace-${workspaceId}`, { recursive: true, force: true });
	const replacedHost = host(); await replacedHost.handlers.get("session_start")({}, replacedHost.ctx);
	const replaced = await replacedHost.tools.get("e2e_workspace").execute("init", { action: "init" });
	assert.equal(replaced.details.continuityLost, true);
	assert.notEqual(replaced.details.workspaceId, workspaceId);
	assert.match(replaced.content[0].text, /continuity was lost.*Fresh workspace created/s);
	t.after(() => rm(`/tmp/pibox-e2e-workspace-${replaced.details.workspaceId}`, { recursive: true, force: true }));
	await replacedHost.handlers.get("session_shutdown")({}, replacedHost.ctx);
});

test("live deletion clears cached E2E evaluation before explicit workspace replacement", async (t) => {
	const oldRole = process.env[PIBOX_RUNTIME_ROLE_ENV];
	const oldAgent = process.env[PIBOX_SUBAGENT_AGENT_ENV];
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
	process.env[PIBOX_SUBAGENT_AGENT_ENV] = "e2e-tester";
	t.after(() => {
		oldRole === undefined ? delete process.env[PIBOX_RUNTIME_ROLE_ENV] : process.env[PIBOX_RUNTIME_ROLE_ENV] = oldRole;
		oldAgent === undefined ? delete process.env[PIBOX_SUBAGENT_AGENT_ENV] : process.env[PIBOX_SUBAGENT_AGENT_ENV] = oldAgent;
	});
	const entries: any[] = [];
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	e2eWorkspaceExtension({
		registerTool(tool: any) { tools.set(tool.name, tool); },
		on(name: string, handler: any) { on(handlers, name, handler); },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI);
	const ctx = { sessionManager: { getSessionId: () => "live-e2e", getBranch: () => entries } } as any;
	await handlers.get("session_start")({}, ctx);
	const tool = tools.get("e2e_workspace");
	const initial = await tool.execute("init", { action: "init" });
	const root = `/tmp/pibox-e2e-workspace-${initial.details.workspaceId}`;
	t.after(() => rm(root, { recursive: true, force: true }));
	await rm(root, { recursive: true, force: true });
	const status = await tool.execute("status", { action: "status" });
	assert.equal(status.details.available, false);
	assert.equal(status.details.outputDirectory, undefined, "lost evaluation is not advertised");
	assert.equal(entries.length, 1);
	const missing = await request(handlers, ctx);
	assert.match(missing.system, /unavailable/);
	assert.ok(!missing.system.includes(initial.details.outputDirectory));
	const replacement = await tool.execute("init", { action: "init" });
	const nextRoot = `/tmp/pibox-e2e-workspace-${replacement.details.workspaceId}`;
	t.after(() => rm(nextRoot, { recursive: true, force: true }));
	assert.equal(replacement.details.continuityLost, true);
	assert.notEqual(replacement.details.workspaceId, initial.details.workspaceId);
	assert.notEqual(replacement.details.runId, initial.details.runId);
	assert.ok(replacement.details.outputDirectory.startsWith(`${nextRoot}/`));
	assert.ok((await request(handlers, ctx)).system.includes(replacement.details.outputDirectory));
	assert.equal((await tool.execute("init", { action: "init" })).details.runId, replacement.details.runId);
	await handlers.get("session_shutdown")({}, ctx);
});
