import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { RuntimeOwner } from "../../subagent/api.js";
import { WorkflowRunner } from "../../workflow-runtime/runner.js";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { StoryRuntimeStore } from "../story-runtime-store.js";
import { createE2eScratchDirectory, createHarnessWorkflowAdapter, type StoryWorkflowActionExecutor, type StoryWorkflowActionResult } from "../workflow-adapter.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../types.js";
import { renderDesign, renderE2e, renderSpec } from "../authored-markdown.js";

const exec = promisify(execFile);

interface FixtureOptions {
	plan?: StoryPlanDocument;
	tasks?: AuthoredTaskDocument[];
	execute?: StoryWorkflowActionExecutor;
	owner?: RuntimeOwner;
}

const story: StoryDocument = {
	schemaVersion: 1,
	id: "example",
	title: "Example",
	kind: "story",
	spec: renderSpec({ outcome: "Deliver the example result.", scope: "Only the example journey.", behavior: "A valid request returns one result.", acceptance: "The result is observable." }),
	design: renderDesign({ approach: "Use the existing boundary.", boundariesAndFlow: "One adapter calls one service.", failureAndVerification: "Typed failures do not persist and focused checks prove the result." }),
	e2e: renderE2e({ scope: "The disposable example journey.", cases: [{ id: "E2E-001", title: "Observe result", exercise: "Submit one disposable valid request.", oracle: "One result is visible.", proof: "Capture and remove the disposable result." }] }),
};

function task(id: string, checks: AuthoredTaskDocument["checks"] = []): AuthoredTaskDocument {
	return {
		schemaVersion: 1,
		id,
		title: id,
		dependsOn: [],
		description: `Complete description for ${id}.`,
		scope: `Complete scope for ${id}.`,
		delivery: `Complete delivery contract for ${id}.`,
		checks,
		assignment: { agent: "implementer", tier: "medium", rationale: "Focused implementation." },
	};
}

