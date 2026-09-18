import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionScratchExtension, { SESSION_SCRATCH_ENTRY_TYPE } from "../index.js";
import { installWorkModeRuntime } from "../../work-mode/runtime.js";
import type { PiBoxWorkMode } from "../../work-mode/policy.js";

function harness(branch: any[] = [], sessionId = "session-a") {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const appended: any[] = [];
	const pi = {
		registerTool(spec: any) { tools.set(spec.name, spec); },
		registerCommand() {},
		on(name: string, handler: (...args: any[]) => any) {
			const previous = handlers.get(name);
			handlers.set(name, async (...args: any[]) => { await previous?.(...args); return handler(...args); });
		},
		appendEntry(customType: string, data: unknown) { appended.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false, model: { api: "openai-completions" },
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => sessionId },
		ui: { setStatus() {}, notify() {}, confirm: async () => true },
		waitForIdle: async () => {},
	} as any;
	const priorRole = process.env.PIBOX_RUNTIME_ROLE;
	delete process.env.PIBOX_RUNTIME_ROLE;
	try { sessionScratchExtension(pi); } finally {
		if (priorRole === undefined) delete process.env.PIBOX_RUNTIME_ROLE;
		else process.env.PIBOX_RUNTIME_ROLE = priorRole;
	}
	return {
		handlers, tools, appended, ctx,
		async request(messages: any[] = [{ role: "user", content: "continue" }]) {
			const context = await handlers.get("context")?.({ messages }, ctx);
			const payload = { messages: [{ role: "system", content: "BASE" }, ...(context?.messages ?? messages).map((message: any) => ({ ...message, role: message.role === "custom" ? "user" : message.role }))] };
			const result = await handlers.get("before_provider_request")?.({ payload }, ctx) ?? payload;
			return { system: result.messages[0].content as string, messages: result.messages.slice(1) };
		},
	};
}

function scratchEntry(binding: { workspaceId: string; sessionId: string } | null) {
	return { type: "custom", customType: SESSION_SCRATCH_ENTRY_TYPE, data: { schemaVersion: 1, binding } };
}

function modeRuntime(mode: () => PiBoxWorkMode) {
	return installWorkModeRuntime({ snapshot: () => ({ sessionId: "session-a", mode: mode(), workflowToolsExposed: false, generation: 1 }) });
}

