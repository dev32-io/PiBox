import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import keepAwake from "../index.js";
import { KEEP_AWAKE_ENTRY_TYPE, resolveKeepAwakeDefault, loadKeepAwakeDefault, restoreKeepAwakeEnabled } from "../config.js";
import type { LogicalAgentSnapshot, SubagentService } from "../../subagent/api.js";

const entry = (enabled: unknown, schemaVersion = 1) => ({ type: "custom", customType: KEEP_AWAKE_ENTRY_TYPE, data: { schemaVersion, enabled } });
function harness(options: { defaultEnabled?: boolean; entries?: unknown[]; env?: NodeJS.ProcessEnv; agents?: LogicalAgentSnapshot[] } = {}) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
	let command: any;
	let entries = options.entries ?? [];
	let agents = options.agents ?? [];
	const notices: string[] = [];
	const listeners = new Set<() => void>();
	const controls: Array<{ active: boolean; closed: boolean; retries: number; setActive(active: boolean): void; retry(): void; close(): Promise<void>; status: "idle" | "active" }> = [];
	const owner = { sessionId: "owner", processInstanceId: "process", activationId: "activation" };
	const ctx = { cwd: process.cwd(), hasUI: true, sessionManager: { getBranch: () => entries, getSessionId: () => owner.sessionId },
		ui: { notify: (message: string) => notices.push(message), setStatus() { throw new Error("no status indicator"); } },
	} as unknown as ExtensionContext;
	const service = {
		owner,
		inspect: () => agents,
		replay: () => ({ snapshot: { owner, agents, cursor: 0 }, events: [], reset: false }),
		subscribe(_owner: unknown, _cursor: unknown, listener: () => void) {
			listeners.add(listener);
			return { initial: { snapshot: { owner, agents, cursor: 0 }, events: [], reset: false }, unsubscribe() { listeners.delete(listener); } };
		},
	} as unknown as SubagentService;
	const pi = {
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand(name: string, definition: unknown) { assert.equal(name, "keep-awake"); command = definition; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	keepAwake(pi, {
		env: options.env ?? {}, loadDefault: () => options.defaultEnabled ?? true,
		resolveSubagents: (sessionId) => { assert.equal(sessionId, "owner"); return { protocolVersion: 1, owner, service }; },
		createController() {
			const c = { active: false, closed: false, retries: 0, setActive(active: boolean) { this.active = active; }, retry() { this.retries++; }, async close() { this.closed = true; this.active = false; }, get status(): "active" | "idle" { return this.active ? "active" : "idle"; } };
			controls.push(c); return c;
		},
	});
	return { handlers, ctx, notices, controls, listeners, command,
		run: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		setEntries: (next: unknown[]) => { entries = next; },
		setAgents(next: LogicalAgentSnapshot[]) { agents = next; for (const listener of listeners) listener(); },
	};
}
const agent = (state: LogicalAgentSnapshot["state"], workflow = false) => ({ state, ...(workflow ? { workflowMetadata: { storyId: "test" } } : {}) }) as unknown as LogicalAgentSnapshot;

test("defaults enabled, global opt-out is strict, and session branch overrides win", async () => {
	for (const value of [undefined, null, [], {}, { enabled: "false" }, { enabled: true }]) assert.equal(resolveKeepAwakeDefault(value), true);
	assert.equal(resolveKeepAwakeDefault({ enabled: false }), false);
	const h = harness({ entries: [entry(false), entry("bad"), entry(true, 99)] });
	assert.equal(restoreKeepAwakeEnabled(h.ctx, true), false);
	h.setEntries([]);
	assert.equal(restoreKeepAwakeEnabled(h.ctx, false), false);
	const root = await mkdtemp(join(tmpdir(), "pibox-keep-awake-config-"));
	try {
		const global = join(root, "global"); const repo = join(root, "repo");
		await mkdir(global); await mkdir(join(repo, ".pi"), { recursive: true });
		await writeFile(join(global, "settings.json"), JSON.stringify({ keepAwake: { enabled: false } }));
		await writeFile(join(repo, ".pi", "settings.json"), JSON.stringify({ keepAwake: { enabled: true } }));
		assert.equal(loadKeepAwakeDefault(repo, global), false, "project cannot re-enable a user opt-out");
		await writeFile(join(global, "settings.json"), "{}");
		assert.equal(loadKeepAwakeDefault(repo, global), true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("main activity and all child states jointly hold awake until the last agent settles", async () => {
	const h = harness();
	await h.run("session_start");
	const c = h.controls[0]!;
	assert.equal(c.active, false);
	assert.equal(h.notices.length, 0);
	h.run("agent_start");
	assert.equal(c.active, true);
	assert.equal(h.handlers.has("agent_end"), false, "agent_end does not release between retries");
	h.setAgents([agent("running"), agent("launching", true)]);
	h.run("agent_settled");
	assert.equal(c.active, true);
	h.setAgents([agent("completed"), agent("stopping", true)]);
	assert.equal(c.active, true, "workflow children and stopping processes also count");
	h.setAgents([agent("failed"), agent("cancelled", true)]);
	assert.equal(c.active, false);
	await h.run("session_shutdown");
	assert.equal(c.closed, true);
	assert.equal(h.listeners.size, 0);
});

test("commands apply immediately during background work and restore across reload/tree/new", async () => {
	const h = harness({ agents: [agent("running", true)] });
	await h.run("session_start", { reason: "reload" });
	assert.equal(h.controls[0]!.active, true, "reload seeds active children from initial service snapshot");
	await h.command.handler("off", h.ctx);
	assert.equal(h.controls[0]!.active, false);
	await h.run("session_shutdown");
	await h.run("session_start", { reason: "reload" });
	assert.equal(h.controls[1]!.active, false, "saved override survives reload");
	await h.command.handler("on", h.ctx);
	assert.equal(h.controls[1]!.active, true);
	assert.equal(h.controls[1]!.retries, 1);
	h.setEntries([entry(false)]);
	h.run("session_tree");
	assert.equal(h.controls[1]!.active, false);
	h.setEntries([]);
	await h.run("session_shutdown");
	await h.run("session_start", { reason: "new" });
	assert.equal(h.controls[2]!.active, true, "new session uses enabled default");
	await h.command.handler("status", h.ctx);
	assert.match(h.notices.at(-1)!, /on.*active/);
	await h.command.handler("invalid", h.ctx);
	assert.match(h.notices.at(-1)!, /Usage:/);
	await h.run("session_shutdown");
});

test("children do not register or manage their own keep-awake extension", () => {
	const h = harness({ env: { PIBOX_RUNTIME_ROLE: "subagent" } });
	assert.equal(h.handlers.size, 0);
	assert.equal(h.command, undefined);
	assert.equal(h.controls.length, 0);
});
