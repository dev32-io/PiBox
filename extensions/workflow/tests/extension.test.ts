import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import workflow, { formatState, createDemandRuntimeResolver, createFirstDemandReconciler, structuredCapabilityError, WORKFLOW_CHILD_EXTENSION_PATHS } from "../index.js";
import { HarnessError } from "../errors.js";
import { PIBOX_RUNTIME_ROLE_ENV, PIBOX_SUBAGENT_RUNTIME_ROLE } from "../../subagent/tool-policy.js";
import { MODEL_TIER_PROFILE_EVENT } from "../../model-tier-list-profiles/policy.js";

function host() {
	const tools: string[] = []; const toolDefinitions = new Map<string, any>(); const commands: string[] = []; const handlers = new Map<string, Array<(...args: any[]) => unknown>>(); const eventHandlers = new Map<string, Array<(value: unknown) => void>>();
	const pi = { events: { on(name: string, handler: (value: unknown) => void) { eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]); }, emit(name: string, value: unknown) { for (const handler of eventHandlers.get(name) ?? []) handler(value); } }, registerTool(definition: any) { tools.push(definition.name); toolDefinitions.set(definition.name, definition); }, registerCommand(name: string) { commands.push(name); }, on(name: string, handler: (...args: any[]) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
	return { pi, tools, toolDefinitions, commands, handlers };
}

test("structured target errors preserve concrete refusal details", () => {
	const formatted = structuredCapabilityError(new HarnessError("CAPABILITY_DENIED", "Legacy workflow is active.", { legacy: { active: true } }), "work-item:old");
	const payload = JSON.parse(formatted.message);
	assert.equal(payload.code, "CAPABILITY_DENIED"); assert.equal(payload.resourceRef, "work-item:old"); assert.equal(payload.details.legacy.active, true);
});

test("managed child extension paths preserve generic context hooks", () => {
	assert.equal(WORKFLOW_CHILD_EXTENSION_PATHS.length, 4);
	assert.match(WORKFLOW_CHILD_EXTENSION_PATHS[0] ?? "", /workflow\/index\.ts$/);
});

