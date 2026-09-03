import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import sessionScratchExtension, { SESSION_SCRATCH_ENTRY_TYPE } from "../index.js";
import { installWorkModeRuntime } from "../../work-mode/runtime.js";
import type { PiBoxWorkMode } from "../../work-mode/policy.js";

function harness(branch: any[] = [], sessionId = "session-a") {
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const appended: any[] = [];
	const pi = {
		registerTool(spec: any) { tools.set(spec.name, spec); },
		registerCommand(name: string, spec: any) { commands.set(name, spec); },
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		appendEntry(customType: string, data: unknown) { appended.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: false,
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
	return { handlers, tools, commands, appended, ctx };
}

function scratchEntry(binding: { workspaceId: string; sessionId: string } | null) {
	return { type: "custom", customType: SESSION_SCRATCH_ENTRY_TYPE, data: { schemaVersion: 1, binding } };
}

test("Agent startup is disk-idle while Orchestrator demand creates and reinjects private scratch", async () => {
	let mode: PiBoxWorkMode = "agent";
	const uninstall = installWorkModeRuntime({ snapshot: () => ({ sessionId: "session-a", mode, workflowToolsExposed: false, generation: 1 }) });
	const testHarness = harness();
	let root: string | undefined;
	try {
		await testHarness.handlers.get("session_start")?.({ reason: "startup" }, testHarness.ctx);
		await testHarness.handlers.get("before_agent_start")?.({}, testHarness.ctx);
		assert.equal(await testHarness.handlers.get("context")?.({ messages: [{ role: "user", content: "hello" }] }, testHarness.ctx), undefined);
		assert.equal(testHarness.appended.length, 0, "fresh Agent mode does not initialize scratch");

		mode = "orchestrator";
		await testHarness.handlers.get("before_agent_start")?.({}, testHarness.ctx);
		const projected = await testHarness.handlers.get("context")?.({ messages: [{ role: "user", content: "coordinate" }] }, testHarness.ctx) as { messages: any[] };
		const saved = testHarness.appended.at(-1)?.data.binding;
		assert.equal(saved.sessionId, "session-a");
		assert.match(saved.workspaceId, /^[0-9a-f]{32}$/);
		root = `/tmp/pibox-session-${saved.workspaceId}`;
		const pointer = projected.messages.find((message) => message.customType === "pibox-session-scratch");
		assert.match(pointer.content, new RegExp(root));
		assert.match(pointer.content, /non-authoritative[\s\S]+plan\.md[\s\S]+ledger\.md/i);
		const next = await testHarness.handlers.get("context")?.({ messages: [...projected.messages, { role: "assistant", content: "ok" }] }, testHarness.ctx) as { messages: any[] };
		assert.equal(next.messages.filter((message) => message.customType === "pibox-session-scratch").length, 1, "compaction pointer is replaced, not duplicated");
	} finally {
		await testHarness.handlers.get("session_shutdown")?.({}, testHarness.ctx);
		uninstall();
		if (root) await rm(root, { recursive: true, force: true });
	}
});

test("forks inherit mode but allocate a distinct mutable Orchestrator scratch", async () => {
	const mode: PiBoxWorkMode = "orchestrator";
	const uninstall = installWorkModeRuntime({ snapshot: () => ({ sessionId: "child-session", mode, workflowToolsExposed: false, generation: 1 }) });
	const parent = harness([], "parent-session");
	const roots: string[] = [];
	try {
		await parent.handlers.get("session_start")?.({ reason: "startup" }, parent.ctx);
		await parent.tools.get("scratch_workspace").execute("call", { action: "init" }, undefined, undefined, parent.ctx);
		const parentBinding = parent.appended.at(-1).data.binding;
		roots.push(`/tmp/pibox-session-${parentBinding.workspaceId}`);
		await parent.handlers.get("session_shutdown")?.({}, parent.ctx);

		const child = harness([scratchEntry(parentBinding)], "child-session");
		await child.handlers.get("session_start")?.({ reason: "fork" }, child.ctx);
		await child.handlers.get("before_agent_start")?.({}, child.ctx);
		const projected = await child.handlers.get("context")?.({ messages: [{ role: "user", content: "fork" }] }, child.ctx) as { messages: any[] };
		const childBinding = child.appended.at(-1).data.binding;
		roots.push(`/tmp/pibox-session-${childBinding.workspaceId}`);
		assert.equal(childBinding.sessionId, "child-session");
		assert.notEqual(childBinding.workspaceId, parentBinding.workspaceId);
		assert.match(projected.messages.find((message) => message.customType === "pibox-session-scratch").content, /not its parent session's mutable scratch[\s\S]+distinct workspace/i);
		await child.handlers.get("session_shutdown")?.({}, child.ctx);
	} finally {
		uninstall();
		for (const root of roots) await rm(root, { recursive: true, force: true });
	}
});

test("missing resumed scratch is reported before explicit fresh initialization", async () => {
	let mode: PiBoxWorkMode = "orchestrator";
	const uninstall = installWorkModeRuntime({ snapshot: () => ({ sessionId: "session-a", mode, workflowToolsExposed: false, generation: 1 }) });
	const seed = harness();
	let replacementRoot: string | undefined;
	try {
		await seed.handlers.get("session_start")?.({ reason: "startup" }, seed.ctx);
		const initialized = await seed.tools.get("scratch_workspace").execute("call", { action: "init" }, undefined, undefined, seed.ctx);
		assert.match(initialized.content[0].text, /Root: \/tmp\/pibox-session-/);
		const binding = seed.appended.at(-1).data.binding;
		await rm(`/tmp/pibox-session-${binding.workspaceId}`, { recursive: true, force: true });
		await seed.handlers.get("session_shutdown")?.({}, seed.ctx);

		const resumed = harness([scratchEntry(binding)]);
		await resumed.handlers.get("session_start")?.({ reason: "resume" }, resumed.ctx);
		await resumed.handlers.get("before_agent_start")?.({}, resumed.ctx);
		const context = await resumed.handlers.get("context")?.({ messages: [{ role: "user", content: "resume" }] }, resumed.ctx) as { messages: any[] };
		const pointer = context.messages.find((message) => message.customType === "pibox-session-scratch");
		assert.match(pointer.content, /unavailable[\s\S]+Continuity was not silently recreated/i);
		assert.equal(resumed.appended.length, 0);

		const fresh = await resumed.tools.get("scratch_workspace").execute("call", { action: "init" }, undefined, undefined, resumed.ctx);
		assert.match(fresh.content[0].text, /fresh workspace was created without claiming continuity/i);
		const replacement = resumed.appended.at(-1).data.binding;
		assert.notEqual(replacement.workspaceId, binding.workspaceId);
		replacementRoot = `/tmp/pibox-session-${replacement.workspaceId}`;
		await resumed.handlers.get("session_shutdown")?.({}, resumed.ctx);
	} finally {
		uninstall();
		if (replacementRoot) await rm(replacementRoot, { recursive: true, force: true });
	}
});