async function fixture(t: test.TestContext, options: FixtureOptions) {
	const root = await mkdtemp(join(tmpdir(), "pibox-story-adapter-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
	await exec("git", ["init", "-q", "-b", "feature/example"], { cwd: root });
	await exec("git", ["config", "user.email", "tests@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Tests"], { cwd: root });
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/agent-artifacts/*/state.yaml\n/agent-artifacts/*/ledger.yaml\n/agent-artifacts/*/events.jsonl\n");
	await exec("git", ["add", ".gitignore"], { cwd: root });
	await exec("git", ["commit", "-qm", "base"], { cwd: root });
	const tasks = options.tasks ?? [task("task-a")];
	const plan = options.plan ?? { schemaVersion: 1, stages: [{ id: "delivery", tasks: tasks.map((entry) => entry.id), mode: "sequential", checks: [], review: { mode: "skip" } }] };
	let owner = options.owner ?? { sessionId: `session-${root}`, processInstanceId: "process", activationId: "activation-a" };
	const capacityListeners = new Set<() => void>();
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: join(root, ".git", "pibox"), commonDir: join(root, ".git") },
		workItems: {
			async readStory() { return story; },
			async readStoryPlan() { return plan; },
			async readAuthoredTask(_storyId: string, id: string) { return tasks.find((entry) => entry.id === id)!; },
			async listAuthoredTasks() { return tasks; },
			async findDelivery() { return { workingBranch: "feature/example", createdFromCommit: "fixture" }; },
			async list() { return [{ id: story.id }]; },
		},
		launcher: {
			service: { get owner() { return owner; }, inspect() { return []; } },
			activeCount() { return 0; },
			subscribeCapacity(listener: () => void) { capacityListeners.add(listener); return () => capacityListeners.delete(listener); },
			async stopStory() { return 0; }, async releaseStory() { return 0; },
		},
		mutex: { async run<T>(_owner: string, operation: () => Promise<T>): Promise<T> { return operation(); } },
		config: { ...structuredClone(DEFAULT_HARNESS_CONFIG), limits: { ...DEFAULT_HARNESS_CONFIG.limits, repairRounds: 2, maxConcurrency: 4, maxActiveSubagentsPerSession: 16 } },
	};
	const ctx = { sessionManager: { getSessionId: () => owner.sessionId } } as any;
	const create = () => createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, ...(options.execute ? { executeAction: options.execute } : {}), now: (() => { let tick = 0; return () => new Date(1_700_000_000_000 + tick++); })() });
	return {
		root, runtime, ctx, create,
		fireCapacity() { for (const listener of capacityListeners) listener(); },
		setOwner(value: RuntimeOwner) { owner = value; },
	};
}

function useProductionExecutor(f: Awaited<ReturnType<typeof fixture>>, launch: (input: any) => Promise<{ text: string; exitCode?: number; stderr?: string; terminalReason?: string }>): void {
	f.runtime.config = structuredClone(DEFAULT_HARNESS_CONFIG);
	f.runtime.launcher.launch = async (input: any) => {
		const terminal = await launch(input);
		return { exitCode: terminal.exitCode ?? 0, text: terminal.text, stderr: terminal.stderr ?? "", terminalReason: terminal.terminalReason ?? "completed", provider: input.provider, model: input.model, effort: input.effort, serviceAttemptId: input.attemptToken };
	};
	f.runtime.launcher.stopStory = async () => 0;
	f.ctx.scopedModels = ["gpt-5.6-sol", "gpt-5.6-luna"].map((id) => ({ model: { provider: "openai-codex", id, reasoning: true, api: "openai-codex-responses" } }));
	f.ctx.modelRegistry = { getAvailable: () => f.ctx.scopedModels.map((entry: any) => entry.model) };
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let last: unknown;
	while (Date.now() < deadline) {
		try { await assertion(); return; }
		catch (error) { last = error; await new Promise((resolve) => setTimeout(resolve, 10)); }
	}
	throw last;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const passed = (summary = "passed"): StoryWorkflowActionResult => ({ result: "passed", summary: { code: "passed", summary } });

async function start(adapter: ReturnType<typeof createHarnessWorkflowAdapter>, ctx: any) {
	await adapter.controlExecution!("work-item:example", "start", "start", ctx);
	await adapter.advanceWorkflow!("work-item:example", ctx);
}

test("preflight is side-effect-free and never executes verification bootstrap before cancellation", async (t) => {
	const markerName = "bootstrap-ran";
	const f = await fixture(t, { tasks: [task("task-a", [{ id: "unit", command: "true", profile: "project" }])] });
	f.runtime.config = structuredClone(DEFAULT_HARNESS_CONFIG);
	f.runtime.config.verification = { defaultProfile: "project", profiles: { project: { shell: "/bin/sh", bootstrap: `printf ran > ${markerName}`, requiredEnvironment: [] } } };
	const adapter = f.create();
	assert.deepEqual(await adapter.preflightWorkflow!("work-item:example", f.ctx), { ok: true });
	await assert.rejects(access(join(f.root, markerName)), /ENOENT/, "cancelled launch preflight must not run configured bootstrap code");
	assert.equal(await new StoryRuntimeStore(f.root, "example").readState(), undefined, "preflight must not initialize authoritative state");
});

test("start preflight refuses an uncompiled placeholder story without creating runtime state", async (t) => {
	const f = await fixture(t, {});
	f.runtime.workItems.readStory = async () => ({ ...story, spec: renderSpec({ outcome: "TBD", scope: "Only the example journey.", behavior: "A valid request returns one result.", acceptance: "The result is observable." }) });
	const adapter = f.create();
	await assert.rejects(adapter.preflightWorkflow!("work-item:example", f.ctx), /placeholder content/i);
	await assert.rejects(adapter.controlExecution!("work-item:example", "start", "start", f.ctx), /placeholder content/i);
	assert.equal(await new StoryRuntimeStore(f.root, "example").readState(), undefined);
});

test("start preflight refuses a missing runtime ledger ignore before state creation", async (t) => {
	const f = await fixture(t, {});
	const ignorePath = join(f.root, ".gitignore");
	await writeFile(ignorePath, (await readFile(ignorePath, "utf8")).replace("agent-artifacts/*/ledger.yaml\n", ""));
	await exec("git", ["add", ".gitignore"], { cwd: f.root });
	await exec("git", ["commit", "-qm", "remove ledger ignore"], { cwd: f.root });
	const adapter = f.create();
	const preflight = await adapter.preflightWorkflow!("work-item:example", f.ctx);
	assert.equal(preflight.ok, false);
	assert.match(preflight.detail ?? "", /agent-artifacts\/example\/ledger\.yaml/);
	assert.match(preflight.detail ?? "", /workflow_init|local excludes/);
	await assert.rejects(adapter.controlExecution!("work-item:example", "start", "start", f.ctx), /ledger\.yaml/);
	assert.equal(await new StoryRuntimeStore(f.root, "example").readState(), undefined, "ignore refusal must precede runtime initialization");
});

test("start preflight refuses a plan that failed the non-empty compile contract", async (t) => {
	const f = await fixture(t, { tasks: [], plan: { schemaVersion: 1, stages: [] } });
	const adapter = f.create();
	await assert.rejects(adapter.preflightWorkflow!("work-item:example", f.ctx), /at least one stage/i);
	assert.equal(await new StoryRuntimeStore(f.root, "example").readState(), undefined);
});

test("start and resume remain bound to the persisted canonical branch", async (t) => {
	const f = await fixture(t, { execute: async () => passed() });
	const adapter = f.create();
	await exec("git", ["switch", "-c", "wrong-branch"], { cwd: f.root });
	await assert.rejects(adapter.controlExecution!("work-item:example", "start", "wrong-start", f.ctx), /persisted canonical branch feature\/example/i);
	assert.equal(await new StoryRuntimeStore(f.root, "example").readState(), undefined);
	await exec("git", ["switch", "feature/example"], { cwd: f.root });
	await adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
	await adapter.controlExecution!("work-item:example", "pause", "pause", f.ctx);
	const pinnedSnapshot = await adapter.snapshot("work-item:example", f.ctx);
	const pinned = pinnedSnapshot.runtime;
	assert.equal(pinned.git.canonicalBranch, "feature/example");
	assert.deepEqual(pinnedSnapshot.stageTopology, [{ id: "delivery", mode: "sequential" }]);
	await exec("git", ["switch", "wrong-branch"], { cwd: f.root });
	await assert.rejects(adapter.controlExecution!("work-item:example", "resume", "wrong-resume", f.ctx), /canonical branch is feature\/example/i);
	await assert.rejects(adapter.advanceWorkflow!("work-item:example", f.ctx), /canonical branch is feature\/example/i);
	assert.equal((await new StoryRuntimeStore(f.root, "example").readState())?.status, "paused");
});

test("authoritative contract digests reject any persisted story, plan, or task mutation", async (t) => {
	const authoredTask = task("task-a");
	const f = await fixture(t, { tasks: [authoredTask], execute: async () => passed() });
	const adapter = f.create();
	await adapter.controlExecution!("work-item:example", "start", "start", f.ctx);
	const initialized = await new StoryRuntimeStore(f.root, "example").readState();
	assert.match(initialized!.contracts.story, /^sha256:[a-f0-9]{64}$/);
	assert.match(initialized!.contracts.plan, /^sha256:[a-f0-9]{64}$/);
	assert.deepEqual(Object.keys(initialized!.contracts.tasks), ["task-a"]);
	authoredTask.description = "Mutated after authoritative initialization.";
	await assert.rejects(adapter.snapshot("work-item:example", f.ctx), /contract does not match/i);
	await assert.rejects(adapter.advanceWorkflow!("work-item:example", f.ctx), /contract does not match/i);
});

test("a live production-shaped child leaves start bounded and idle scheduler wakes write nothing", async (t) => {
	const gate = deferred<StoryWorkflowActionResult>();
	let childSettled = false;
	void gate.promise.then(() => { childSettled = true; });
	const f = await fixture(t, {
		execute: async ({ action }) => action.kind === "task-launch" ? gate.promise : passed(),
	});
	const production = f.create();
	let advances = 0;
	let lifecycleNotifications = 0;
	const adapter = {
		...production,
		async advanceWorkflow(ref: string, ctx: any) { advances++; await production.advanceWorkflow(ref, ctx); },
		subscribeLifecycle(ref: string, ctx: any, listener: (update?: any) => void, signal?: AbortSignal) {
			return production.subscribeLifecycle!(ref, ctx, (update) => { lifecycleNotifications++; listener(update); }, signal);
		},
	};
	const runner = new WorkflowRunner("work-item:example", adapter, f.ctx, {
		onProjection() {}, onNotice() {}, onLifecycle() {}, onComplete() {},
	});
	t.after(() => runner.dispose());

	let timeout: NodeJS.Timeout | undefined;
	await Promise.race([
		(async () => { await runner.command("start", "production-start"); await runner.advance(); })(),
		new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("initial scheduling did not return")), 500); }),
	]).finally(() => { if (timeout) clearTimeout(timeout); });
	assert.equal(childSettled, false, "start must not wait for child settlement");
	await eventually(() => assert.equal(runner.snapshot?.runtime.stages[0]?.tasks[0]?.status, "implementing"));
	await new Promise((resolve) => setTimeout(resolve, 25));

	const store = new StoryRuntimeStore(f.root, "example");
	const initialEvents = await store.readDebugTail(50);
	assert.equal(initialEvents.filter((event) => event.type === "workflow.advanced").length, 1, "one action activation produces one scheduling event");
	assert.ok(lifecycleNotifications >= 1 && lifecycleNotifications <= 2, "initial subscription and action activation produce bounded lifecycle wakes");
	const beforeIdle = await stat(store.statePath);
	const eventCountBeforeIdle = initialEvents.length;
	const advancesBeforeIdle = advances;
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal(advances, advancesBeforeIdle, "an idle active child produces no periodic scheduler ticks");
	for (let index = 0; index < 20; index++) f.fireCapacity();
	await new Promise((resolve) => setTimeout(resolve, 25));
	const afterIdleEvents = await store.readDebugTail(50);
	const afterIdle = await stat(store.statePath);
	assert.ok(advances - advancesBeforeIdle <= 2, "a synchronous capacity burst coalesces to the active pass plus at most one follow-up");
	assert.equal(afterIdleEvents.length, eventCountBeforeIdle, "idle passes append no scheduler debug events");
	assert.equal(afterIdle.ino, beforeIdle.ino, "idle passes do not atomically replace state.yaml");

	await runner.command("pause", "pause-before-settlement");
	await new Promise((resolve) => setTimeout(resolve, 10));
	const eventsBeforeSettlement = (await store.readDebugTail(50)).length;
	const notificationsBeforeSettlement = lifecycleNotifications;
	gate.resolve({ ...passed(), contributionCommit: "task-commit" });
	await eventually(async () => assert.equal((await production.snapshot("work-item:example", f.ctx)).runtime.stages[0]?.tasks[0]?.status, "completed"));
	await new Promise((resolve) => setTimeout(resolve, 25));
	const settledEvents = await store.readDebugTail(50);
	assert.equal(settledEvents.length - eventsBeforeSettlement, 1, "one accepted settlement appends one debug event");
	assert.equal(settledEvents.at(-1)?.type, "action.settled");
	assert.equal(lifecycleNotifications - notificationsBeforeSettlement, 1, "one accepted settlement emits one lifecycle wake");
});