test("main session registers only target planning tools", () => {
	const previous = process.env[PIBOX_RUNTIME_ROLE_ENV]; delete process.env[PIBOX_RUNTIME_ROLE_ENV];
	const f = host(); try { workflow(f.pi); } finally { if (previous === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previous; }
	assert.deepEqual(f.tools, ["resource_list", "resource_read", "story_write", "e2e_write", "task_write", "stage_write", "resource_delete", "workflow_compile", "workflow_status", "workflow_init"]);
	assert.deepEqual(f.commands, ["workflow", "harness"]);
	for (const obsolete of ["resource_write", "workflow_apply_change", "workflow_transition", "workflow_list", "workflow_get", "workflow_schema", "workflow_plan_write", "workflow_create", "workflow_patch", "workflow_delete", "workflow_checkpoint", "task_integrate", "evaluation_record", "work_item_complete", "task_checkpoint", "task_complete", "evaluation_complete", "workflow_ledger"]) assert.equal(f.tools.includes(obsolete), false, obsolete);
});

test("first-demand recovery is single-flight, cached only after success, and retryable after failure", async () => {
	let calls = 0;
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const runtime = { identity: { root: "/repo" } } as any;
	const reconciler = createFirstDemandReconciler(async () => { calls++; await gate; });
	const first = reconciler.run(runtime);
	const second = reconciler.run(runtime);
	assert.equal(calls, 1);
	release();
	await Promise.all([first, second]);
	await reconciler.run(runtime);
	assert.equal(calls, 1);

	const retryable = createFirstDemandReconciler(async () => { if (++calls === 2) throw new Error("transient recovery failure"); });
	await assert.rejects(retryable.run(runtime), /transient recovery failure/);
	await retryable.run(runtime);
	assert.equal(calls, 3);
});

test("repository discovery, runtime construction, and reconciliation share keyed first-demand work", async () => {
	let discoveries = 0; let creations = 0; let reconciliations = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	const resolver = createDemandRuntimeResolver({
		async discover(cwd) { discoveries++; await gate; const root = cwd.startsWith("/other") ? "/other" : "/repo"; return { id: root, root, privateRoot: `/private${root}` }; },
		async create(_ctx, identity) { creations++; return { identity } as any; },
		async reconcile() { reconciliations++; },
	});
	const ctx = (cwd: string) => ({ cwd, sessionManager: { getSessionId: () => "session" } }) as any;
	const same = [resolver.run(ctx("/repo")), resolver.run(ctx("/repo")), resolver.run(ctx("/repo"))]; release(); const resolved = await Promise.all(same); assert.equal(new Set(resolved).size, 1); assert.deepEqual([discoveries, creations, reconciliations], [1, 1, 1]);
	const sharedRoot = await Promise.all([resolver.run(ctx("/repo/one")), resolver.run(ctx("/repo/two"))]); assert.equal(sharedRoot[0], resolved[0]); assert.equal(sharedRoot[1], resolved[0]); assert.deepEqual([discoveries, creations, reconciliations], [3, 1, 1]);
	await Promise.all([resolver.run(ctx("/other/one")), resolver.run(ctx("/other/one"))]); assert.deepEqual([discoveries, creations, reconciliations], [4, 2, 2]);

	let attempts = 0; const retryable = createDemandRuntimeResolver({ async discover() { if (++attempts === 1) throw new Error("discovery failed"); return { id: "repo", root: "/repo", privateRoot: "/private/repo" }; }, async create(_ctx, identity) { return { identity } as any; }, async reconcile() {} });
	await assert.rejects(retryable.run(ctx("/repo")), /discovery failed/); await retryable.run(ctx("/repo")); assert.equal(attempts, 2);
});

test("real runtime caller excludes project config for untrusted initial and profile reload loads", async () => {
	const previous = process.env[PIBOX_RUNTIME_ROLE_ENV]; delete process.env[PIBOX_RUNTIME_ROLE_ENV];
	try {
		for (const trusted of [true, false]) {
			const f = host();
			const loads: Array<{ modelTierProfile: string | undefined; includeProject: boolean | undefined }> = [];
			workflow(f.pi, {
				async discover(cwd) { return { id: "repo", root: cwd, privateRoot: join(cwd, ".git", "pibox") }; },
				loadConfig(_root, options = {}) {
					loads.push({ modelTierProfile: options.modelTierProfile, includeProject: options.includeProject });
					return { config: { modelTierProfile: options.modelTierProfile ?? "default" } as any, digest: "test", diagnostics: [], sources: [] };
				},
				async create(_ctx, identity, config) { return { identity, config, workItems: { async listForCurrentBranch() { return []; } } } as any; },
				async reconcile() {},
			});
			const ctx = { cwd: `/repo-${trusted}`, sessionManager: { getSessionId: () => `session-${trusted}` }, isProjectTrusted: () => trusted } as any;
			await f.toolDefinitions.get("workflow_status").execute("status", {}, undefined, undefined, ctx);
			f.pi.events.emit(MODEL_TIER_PROFILE_EVENT, { profile: "token-conservative" });
			await f.toolDefinitions.get("workflow_status").execute("status", {}, undefined, undefined, ctx);
			assert.deepEqual(loads, [
				{ modelTierProfile: undefined, includeProject: trusted },
				{ modelTierProfile: "token-conservative", includeProject: trusted },
			]);
			for (const handler of f.handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
		}
	} finally {
		if (previous === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previous;
	}
});

test("non-repository startup stays lazy and first demand returns a structured refusal", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-no-repository-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previous = process.env[PIBOX_RUNTIME_ROLE_ENV]; delete process.env[PIBOX_RUNTIME_ROLE_ENV];
	const f = host();
	try { workflow(f.pi); } finally { if (previous === undefined) delete process.env[PIBOX_RUNTIME_ROLE_ENV]; else process.env[PIBOX_RUNTIME_ROLE_ENV] = previous; }
	const ctx = { cwd: root, sessionManager: { getSessionId: () => "session" } } as any;
	for (const handler of f.handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
	await assert.rejects(
		f.toolDefinitions.get("workflow_status").execute("status", {}, undefined, undefined, ctx),
		(error: Error) => JSON.parse(error.message).code === "NOT_A_GIT_REPOSITORY",
	);
	for (const handler of f.handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
});

test("child extension registers managed worker capabilities by action", () => {
	const keys = [PIBOX_RUNTIME_ROLE_ENV, "PIBOX_WORKFLOW_STORY_ID", "PIBOX_WORKFLOW_TASK_ID", "PIBOX_WORKFLOW_ATTEMPT_TOKEN", "PIBOX_WORKFLOW_ACTION", "PIBOX_SUBAGENT_REPORT_PATH"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	for (const key of keys) delete process.env[key];
	process.env[PIBOX_RUNTIME_ROLE_ENV] = PIBOX_SUBAGENT_RUNTIME_ROLE;
	try {
		let f = host(); workflow(f.pi); assert.deepEqual(f.tools, []);
		process.env.PIBOX_WORKFLOW_STORY_ID = "story"; process.env.PIBOX_WORKFLOW_TASK_ID = "task"; process.env.PIBOX_WORKFLOW_ATTEMPT_TOKEN = "token";
		f = host(); workflow(f.pi); assert.deepEqual(f.tools, ["task_clarify"]);
		process.env.PIBOX_WORKFLOW_ACTION = "task-launch";
		f = host(); workflow(f.pi); assert.deepEqual(f.tools, ["task_clarify", "workflow_ledger"]);
		delete process.env.PIBOX_WORKFLOW_TASK_ID; process.env.PIBOX_WORKFLOW_ACTION = "review-fix";
		f = host(); workflow(f.pi); assert.deepEqual(f.tools, ["workflow_ledger"]);
		for (const action of ["review", "final-review", "e2e", "standalone", "custom-fix"]) {
			process.env.PIBOX_WORKFLOW_ACTION = action; f = host(); workflow(f.pi); assert.deepEqual(f.tools, [], action);
		}
		process.env.PIBOX_WORKFLOW_ACTION = "e2e"; process.env.PIBOX_SUBAGENT_REPORT_PATH = "/tmp/managed-attempt/report.md";
		f = host(); workflow(f.pi); assert.deepEqual(f.tools, ["workflow_e2e_report"]);
	} finally {
		for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	}
});

 test("status text exposes authoritative correction coordinates without log payloads", () => {
 const text = formatState({ status: "attention", stages: [], metrics: { workflowMs: 0, incompleteCategories: [] }, attentionEpoch: 3, attentionTarget: { kind: "final-review" }, attention: { code: "repair_exhausted", summary: "Review failed", diagnostic: { stderr: "PRIVATE_LOG" } } } as any);
 assert.match(text, /"attentionEpoch":3/);
 assert.match(text, /"attentionTarget":\{"kind":"final-review"\}/);
 assert.match(text, /Review failed/);
 assert.doesNotMatch(text, /PRIVATE_LOG/);
});