test("system pointers are stable across idle wakes and compaction without a per-turn activation hook", async () => {
	let mode: PiBoxWorkMode = "agent";
	const uninstall = modeRuntime(() => mode);
	const host = harness();
	let root: string | undefined;
	try {
		await host.handlers.get("session_start")?.({ reason: "startup" }, host.ctx);
		assert.doesNotMatch((await host.request()).system, /Plan:/);
		assert.equal(host.appended.length, 0, "Agent requests do not create optional scratch");
		mode = "orchestrator";
		const first = await host.request();
		const binding = host.appended.at(-1).data.binding;
		root = `/tmp/pibox-session-${binding.workspaceId}`;
		assert.ok(first.system.includes(`Plan: ${root}/plan.md`));
		assert.ok(first.system.includes(`Ledger: ${root}/ledger.md`));
		assert.deepEqual(first.messages, [{ role: "user", content: "continue" }], "paths and private marker never become conversation messages");
		await host.handlers.get("agent_settled")?.({}, host.ctx);
		const completion = [{ role: "custom", customType: "pibox-subagent-result", content: "Completed work" }];
		assert.equal((await host.request(completion)).system, first.system, "idle wake retains identical system pointers");
		assert.equal((await host.request([{ role: "compactionSummary", summary: "Prior work" }])).system, first.system);
		mode = "workflow";
		assert.doesNotMatch((await host.request()).system, /Plan:/);
	} finally {
		await host.handlers.get("session_shutdown")?.({}, host.ctx);
		uninstall();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

test("Agent init publishes workspace on the next tool continuation without a new user turn", async () => {
	const uninstall = modeRuntime(() => "agent");
	const host = harness();
	let root: string | undefined;
	try {
		await host.handlers.get("session_start")?.({}, host.ctx);
		assert.doesNotMatch((await host.request()).system, /Plan:/);
		await host.tools.get("scratch_workspace").execute("init", { action: "init" });
		root = `/tmp/pibox-session-${host.appended.at(-1).data.binding.workspaceId}`;
		assert.ok((await host.request()).system.includes(root));
	} finally {
		await host.handlers.get("session_shutdown")?.({}, host.ctx);
		uninstall();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

test("resume reuses binding without injecting or rewriting plan and ledger contents", async () => {
	const uninstall = modeRuntime(() => "orchestrator");
	const seed = harness();
	let root: string | undefined;
	try {
		await seed.handlers.get("session_start")?.({}, seed.ctx);
		await seed.request();
		const binding = seed.appended.at(-1).data.binding;
		root = `/tmp/pibox-session-${binding.workspaceId}`;
		const plan = "Existing private plan.\n";
		const ledger = "Existing private evidence.\n";
		await writeFile(`${root}/plan.md`, plan);
		await writeFile(`${root}/ledger.md`, ledger);
		await seed.handlers.get("session_shutdown")?.({}, seed.ctx);
		const resumed = harness([scratchEntry(binding)]);
		await resumed.handlers.get("session_start")?.({ reason: "resume" }, resumed.ctx);
		const { system } = await resumed.request();
		assert.ok(system.includes(root));
		assert.match(system, /After compaction or resume/);
		assert.ok(!system.includes(plan.trim()) && !system.includes(ledger.trim()));
		assert.equal(resumed.appended.length, 0);
		assert.equal(await readFile(`${root}/plan.md`, "utf8"), plan);
		assert.equal(await readFile(`${root}/ledger.md`, "utf8"), ledger);
		await resumed.handlers.get("session_shutdown")?.({}, resumed.ctx);
	} finally {
		uninstall();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

test("forks allocate distinct mutable scratch without inheriting parent paths", async () => {
	const uninstall = modeRuntime(() => "orchestrator");
	const parent = harness([], "parent");
	const roots: string[] = [];
	try {
		await parent.handlers.get("session_start")?.({}, parent.ctx);
		await parent.request();
		const binding = parent.appended.at(-1).data.binding;
		roots.push(`/tmp/pibox-session-${binding.workspaceId}`);
		await parent.handlers.get("session_shutdown")?.({}, parent.ctx);
		const child = harness([scratchEntry(binding)], "child");
		await child.handlers.get("session_start")?.({ reason: "fork" }, child.ctx);
		const { system } = await child.request();
		const next = child.appended.at(-1).data.binding;
		roots.push(`/tmp/pibox-session-${next.workspaceId}`);
		assert.notEqual(next.workspaceId, binding.workspaceId);
		assert.match(system, /not its parent session's mutable scratch/);
		assert.ok(!system.includes(roots[0]!));
		await child.handlers.get("session_shutdown")?.({}, child.ctx);
	} finally {
		uninstall();
		for (const root of roots) await rm(root, { recursive: true, force: true });
	}
});

test("live deletion and missing resumed scratch remove system paths until explicit replacement", async () => {
	const uninstall = modeRuntime(() => "orchestrator");
	const host = harness();
	let root: string | undefined;
	try {
		await host.handlers.get("session_start")?.({}, host.ctx);
		await host.request();
		const old = host.appended.at(-1).data.binding;
		root = `/tmp/pibox-session-${old.workspaceId}`;
		await rm(root, { recursive: true, force: true });
		const tool = host.tools.get("scratch_workspace");
		assert.equal((await tool.execute("status", { action: "status" })).details.available, false);
		const missing = await host.request();
		assert.match(missing.system, /unavailable[\s\S]+Continuity was not silently recreated/);
		assert.ok(!missing.system.includes(`Plan: ${root}`));
		assert.equal(host.appended.length, 1);
		await host.handlers.get("session_shutdown")?.({}, host.ctx);
		const resumed = harness([scratchEntry(old)]);
		await resumed.handlers.get("session_start")?.({ reason: "resume" }, resumed.ctx);
		assert.match((await resumed.request()).system, /unavailable/);
		assert.equal(resumed.appended.length, 0);
		await resumed.tools.get("scratch_workspace").execute("init", { action: "init" });
		const next = resumed.appended.at(-1).data.binding;
		root = `/tmp/pibox-session-${next.workspaceId}`;
		assert.notEqual(next.workspaceId, old.workspaceId);
		const replaced = await resumed.request();
		assert.match(replaced.system, /without claiming continuity/);
		assert.ok(replaced.system.includes(`Plan: ${root}/plan.md`));
		await resumed.handlers.get("session_shutdown")?.({}, resumed.ctx);
	} finally {
		uninstall();
		if (root) await rm(root, { recursive: true, force: true });
	}
});