test("production scheduling preserves ordered stages and concurrent task batches", async (t) => {
	await t.test("ordered sequential stages", async (t) => {
		const first = deferred<StoryWorkflowActionResult>();
		const second = deferred<StoryWorkflowActionResult>();
		const calls: string[] = [];
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [
				{ id: "first", tasks: ["a", "b"], mode: "sequential", checks: [], review: { mode: "skip" } },
				{ id: "second", tasks: ["c"], mode: "sequential", checks: [], review: { mode: "skip" } },
			] },
			tasks: [task("a"), task("b"), task("c")],
			execute: async ({ action }) => {
				calls.push(`${action.kind}:${action.taskId ?? action.stageId ?? "final"}`);
				if (action.kind === "task-launch" && action.taskId === "a") return first.promise;
				if (action.kind === "task-launch" && action.taskId === "b") return second.promise;
				return action.kind === "task-launch" ? { ...passed(), contributionCommit: `commit-${action.taskId}` } : action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
			},
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(() => assert.deepEqual(calls, ["task-launch:a"]));
		first.resolve({ ...passed(), contributionCommit: "commit-a" });
		await eventually(() => assert.ok(calls.includes("task-launch:b")));
		assert.equal(calls.includes("task-launch:c"), false, "later stages remain behind the first stage barrier");
		second.resolve({ ...passed(), contributionCommit: "commit-b" });
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
	});

	await t.test("concurrent task batch", async (t) => {
		const gates = new Map(["a", "b", "c"].map((id) => [id, deferred<StoryWorkflowActionResult>()]));
		const calls: string[] = [];
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [{ id: "parallel", tasks: ["a", "b", "c"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
			tasks: [task("a"), task("b"), task("c")],
			execute: async ({ action }) => {
				if (action.kind === "task-launch") { calls.push(action.taskId!); return gates.get(action.taskId!)!.promise; }
				return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
			},
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(() => assert.deepEqual([...calls].sort(), ["a", "b", "c"]));
		for (const [id, gate] of gates) gate.resolve({ ...passed(), contributionCommit: `commit-${id}` });
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
	});
});

test("production Git executor shares a sequential stage workspace and pins concurrent task bases", async (t) => {
	await t.test("sequential task B sees A and ordered commits integrate once", async (t) => {
		const firstTask = task("a");
		const tasks = [{ ...firstTask, assignment: { ...firstTask.assignment, tier: "high" as const } }, { ...task("b"), dependsOn: ["a"] }];
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["a", "b"], mode: "sequential", checks: [], review: { mode: "skip" } }] },
			tasks,
		});
		const workspaces: string[] = [];
		useProductionExecutor(f, async (input) => {
			if (input.taskId) {
				assert.equal(input.tier, input.taskId === "a" ? "high" : "medium", "task launches carry the authored assignment tier");
				assert.ok(input.tools.includes("task_clarify"));
				assert.equal(input.tools.includes("task_checkpoint"), false, "target launch must not regain the legacy task group");
				workspaces.push(input.cwd);
				if (input.taskId === "b") assert.equal(await readFile(join(input.cwd, "a.txt"), "utf8"), "A\n");
				await writeFile(join(input.cwd, `${input.taskId}.txt`), `${input.taskId!.toUpperCase()}\n`);
				await exec("git", ["add", `${input.taskId}.txt`], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", `implement ${input.taskId}`], { cwd: input.cwd });
				return { text: `${input.taskId} complete` };
			}
			assert.equal(input.tier, f.runtime.config.agents[input.role]?.tier, "non-task launches carry the resolved role tier");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(async () => { const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime; assert.equal(runtime?.outcomeStatus, "written", JSON.stringify(runtime)); }, 8_000);
		assert.equal(new Set(workspaces).size, 1);
		assert.equal(await readFile(join(f.root, "a.txt"), "utf8"), "A\n");
		assert.equal(await readFile(join(f.root, "b.txt"), "utf8"), "B\n");
		assert.equal((await exec("git", ["log", "--format=%s"], { cwd: f.root })).stdout.match(/implement [ab]/g)?.join(","), "implement b,implement a");
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	});

	await t.test("concurrent task workspaces share one pinned base", async (t) => {
		const tasks = [task("a"), task("b")];
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [{ id: "parallel", tasks: ["a", "b"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
			tasks,
		});
		const bases: string[] = [];
		const workspaces: string[] = [];
		useProductionExecutor(f, async (input) => {
			if (input.taskId) {
				bases.push((await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim());
				workspaces.push(input.cwd);
				await writeFile(join(input.cwd, `${input.taskId}.txt`), `${input.taskId}\n`);
				await exec("git", ["add", `${input.taskId}.txt`], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", `implement ${input.taskId}`], { cwd: input.cwd });
				return { text: `${input.taskId} complete` };
			}
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"), 8_000);
		assert.equal(new Set(workspaces).size, 2);
		assert.equal(new Set(bases).size, 1);
		assert.equal(bases[0], (await exec("git", ["rev-parse", "HEAD~3"], { cwd: f.root })).stdout.trim(), "both task branches pin the pre-integration base");
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	});

	await t.test("the next concurrent stage pins a predecessor verification repair", async (t) => {
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [
				{ id: "foundation", tasks: ["a"], mode: "sequential", checks: [{ id: "repaired", command: "test -f repaired.flag" }], review: { mode: "skip" } },
				{ id: "parallel", tasks: ["b", "c"], mode: "concurrent", checks: [], review: { mode: "skip" } },
			] },
			tasks: [task("a"), task("b"), task("c")],
		});
		let repairedHead = "";
		const secondStageBases: string[] = [];
		useProductionExecutor(f, async (input) => {
			if (input.action === "verification-repair") {
				await writeFile(join(input.cwd, "repaired.flag"), "repaired\n");
				await exec("git", ["add", "repaired.flag"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "repair stage verification"], { cwd: input.cwd });
				repairedHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
				return { text: "verification repaired" };
			}
			if (input.taskId) {
				if (input.taskId !== "a") secondStageBases.push((await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim());
				await writeFile(join(input.cwd, `${input.taskId}.txt`), `${input.taskId}\n`);
				await exec("git", ["add", `${input.taskId}.txt`], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", `implement ${input.taskId}`], { cwd: input.cwd });
				return { text: `${input.taskId} complete` };
			}
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"), 12_000);
		const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
		assert.ok(repairedHead);
		assert.equal(runtime.stages[0]?.integration.integratedCommit, repairedHead);
		assert.deepEqual(secondStageBases, [repairedHead, repairedHead], "both concurrent tasks share the durable post-repair stage head");
		assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	});
});

test("an incompatible retained workspace requires user attention once without consuming repairs", async (t) => {
	const f = await fixture(t, {});
	const staleCommit = (await exec("git", ["commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "stale harness branch"], { cwd: f.root })).stdout.trim();
	await exec("git", ["branch", "harness/example/stage/delivery", staleCommit], { cwd: f.root });
	let launches = 0;
	useProductionExecutor(f, async () => {
		launches++;
		return { text: "must not launch" };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.status, "attention"));
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	const taskState = runtime.stages[0]!.tasks[0]!;
	assert.equal(launches, 0);
	assert.equal(taskState.repairCount, 0);
	assert.equal(taskState.failure?.code, "workspace_invariant");
	assert.match(taskState.failure?.summary ?? "", /not descended from pinned stage base/);
	const events = await new StoryRuntimeStore(f.root, "example").readDebugTail(50);
	assert.equal(events.filter((event) => event.type === "action.settled").length, 1);
});

test("invalid worker commits remain isolated and never reach canonical integration", async (t) => {
	const f = await fixture(t, {});
	let taskAttempts = 0;
	useProductionExecutor(f, async (input) => {
		if (input.taskId && taskAttempts++ === 0) {
			await mkdir(join(input.cwd, "agent-artifacts"), { recursive: true });
			await writeFile(join(input.cwd, "agent-artifacts", "forbidden.txt"), "forbidden\n");
			await exec("git", ["add", "agent-artifacts/forbidden.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "invalid contribution"], { cwd: input.cwd });
			return { text: "invalid" };
		}
		if (input.taskId) return { text: "", exitCode: 1, terminalReason: "owner_lost" };
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(() => assert.equal(taskAttempts, 2));
	const taskState = (await adapter.snapshot("work-item:example", f.ctx)).runtime!.stages[0]!.tasks[0]!;
	assert.equal(taskState.contributionCommit, undefined);
	assert.equal(taskState.failure?.code, "invalid_contribution");
	await assert.rejects(access(join(f.root, "agent-artifacts", "forbidden.txt")));
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});

test("child-backed activation respects both concurrency limits and leaves excess actions pending", async (t) => {
	const gates = new Map(["a", "b", "c"].map((id) => [id, deferred<StoryWorkflowActionResult>()]));
	const launched: string[] = [];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "parallel", tasks: ["a", "b", "c"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		tasks: [task("a"), task("b"), task("c")],
		execute: async ({ action }) => {
			if (action.kind === "task-launch") { launched.push(action.taskId!); return gates.get(action.taskId!)!.promise; }
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 2;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 3;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(() => assert.deepEqual([...launched].sort(), ["a", "b"]));
	const bounded = (await adapter.snapshot("work-item:example", f.ctx)).runtime?.stages[0]?.tasks;
	assert.deepEqual(bounded?.map((entry) => entry.status), ["implementing", "implementing", "pending"], "unlaunched child work must not receive an attempt token");
	gates.get("a")!.resolve({ ...passed(), contributionCommit: "commit-a" });
	await eventually(() => assert.deepEqual(launched, ["a", "b", "c"]));
	gates.get("b")!.resolve({ ...passed(), contributionCommit: "commit-b" });
	gates.get("c")!.resolve({ ...passed(), contributionCommit: "commit-c" });
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
});

test("service-active children reduce configured session capacity before state activation", async (t) => {
	const gates = new Map(["a", "b"].map((id) => [id, deferred<StoryWorkflowActionResult>()]));
	const launched: string[] = [];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "parallel", tasks: ["a", "b"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		tasks: [task("a"), task("b")],
		execute: async ({ action }) => {
			if (action.kind === "task-launch") { launched.push(action.taskId!); return gates.get(action.taskId!)!.promise; }
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 4;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 2;
	f.runtime.launcher.activeCount = () => 1;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(() => assert.deepEqual(launched, ["a"]));
	assert.deepEqual((await adapter.snapshot("work-item:example", f.ctx)).runtime?.stages[0]?.tasks.map((entry) => entry.status), ["implementing", "pending"]);
	f.runtime.launcher.activeCount = () => 0;
	gates.get("a")!.resolve({ ...passed(), contributionCommit: "commit-a" });
	await eventually(() => assert.deepEqual(launched, ["a", "b"]));
	gates.get("b")!.resolve({ ...passed(), contributionCommit: "commit-b" });
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
});

test("deterministic checks execute even when child capacity is exhausted", async (t) => {
	const calls: string[] = [];
	const f = await fixture(t, {
		tasks: [task("task-a", [{ id: "unit", command: "true" }])],
		execute: async ({ action }) => {
			calls.push(action.kind);
			if (action.kind === "task-launch") {
				f.runtime.launcher.activeCount = () => 1;
				return { ...passed(), contributionCommit: "commit-a" };
			}
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 1;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 1;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => {
		assert.ok(calls.includes("task-check"));
		const stage = (await adapter.snapshot("work-item:example", f.ctx)).runtime?.stages[0];
		assert.equal(stage?.integration.status, "completed");
		assert.equal(stage?.verification.status, "completed");
	});
	assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.stages[0]?.tasks[0]?.status, "completed");
	assert.equal(calls.includes("final-review"), false, "child-backed review remains pending at the same capacity boundary");
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
});

test("production state drives task-check repair, integration, verification, review/fix, final review, and E2E", async (t) => {
	const calls: string[] = [];
	let taskChecks = 0;
	let verification = 0;
	let stageReviews = 0;
	let finalReviews = 0;
	let e2eRuns = 0;
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [{ id: "stage", command: "true" }], review: { mode: "required", focus: "Review the boundary." } }] },
		tasks: [task("task-a", [{ id: "unit", command: "true" }])],
		execute: async ({ action, story: receivedStory, tasks, runtime }) => {
			calls.push(action.kind);
			assert.equal(receivedStory.e2e, story.e2e);
			assert.equal(tasks.get("task-a")?.description, "Complete description for task-a.");
			if (action.kind === "task-launch") return { ...passed(), contributionCommit: "task-commit" };
			if (action.kind === "task-check" && taskChecks++ === 0) return { result: "repairable", failure: { code: "unit", summary: "unit failed" }, checks: [{ id: "unit", status: "failed" }] };
			if (action.kind === "task-repair") assert.equal(action.reason?.summary, "unit failed");
			if (action.kind === "integration") return { ...passed(), integratedCommit: "integrated" };
			if (action.kind === "verification" && verification++ === 0) return { result: "repairable", failure: { code: "stage", summary: "stage failed" }, checks: [{ id: "stage", status: "failed" }] };
			if (action.kind === "verification-repair") assert.equal(action.reason?.summary, "stage failed");
			if (action.kind === "review" && stageReviews++ === 0) return { result: "repairable", failure: { code: "review", summary: "stage finding" }, findings: [{ id: "s1", severity: "major", code: "bug", summary: "fix stage" }] };
			if (action.kind === "final-review" && finalReviews++ === 0) return { result: "repairable", failure: { code: "final", summary: "final finding" }, findings: [{ id: "f1", severity: "major", code: "bug", summary: "fix final" }] };
			if (action.kind === "e2e" && e2eRuns++ === 0) return { result: "repairable", failure: { code: "journey", summary: "journey failed" }, evidenceRefs: ["evidence/failed.txt"] };
			if (action.kind === "e2e") {
				await mkdir(join(runtime.identity.root, "agent-artifacts", "example", "evidence"), { recursive: true });
				await writeFile(join(runtime.identity.root, "agent-artifacts", "example", "evidence", "passed.txt"), "passed\n");
				return { ...passed(), evidenceRefs: ["evidence/passed.txt"] };
			}
			return passed();
		},
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
	assert.deepEqual(calls, [
		"task-launch", "task-check", "task-repair", "task-check",
		"integration", "verification", "verification-repair", "verification",
		"review", "review-fix", "review", "final-review", "final-review-fix", "final-review",
		"e2e", "e2e-fix", "e2e",
	]);
	const snapshot = await adapter.snapshot("work-item:example", f.ctx);
	assert.deepEqual(snapshot.runtime?.e2e.evidenceRefs, ["evidence/passed.txt"]);
	assert.equal(snapshot.runtime?.stages[0]?.verification.checks[0]?.status, "passed");
	assert.match(await readFile(join(f.root, "agent-artifacts", "example", "outcome.md"), "utf8"), /Final review: passed/);
});

test("E2E scratch falls back outside the repository when the preferred temporary root is local", async () => {
	const root = await mkdtemp(join(tmpdir(), "pibox-e2e-scratch-root-"));
	const localTemporaryRoot = join(root, "tmp");
	let scratch = "";
	try {
		await mkdir(localTemporaryRoot);
		scratch = await createE2eScratchDirectory(root, localTemporaryRoot);
		assert.equal(scratch === root || scratch.startsWith(`${root}${sep}`), false);
		assert.equal((await stat(scratch)).isDirectory(), true);
	} finally {
		if (scratch) await rm(scratch, { recursive: true, force: true });
		await rm(root, { recursive: true, force: true });
	}
});

test("production completion validates evidence and commits only evidence plus the complete outcome", async (t) => {
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "required", focus: "Inspect delivery." } }] },
		tasks: [task("task-a")],
	});
	const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
	await new StoryRuntimeStore(f.root, "example").upsertLedger({ id: "risk", updatedAt: new Date().toISOString(), sourceRole: "implementer", summary: "Curated integration risk", evidence: ["src/risk.ts"] });
	const evaluatorPrompts: string[] = [];
	let e2eStablePrompt = "";
	let e2eScratchDirectory = "";
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		evaluatorPrompts.push(input.attemptUserPrompt);
		if (input.role === "e2e-tester") {
			e2eStablePrompt = input.stableSystemContext;
			e2eScratchDirectory = input.env.PIBOX_E2E_SCRATCH_DIR;
			assert.equal(e2eScratchDirectory === f.root || e2eScratchDirectory.startsWith(`${f.root}${sep}`), false);
			assert.equal(input.env.PLAYWRIGHT_MCP_OUTPUT_DIR, e2eScratchDirectory, "configured tool output is contained outside the repository");
			assert.equal((await stat(e2eScratchDirectory)).isDirectory(), true);
			await writeFile(join(e2eScratchDirectory, "automatic-tool-output.log"), "transient\n");
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "journey.txt");
			await mkdir(join(evidence, ".."), { recursive: true });
			await writeFile(evidence, "journey passed\n");
			return { text: JSON.stringify({ result: "passed", summary: "journey passed", findings: [], evidenceRefs: ["evidence/journey.txt"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"), 8_000);
	const committed = (await exec("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: f.root })).stdout.trim().split("\n").filter(Boolean).sort();
	assert.deepEqual(committed, ["agent-artifacts/example/evidence/journey.txt", "agent-artifacts/example/outcome.md"]);
	assert.match(e2eStablePrompt, /working directory is the repository root/);
	assert.match(e2eStablePrompt, /\$PIBOX_E2E_SCRATCH_DIR/);
	assert.match(e2eStablePrompt, /tool-generated or intermediate output that is not retained evidence/);
	assert.match(e2eStablePrompt, /repository changes consist exclusively of the cited evidence files/);
	assert.match(e2eStablePrompt, /beneath agent-artifacts\/example\/evidence\//);
	assert.match(e2eStablePrompt, /do not create a top-level evidence\/ directory/);
	assert.match(e2eStablePrompt, /story-relative evidenceRefs such as evidence\/result\.json/);
	assert.match(e2eStablePrompt, /without the agent-artifacts\/example\/ prefix/);
	assert.doesNotMatch(e2eStablePrompt, /playwright|browser|mobile|desktop|hardware/i, "the E2E contract stays platform-neutral");
	await assert.rejects(access(e2eScratchDirectory), /ENOENT/, "disposable tool output is removed after the E2E attempt");
	assert.ok(evaluatorPrompts.length >= 3, "stage review, final review, and E2E receive dynamic attempts");
	for (const prompt of evaluatorPrompts) {
		assert.match(prompt, new RegExp(`Base commit: ${base}`));
		assert.match(prompt, /Head commit: [0-9a-f]{40}/);
		assert.match(prompt, new RegExp(`Review diff: ${base}\\.\\.[0-9a-f]{40}`));
		assert.match(prompt, /Curated integration risk/);
	}
	const outcome = await readFile(join(f.root, "agent-artifacts", "example", "outcome.md"), "utf8");
	for (const heading of ["Delivered stages", "Deterministic checks", "Review and E2E summaries", "Deviations", "Residual risks", "Metrics", "Evidence"]) assert.match(outcome, new RegExp(heading));
	assert.match(outcome, /None recorded\./);
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});

test("invalid or sensitive E2E evidence becomes outcome_failed attention", async (t) => {
	const f = await fixture(t, {});
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.role === "e2e-tester") {
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "access-token.txt");
			await mkdir(join(evidence, ".."), { recursive: true });
			await writeFile(evidence, "access_token=secret-value\n");
			return { text: JSON.stringify({ result: "passed", summary: "journey passed", findings: [], evidenceRefs: ["evidence/access-token.txt"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	assert.equal(runtime.attention?.code, "evidence_invalid", JSON.stringify(runtime));
	assert.equal(runtime.outcomeStatus, "failed");
	await assert.rejects(access(join(f.root, "agent-artifacts", "example", "outcome.md")));
});

test("same-activation reload reuses one active settlement obligation", async (t) => {
	const gate = deferred<StoryWorkflowActionResult>();
	let taskLaunches = 0;
	const f = await fixture(t, {
		execute: async ({ action }) => {
			if (action.kind === "task-launch") { taskLaunches++; return gate.promise; }
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	const beforeReload = f.create();
	await start(beforeReload, f.ctx);
	const replacement = f.create();
	await replacement.reconcileWorkflow!("work-item:example", f.ctx);
	await replacement.advanceWorkflow!("work-item:example", f.ctx);
	assert.equal(taskLaunches, 1, "reload must not duplicate the active child or terminal callback");
	gate.resolve({ ...passed(), contributionCommit: "task-commit" });
	await eventually(async () => assert.equal((await replacement.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"));
	assert.equal(taskLaunches, 1);
});

test("service owner_lost leaves the authoritative adapter attempt unsettled", async (t) => {
	const f = await fixture(t, {});
	let launches = 0;
	useProductionExecutor(f, async (input) => {
		launches++;
		assert.ok(input.tools.includes("task_clarify"));
		return { text: "", exitCode: 1, terminalReason: "owner_lost" };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(() => assert.equal(launches, 1));
	await new Promise((resolve) => setTimeout(resolve, 30));
	const taskState = (await adapter.snapshot("work-item:example", f.ctx)).runtime!.stages[0]!.tasks[0]!;
	assert.equal(taskState.status, "implementing");
	assert.ok(taskState.attempt, "owner loss must leave the durable attempt for later activation fencing");
	assert.equal(taskState.repairCount, 0);
	assert.equal(taskState.failure, undefined);
	assert.equal(launches, 1, "owner loss must not schedule a repair or call advance");
});

test("scheduler pause keeps the exclusive clock open until its last active action settles", async (t) => {
	const gate = deferred<StoryWorkflowActionResult>();
	const f = await fixture(t, {
		execute: async ({ action }) => action.kind === "task-launch" ? gate.promise : passed(),
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.metrics.open?.category, "implementation"));
	await adapter.controlExecution!("work-item:example", "pause", "pause", f.ctx);
	assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.metrics.open?.category, "implementation");
	gate.resolve({ ...passed(), contributionCommit: "commit" });
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.metrics.open, undefined));
	const metrics = (await adapter.snapshot("work-item:example", f.ctx)).runtime!.metrics;
	assert.equal(metrics.categories.implementation, 2);
	assert.equal(metrics.incompleteIntervals, 0);
	assert.deepEqual(metrics.incompleteCategories, []);
});

test("scheduler pause leaves children running while explicit stop uses the service stop boundary", async (t) => {
	let childSignal: AbortSignal | undefined;
	const gate = deferred<StoryWorkflowActionResult>();
	const f = await fixture(t, {
		execute: async ({ action, signal }) => {
			if (action.kind === "task-launch") { childSignal = signal; return gate.promise; }
			return passed();
		},
	});
	let stopped = 0;
	f.runtime.launcher.stopStory = async (storyId: string) => { assert.equal(storyId, "example"); stopped++; return 1; };
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(() => assert.ok(childSignal));
	await adapter.controlExecution!("work-item:example", "pause", "pause", f.ctx);
	assert.equal(childSignal?.aborted, false, "scheduler pause must not signal a child");
	assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.metrics.open?.category, "implementation");
	await adapter.controlExecution!("work-item:example", "stop", "stop", f.ctx);
	assert.equal(childSignal?.aborted, true);
	assert.equal(stopped, 1);
	const stoppedMetrics = (await adapter.snapshot("work-item:example", f.ctx)).runtime!.metrics;
	assert.equal(stoppedMetrics.categories.implementation, 2);
	assert.equal(stoppedMetrics.incompleteIntervals, 0);
	assert.deepEqual(stoppedMetrics.incompleteCategories, []);
	gate.resolve({ result: "repairable", failure: { code: "stopped", summary: "stopped" } });
	await new Promise((resolve) => setTimeout(resolve, 25));
	assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.status, "stopped");
});

test("isolated canonical repair accepts no harness mutation, rewrite, or unrelated commit", async (t) => {
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "required" } }] },
		tasks: [task("task-a")],
	});
	await mkdir(join(f.root, "agent-artifacts", "example"), { recursive: true });
	await writeFile(join(f.root, "agent-artifacts", "example", "story.yaml"), "reviewed: true\n");
	await exec("git", ["add", "agent-artifacts/example/story.yaml"], { cwd: f.root });
	await exec("git", ["commit", "-qm", "reviewed authored contract"], { cwd: f.root });
	let lockDepth = 0; let repairAttempts = 0; let canonicalBeforeRepair = "";
	f.runtime.mutex = { async run(_owner: string, operation: () => Promise<unknown>) { assert.equal(lockDepth, 0); lockDepth++; try { return await operation(); } finally { lockDepth--; } } };
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.role === "repair-implementer") {
			assert.equal(lockDepth, 1, "canonical mutation mutex must remain held for the managed repair worker");
			canonicalBeforeRepair ||= (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
			repairAttempts++;
			if (repairAttempts === 1) {
				await writeFile(join(input.cwd, "agent-artifacts", "example", "story.yaml"), "worker mutation\n");
				await exec("git", ["add", "agent-artifacts/example/story.yaml"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "rewrite harness contract"], { cwd: input.cwd });
			} else {
				await writeFile(join(input.cwd, "first.txt"), "first\n");
				await exec("git", ["add", "first.txt"], { cwd: input.cwd }); await exec("git", ["commit", "-qm", "first unrelated commit"], { cwd: input.cwd });
				await writeFile(join(input.cwd, "second.txt"), "second\n");
				await exec("git", ["add", "second.txt"], { cwd: input.cwd }); await exec("git", ["commit", "-qm", "second repair commit"], { cwd: input.cwd });
			}
			return { text: "repair attempted" };
		}
		return { text: JSON.stringify({ result: "repairable", summary: "repair required", findings: [{ id: "major", severity: "major", code: "bug", summary: "repair it" }] }) };
	});
	f.runtime.config.limits.repairRounds = 2;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	assert.equal(repairAttempts, 2);
	assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim(), canonicalBeforeRepair);
	assert.equal(await readFile(join(f.root, "agent-artifacts", "example", "story.yaml"), "utf8"), "reviewed: true\n");
	await assert.rejects(access(join(f.root, "first.txt")), /ENOENT/);
	await assert.rejects(access(join(f.root, "second.txt")), /ENOENT/);
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});

test("a stopped canonical repair cannot cross the mutation fence or move canonical HEAD", async (t) => {
	const repairQueued = deferred<void>();
	const releaseRepair = deferred<void>();
	let repairExecutions = 0;
	const f = await fixture(t, {
		execute: async ({ action }) => {
			if (action.kind === "task-launch") return { ...passed(), contributionCommit: "task-commit" };
			if (action.kind === "integration") return { ...passed(), integratedCommit: "integrated" };
			if (action.kind === "final-review") return { result: "repairable", failure: { code: "review", summary: "repair required" }, findings: [{ id: "major", severity: "major", code: "bug", summary: "repair it" }] };
			if (action.kind === "final-review-fix") { repairExecutions++; return passed("repaired"); }
			return passed();
		},
	});
	f.runtime.mutex.run = async (owner: string, operation: () => Promise<unknown>) => {
		if (owner.startsWith("story-repair:")) { repairQueued.resolve(); await releaseRepair.promise; return operation(); }
		if (owner.startsWith("story-stop:")) { const result = await operation(); releaseRepair.resolve(); return result; }
		return operation();
	};
	const adapter = f.create();
	await start(adapter, f.ctx);
	await repairQueued.promise;
	const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
	await adapter.controlExecution!("work-item:example", "stop", "fence-repair", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "stopped"));
	assert.equal(repairExecutions, 0, "revoked repair authority must be rechecked after acquiring the canonical fence");
	assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim(), head);
});

test("non-reload activation reconciliation interrupts a paused active owner without launching", async (t) => {
	const gate = deferred<StoryWorkflowActionResult>();
	let launches = 0;
	const f = await fixture(t, {
		owner: { sessionId: "session", processInstanceId: "process-a", activationId: "activation-a" },
		execute: async ({ action }) => {
			if (action.kind === "task-launch") { launches++; return gate.promise; }
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	const original = f.create();
	await start(original, f.ctx);
	await eventually(() => assert.equal(launches, 1));
	await original.controlExecution!("work-item:example", "pause", "pause-active", f.ctx);
	assert.equal((await original.snapshot("work-item:example", f.ctx)).runtime.status, "paused");
	f.setOwner({ sessionId: "session", processInstanceId: "process-b", activationId: "activation-b" });
	const replacement = f.create();
	await replacement.reconcileActivation!(f.ctx);
	const interrupted = (await replacement.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(interrupted.status, "paused");
	assert.equal(interrupted.stages[0]?.tasks[0]?.status, "interrupted");
	assert.equal(interrupted.activationOwner, undefined);
	assert.equal(interrupted.metrics.open, undefined);
	assert.equal(interrupted.metrics.incompleteIntervals, 1);
	assert.deepEqual(interrupted.metrics.incompleteCategories, ["implementation"]);
	assert.equal(launches, 1, "startup reconciliation must not bind or launch work");
	await replacement.controlExecution!("work-item:example", "resume", "explicit-resume", f.ctx);
	await replacement.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(() => assert.equal(launches, 2));
	gate.resolve({ ...passed(), contributionCommit: "fresh" });
	await eventually(async () => assert.equal((await replacement.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
});

test("different activation interrupts old ownership and explicit resume creates a fresh fenced attempt", async (t) => {
	const attempts = [deferred<StoryWorkflowActionResult>(), deferred<StoryWorkflowActionResult>()];
	const tokens: string[] = [];
	const owners: string[] = [];
	const f = await fixture(t, {
		owner: { sessionId: "session", processInstanceId: "process", activationId: "activation-a" },
		execute: async ({ action, token, owner }) => {
			if (action.kind === "task-launch") {
				tokens.push(token); owners.push(owner.activationId);
				return attempts[tokens.length - 1]!.promise;
			}
			return action.kind === "integration" ? { ...passed(), integratedCommit: "integrated" } : passed();
		},
	});
	await start(f.create(), f.ctx);
	f.setOwner({ sessionId: "session", processInstanceId: "process-b", activationId: "activation-b" });
	const replacement = f.create();
	await replacement.controlExecution!("work-item:example", "resume", "explicit-resume", f.ctx);
	await replacement.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(() => assert.equal(tokens.length, 2));
	assert.notEqual(tokens[0], tokens[1]);
	assert.deepEqual(owners, ["activation-a", "activation-b"]);
	const recoveredMetrics = (await replacement.snapshot("work-item:example", f.ctx)).runtime!.metrics;
	assert.equal(recoveredMetrics.incompleteIntervals, 1);
	assert.deepEqual(recoveredMetrics.incompleteCategories, ["implementation"]);
	attempts[0]!.resolve({ ...passed("stale"), contributionCommit: "old-commit" });
	await eventually(async () => {
		const taskState = (await replacement.snapshot("work-item:example", f.ctx)).runtime?.stages[0]?.tasks[0];
		assert.equal(taskState?.status, "implementing");
		assert.equal(taskState?.attempt?.token, tokens[1]);
	});
	attempts[1]!.resolve({ ...passed("fresh"), contributionCommit: "new-commit" });
	await eventually(async () => {
		const runtime = (await replacement.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(runtime?.stages[0]?.tasks[0]?.contributionCommit, "new-commit");
		assert.equal(runtime?.outcomeStatus, "written");
	});
});
