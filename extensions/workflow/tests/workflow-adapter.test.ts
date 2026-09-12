import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { parse } from "yaml";
import type { RuntimeOwner } from "../../subagent/api.js";
import { WorkflowRunner } from "../../workflow-runtime/runner.js";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { emptyWorkflowMetrics, StoryRuntimeStore } from "../story-runtime-store.js";
import { checkFailureSummary, createE2eScratchDirectory, createHarnessWorkflowAdapter, recoverScheduledMessagesE2eOnce, reconcileHarnessActivation, reconcileWorkflowClockForActiveActions, runShell, selectWorkflowClockForActiveActions, workflowMetricCategoryForAction, type StoryWorkflowActionExecutor, type StoryWorkflowActionResult } from "../workflow-adapter.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../types.js";
import { renderDesign, renderE2e, renderSpec } from "../authored-markdown.js";
import { writeLedgerSubmission } from "../ledger-submission.js";
import { readE2eReportSubmission, submitE2eReport, type E2eReportSubmission, type WorkflowE2eReportInput } from "../e2e-report-submission.js";

const exec = promisify(execFile);

interface FixtureOptions {
	story?: StoryDocument;
	plan?: StoryPlanDocument;
	tasks?: AuthoredTaskDocument[];
	execute?: StoryWorkflowActionExecutor;
	owner?: RuntimeOwner;
	now?: () => Date;
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
	const fixtureStory = options.story ?? story;
	const tasks = options.tasks ?? [task("task-a")];
	const plan = options.plan ?? { schemaVersion: 1, stages: [{ id: "delivery", tasks: tasks.map((entry) => entry.id), mode: "sequential", checks: [], review: { mode: "skip" } }] };
	let owner = options.owner ?? { sessionId: `session-${root}`, processInstanceId: "process", activationId: "activation-a" };
	const capacityListeners = new Set<() => void>();
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: join(root, ".git", "pibox"), commonDir: join(root, ".git") },
		workItems: {
			async readStory() { return fixtureStory; },
			async readStoryPlan() { return plan; },
			async readAuthoredTask(_storyId: string, id: string) { return tasks.find((entry) => entry.id === id)!; },
			async listAuthoredTasks() { return tasks; },
			async findDelivery() { return { workingBranch: "feature/example", createdFromCommit: "fixture" }; },
			async list() { return [{ id: fixtureStory.id }]; },
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
	const create = () => createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, ...(options.execute ? { executeAction: options.execute } : {}), now: options.now ?? (() => { let tick = 0; return () => new Date(1_700_000_000_000 + tick++); })() });
	return {
		root, runtime, ctx, create, story: fixtureStory,
		fireCapacity() { for (const listener of capacityListeners) listener(); },
		setOwner(value: RuntimeOwner) { owner = value; },
	};
}

async function submitE2eFixture(f: Awaited<ReturnType<typeof fixture>>, input: any, submission: WorkflowE2eReportInput): Promise<string> {
	await mkdir(f.runtime.identity.privateRoot, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(f.runtime.identity.privateRoot, "e2e-fixture-report-"));
	await chmod(directory, 0o700);
	const reportPath = join(directory, "report.md");
	await submitE2eReport({ reportPath, repositoryRoot: f.root, attemptToken: input.attemptToken, storyE2e: story.e2e, submission });
	return reportPath;
}

function useProductionExecutor(f: Awaited<ReturnType<typeof fixture>>, launch: (input: any) => Promise<{ text: string; exitCode?: number; stderr?: string; terminalReason?: string; reportPath?: string }>): void {
	f.runtime.config = structuredClone(DEFAULT_HARNESS_CONFIG);
	f.runtime.launcher.launch = async (input: any) => {
		let terminal = await launch(input);
		if (input.action === "e2e" && !terminal.reportPath && (terminal.exitCode ?? 0) === 0) {
			try {
				const legacy = JSON.parse(terminal.text) as { result: string; summary?: string; findings?: Array<{ summary: string; severity?: "minor" | "major" | "critical" }>; evidenceRefs?: string[] };
				const evidence = legacy.evidenceRefs?.map((reference) => join(f.root, "agent-artifacts", story.id, reference));
				const findings = legacy.findings?.map((finding) => ({ summary: finding.summary, ...(finding.severity ? { severity: finding.severity } : {}) }));
				const reportPath = await submitE2eFixture(f, input, { cases: [{ case: "E2E-001", verdict: legacy.result === "passed" ? "passed" : legacy.result === "needs_user" ? "blocked" : "failed", ...(evidence?.length ? { evidence } : {}) }], ...(legacy.summary === undefined ? {} : { summary: legacy.summary }), ...(findings?.length ? { findings } : legacy.result === "critical" || legacy.result === "unsafe" ? { findings: [{ summary: legacy.summary ?? legacy.result, severity: "critical" }] } : {}) });
				for (const source of evidence ?? []) await rm(source, { force: true });
				terminal = { ...terminal, reportPath };
			} catch (error) {
				terminal = { ...terminal, exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
			}
		}
		return { exitCode: terminal.exitCode ?? 0, text: terminal.text, stderr: terminal.stderr ?? "", terminalReason: terminal.terminalReason ?? "completed", ...(terminal.reportPath ? { reportPath: terminal.reportPath } : {}), provider: input.provider, model: input.model, effort: input.effort, serviceAttemptId: input.attemptToken };
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

async function lifecycleEvents(adapter: ReturnType<typeof createHarnessWorkflowAdapter>, ctx: any) {
	let pending = 0;
	const waiters: Array<() => void> = [];
	const subscription = await adapter.subscribeLifecycle!("work-item:example", ctx, () => {
		const waiter = waiters.shift();
		if (waiter) waiter(); else pending++;
	});
	const unsubscribe = typeof subscription === "function" ? subscription : () => {};
	return {
		async waitFor(predicate: (state: NonNullable<Awaited<ReturnType<StoryRuntimeStore["readState"]>>>) => boolean) {
			for (;;) {
				const state = await adapter.snapshot("work-item:example", ctx).then((snapshot) => snapshot.runtime!);
				if (predicate(state)) return state;
				if (pending > 0) pending--; else await new Promise<void>((resolve) => waiters.push(resolve));
			}
		},
		unsubscribe,
	};
}

const passed = (summary = "passed"): StoryWorkflowActionResult => ({ result: "passed", summary: { code: "passed", summary } });

test("all repair actions use Repair while normal actions retain existing categories", () => {
	for (const kind of ["task-repair", "integration-repair", "verification-repair", "review-fix", "final-review-fix", "e2e-fix"] as const) {
		const action = kind === "task-repair" ? { kind, stageId: "delivery", taskId: "task-a" } : { kind, stageId: "delivery" };
		assert.equal(workflowMetricCategoryForAction(action), "repair", kind);
	}
	assert.deepEqual([
		workflowMetricCategoryForAction({ kind: "task-launch", stageId: "delivery", taskId: "task-a" }),
		workflowMetricCategoryForAction({ kind: "task-check", stageId: "delivery", taskId: "task-a" }),
		workflowMetricCategoryForAction({ kind: "integration", stageId: "delivery" }),
		workflowMetricCategoryForAction({ kind: "verification", stageId: "delivery" }),
		workflowMetricCategoryForAction({ kind: "review", stageId: "delivery" }),
		workflowMetricCategoryForAction({ kind: "e2e" }),
	], ["implementation", "implementation", "integration", "verification", "review", "e2e"]);
});

test("active clock selection keeps Repair across parallel starts and settlements", () => {
	const implementation = { kind: "task-launch" as const, stageId: "delivery", taskId: "normal" };
	const firstRepair = { kind: "task-repair" as const, stageId: "delivery", taskId: "repair-a" };
	const secondRepair = { kind: "task-repair" as const, stageId: "delivery", taskId: "repair-b" };
	assert.deepEqual(selectWorkflowClockForActiveActions([firstRepair, implementation]), { category: "repair", stageId: "delivery" }, "normal start after repair cannot steal clock");
	assert.deepEqual(selectWorkflowClockForActiveActions([implementation, firstRepair, secondRepair]), { category: "repair", stageId: "delivery" }, "repair wins regardless of activation order");
	assert.deepEqual(selectWorkflowClockForActiveActions([implementation, secondRepair]), { category: "repair", stageId: "delivery" }, "one repair settlement leaves Repair open");
	assert.deepEqual(selectWorkflowClockForActiveActions([implementation]), { category: "implementation", stageId: "delivery" }, "last repair settlement falls back immediately");
	assert.equal(selectWorkflowClockForActiveActions([]), undefined, "last active settlement closes clock");
});

test("exact wall clock handles both parallel implementation/repair finish orders", () => {
	const implementation = { kind: "task-launch" as const, stageId: "delivery", taskId: "normal" };
	const repairA = { kind: "task-repair" as const, stageId: "delivery", taskId: "repair-a" };
	const repairB = { kind: "task-repair" as const, stageId: "delivery", taskId: "repair-b" };
	const at = (seconds: number) => `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
	const run = (normalFinishesFirst: boolean) => {
		let metrics = reconcileWorkflowClockForActiveActions(emptyWorkflowMetrics(), [implementation], at(0));
		metrics = reconcileWorkflowClockForActiveActions(metrics, [repairA], at(10));
		metrics = reconcileWorkflowClockForActiveActions(metrics, [repairA, repairB, implementation], at(12));
		metrics = reconcileWorkflowClockForActiveActions(metrics, normalFinishesFirst ? [repairA, repairB] : [repairB, implementation], at(20));
		metrics = reconcileWorkflowClockForActiveActions(metrics, normalFinishesFirst ? [repairB] : [implementation], at(25));
		return reconcileWorkflowClockForActiveActions(metrics, [], at(30));
	};
	const normalFirst = run(true);
	assert.equal(normalFirst.workflowMs, 30_000);
	assert.equal(normalFirst.categories.implementation, 10_000);
	assert.equal(normalFirst.categories.repair, 20_000);
	const repairsFirst = run(false);
	assert.equal(repairsFirst.workflowMs, 30_000);
	assert.equal(repairsFirst.categories.implementation, 15_000);
	assert.equal(repairsFirst.categories.repair, 15_000);
});

async function start(adapter: ReturnType<typeof createHarnessWorkflowAdapter>, ctx: any) {
	await adapter.controlExecution!("work-item:example", "start", "start", ctx);
	await adapter.advanceWorkflow!("work-item:example", ctx);
}

test("serialized lifecycle transitions enforce Repair priority and settlement fallback", async (t) => {
	for (const normalFinishesFirst of [false, true]) await t.test(normalFinishesFirst ? "normal settles first" : "repair settles first", async (t) => {
		const base = Date.parse("2026-01-01T00:00:00.000Z");
		let currentMs = base;
		const setSecond = (second: number) => { currentMs = base + second * 1_000; };
		const launchA = deferred<StoryWorkflowActionResult>();
		const repairA = deferred<StoryWorkflowActionResult>();
		const launchB = deferred<StoryWorkflowActionResult>();
		const startedA = deferred<void>();
		const startedRepair = deferred<void>();
		const startedB = deferred<void>();
		const f = await fixture(t, {
			now: () => new Date(currentMs),
			tasks: [task("a"), task("b")],
			plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["a", "b"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
			execute: async ({ action }) => {
				if (action.kind === "task-launch" && action.taskId === "a") { startedA.resolve(); return launchA.promise; }
				if (action.kind === "task-repair" && action.taskId === "a") { startedRepair.resolve(); return repairA.promise; }
				if (action.kind === "task-launch" && action.taskId === "b") { startedB.resolve(); return launchB.promise; }
				return passed();
			},
		});
		f.runtime.config.limits.maxConcurrency = 1;
		f.runtime.config.limits.maxActiveSubagentsPerSession = 1;
		const adapter = f.create();
		const events = await lifecycleEvents(adapter, f.ctx);
		t.after(events.unsubscribe);
		await start(adapter, f.ctx);
		await startedA.promise;
		setSecond(10);
		launchA.resolve({ result: "repairable", failure: { code: "task_failed", summary: "repair A" } });
		await startedRepair.promise;
		await events.waitFor((state) => state.stages[0]?.tasks[0]?.status === "repairing" && state.metrics.open?.category === "repair");

		f.runtime.config.limits.maxConcurrency = 2;
		f.runtime.config.limits.maxActiveSubagentsPerSession = 2;
		setSecond(12);
		await adapter.advanceWorkflow!("work-item:example", f.ctx);
		await startedB.promise;
		let state = await events.waitFor((candidate) => candidate.stages[0]?.tasks[1]?.status === "implementing");
		assert.deepEqual(state.metrics.open, { category: "repair", since: "2026-01-01T00:00:10.000Z", stageId: "delivery" }, "later normal activation cannot steal or checkpoint Repair");
		assert.equal(state.metrics.categories.implementation, 10_000);

		if (normalFinishesFirst) {
			await adapter.controlExecution!("work-item:example", "pause", "pause-mixed", f.ctx);
			setSecond(20);
			launchB.resolve({ ...passed(), contributionCommit: "b" });
			state = await events.waitFor((candidate) => candidate.stages[0]?.tasks[1]?.status !== "implementing");
			assert.equal(state.metrics.open?.category, "repair", "normal settlement cannot close active Repair");
			setSecond(30);
			repairA.resolve({ ...passed(), contributionCommit: "fixed-a" });
			state = await events.waitFor((candidate) => candidate.metrics.open === undefined);
			assert.equal(state.metrics.categories.implementation, 10_000);
			assert.equal(state.metrics.categories.repair, 20_000);
		} else {
			setSecond(20);
			repairA.resolve({ ...passed(), contributionCommit: "fixed-a" });
			state = await events.waitFor((candidate) => candidate.metrics.open?.category === "implementation" && candidate.stages[0]?.tasks[1]?.status === "implementing");
			assert.equal(state.metrics.categories.repair, 10_000, "last Repair settlement immediately falls back to live implementation");
			await adapter.controlExecution!("work-item:example", "pause", "pause-normal", f.ctx);
			setSecond(30);
			launchB.resolve({ ...passed(), contributionCommit: "b" });
			state = await events.waitFor((candidate) => candidate.metrics.open === undefined);
			assert.equal(state.metrics.categories.implementation, 20_000);
			assert.equal(state.metrics.categories.repair, 10_000);
		}
		assert.equal(state.status, "paused");
		assert.equal(state.metrics.workflowMs, 30_000);
		assert.equal(Object.values(state.metrics.categories).reduce((sum, value) => sum + value, 0), 30_000);
		assert.equal(state.metrics.stageBreakdown?.delivery?.workflowMs, 30_000);
	});
});

test("ledger attention reconciles against remaining active Repair and implementation", async (t) => {
	const base = Date.parse("2026-01-01T00:00:00.000Z");
	let currentMs = base;
	const setSecond = (second: number) => { currentMs = base + second * 1_000; };
	const launchA = deferred<StoryWorkflowActionResult>();
	const repairA = deferred<StoryWorkflowActionResult>();
	const launchB = deferred<StoryWorkflowActionResult>();
	const launchC = deferred<StoryWorkflowActionResult>();
	const startedRepair = deferred<void>();
	const startedB = deferred<void>();
	const startedC = deferred<void>();
	const f = await fixture(t, {
		now: () => new Date(currentMs),
		tasks: [task("a"), task("b"), task("c")],
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["a", "b", "c"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		execute: async ({ action }) => {
			if (action.kind === "task-launch" && action.taskId === "a") return launchA.promise;
			if (action.kind === "task-repair") { startedRepair.resolve(); return repairA.promise; }
			if (action.kind === "task-launch" && action.taskId === "b") { startedB.resolve(); return launchB.promise; }
			if (action.kind === "task-launch" && action.taskId === "c") { startedC.resolve(); return launchC.promise; }
			return passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 1;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 1;
	const adapter = f.create();
	const events = await lifecycleEvents(adapter, f.ctx);
	t.after(events.unsubscribe);
	await start(adapter, f.ctx);
	setSecond(10);
	launchA.resolve({ result: "repairable", failure: { code: "task_failed", summary: "repair A" } });
	await startedRepair.promise;
	await events.waitFor((state) => state.metrics.open?.category === "repair");
	f.runtime.config.limits.maxConcurrency = 3;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 3;
	setSecond(12);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await Promise.all([startedB.promise, startedC.promise]);

	setSecond(20);
	launchB.resolve({ ...passed(), contributionCommit: "b", ledgerSubmissionError: "malformed optional submission", ledgerReportPath: "/tmp/b/report.md" });
	let state = await events.waitFor((candidate) => candidate.status === "attention" && Boolean(candidate.ledgerRecoveries && Object.keys(candidate.ledgerRecoveries).length));
	assert.equal(state.metrics.open?.category, "repair", "ledger attention keeps active Repair authoritative");
	setSecond(25);
	repairA.resolve({ ...passed(), contributionCommit: "fixed-a" });
	state = await events.waitFor((candidate) => candidate.metrics.open?.category === "implementation" && candidate.stages[0]?.tasks[2]?.status === "implementing");
	assert.equal(state.status, "attention");
	assert.equal(state.metrics.categories.repair, 15_000, "accepted Repair settlement falls back under attention");
	setSecond(30);
	launchC.resolve({ ...passed(), contributionCommit: "c" });
	state = await events.waitFor((candidate) => candidate.metrics.open === undefined);
	assert.equal(state.metrics.workflowMs, 30_000);
	assert.equal(state.metrics.categories.implementation, 15_000);
	assert.equal(state.metrics.categories.repair, 15_000);
	assert.equal(Object.values(state.metrics.categories).reduce((sum, value) => sum + value, 0), 30_000);
});

test("stop fences late Repair settlement from reopening or crediting clock", async (t) => {
	const base = Date.parse("2026-01-01T00:00:00.000Z");
	let currentMs = base;
	const setSecond = (second: number) => { currentMs = base + second * 1_000; };
	const launchA = deferred<StoryWorkflowActionResult>();
	const repairA = deferred<StoryWorkflowActionResult>();
	const launchB = deferred<StoryWorkflowActionResult>();
	const startedRepair = deferred<void>();
	const startedB = deferred<void>();
	const returnedRepair = deferred<void>();
	const returnedB = deferred<void>();
	const f = await fixture(t, {
		now: () => new Date(currentMs),
		tasks: [task("a"), task("b")],
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["a", "b"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		execute: async ({ action }) => {
			if (action.kind === "task-launch" && action.taskId === "a") return launchA.promise;
			if (action.kind === "task-repair") { startedRepair.resolve(); const result = await repairA.promise; returnedRepair.resolve(); return result; }
			if (action.kind === "task-launch" && action.taskId === "b") { startedB.resolve(); const result = await launchB.promise; returnedB.resolve(); return result; }
			return passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 1;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 1;
	const adapter = f.create();
	const events = await lifecycleEvents(adapter, f.ctx);
	t.after(events.unsubscribe);
	await start(adapter, f.ctx);
	setSecond(10);
	launchA.resolve({ result: "repairable", failure: { code: "task_failed", summary: "repair A" } });
	await startedRepair.promise;
	f.runtime.config.limits.maxConcurrency = 2;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 2;
	setSecond(12);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await startedB.promise;
	await events.waitFor((state) => state.metrics.open?.category === "repair" && state.stages[0]?.tasks[1]?.status === "implementing");
	setSecond(20);
	await adapter.controlExecution!("work-item:example", "stop", "stop-mixed", f.ctx);
	const stopped = await events.waitFor((state) => state.status === "stopped");
	assert.equal(stopped.metrics.workflowMs, 20_000);
	assert.equal(stopped.metrics.categories.implementation, 10_000);
	assert.equal(stopped.metrics.categories.repair, 10_000);
	assert.equal(stopped.metrics.open, undefined);

	setSecond(30);
	repairA.resolve({ ...passed(), contributionCommit: "late-repair" });
	launchB.resolve({ ...passed(), contributionCommit: "late-b" });
	await Promise.all([returnedRepair.promise, returnedB.promise]);
	await adapter.controlExecution!("work-item:example", "stop", "serialize-late-results", f.ctx);
	const afterLate = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	assert.equal(afterLate.status, "stopped");
	assert.deepEqual(afterLate.metrics, stopped.metrics);
});

const recoveryReports = [
	"evidence/retest-complete-20260912.json",
	"evidence/retest-complete-20260912-auth.json",
	"evidence/retest-complete-20260912-calendar.json",
	"evidence/retest-complete-20260912-deterministic.json",
	"evidence/retest-complete-20260912-model.json",
	"evidence/retest-complete-20260912-native.json",
	"evidence/retest-complete-20260912-restart.json",
	"evidence/retest-complete-20260912-web.json",
];
const recoveryOldReports = Array.from({ length: 5 }, (_, index) => `evidence/retained-${index + 1}.json`);
const recoveryRef = "work-item:scheduled-messages-completion";

async function recoveryFixture(t: test.TestContext, options: FixtureOptions = {}) {
	const namedStory = { ...story, id: "scheduled-messages-completion", title: "Scheduled messages completion" };
	const f = await fixture(t, { ...options, story: namedStory });
	const initial = (await f.create().snapshot(recoveryRef, f.ctx)).runtime;
	for (const reference of [...recoveryOldReports, ...recoveryReports]) {
		const path = join(f.root, "agent-artifacts", namedStory.id, reference);
		await mkdir(join(path, ".."), { recursive: true });
		await writeFile(path, `${JSON.stringify({ reference })}\n`);
	}
	const failure = { code: "evidence_invalid", summary: "legacy report registration failed", diagnostic: { checkId: "e2e-evidence", command: "retain reports", exitCode: 1, stdout: "", stderr: "all eight reports rejected", outputTruncated: false } };
	const state = structuredClone(initial);
	state.status = "paused";
	state.activationOwner = f.runtime.launcher.service.owner;
	state.attention = failure;
	state.attentionEpoch = 17;
	state.attentionTarget = { kind: "e2e" };
	state.outcomeStatus = "failed";
	for (const stage of state.stages) {
		stage.status = "completed";
		for (const taskState of stage.tasks) { taskState.status = "completed"; taskState.contributionCommit = "retained-contribution"; }
		stage.integration = { status: "completed", repairCount: 2, contributionCommits: ["retained-contribution"], integratedCommit: "retained-integration", result: { code: "passed", summary: "integrated" } };
		stage.verification.status = "completed";
		stage.review.status = stage.review.status === "skipped" ? "skipped" : "completed";
	}
	state.finalReview = { status: "completed", iteration: 3, repairCount: 4, currentFindings: [], result: { code: "passed", summary: "reviewed" } };
	state.e2e = {
		status: "attention", repairCount: 13, evidenceRefs: [...recoveryOldReports], failure,
		currentEvidenceRefs: [recoveryOldReports[4]!],
		currentFindings: [{ id: "legacy", severity: "major", code: "evidence", summary: "registration failed" }],
	};
	await new StoryRuntimeStore(f.root, namedStory.id).writeState(state);
	return { ...f, store: new StoryRuntimeStore(f.root, namedStory.id), state };
}

const recoveryInput = () => ({ ref: recoveryRef, attentionEpoch: 17, reportPaths: [...recoveryReports] });

test("one-time legacy E2E recovery changes only approved state and ordinary resume launches fresh E2E", async (t) => {
	const actions: string[] = [];
	const gate = deferred<StoryWorkflowActionResult>();
	const f = await recoveryFixture(t, { execute: async ({ action }) => { actions.push(action.kind); return gate.promise; } });
	const evidenceBefore = new Map(await Promise.all([...recoveryOldReports, ...recoveryReports].map(async (reference) => [reference, await readFile(join(f.root, "agent-artifacts", f.story.id, reference))] as const)));
	let launches = 0; f.runtime.launcher.launch = async () => { launches++; throw new Error("recovery must not launch"); };
	const result = await recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput());
	assert.deepEqual(result, { workflowRef: recoveryRef, status: "recovered-paused", nextAction: "workflow_control resume" });
	assert.equal(launches, 0);
	const recovered = (await f.store.readState())!;
	const expected = structuredClone(f.state);
	expected.e2e.evidenceRefs.push(...recoveryReports);
	expected.e2e.status = "interrupted";
	expected.e2e.interruptedFrom = "testing";
	expected.outcomeStatus = "pending";
	delete expected.attention; delete expected.attentionTarget; delete expected.activationOwner;
	assert.deepEqual(recovered, expected, "state diff is limited to approved recovery fields");
	for (const [reference, contents] of evidenceBefore) assert.deepEqual(await readFile(join(f.root, "agent-artifacts", f.story.id, reference)), contents);
	await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput()), /approved legacy E2E recovery state/);
	const adapter = f.create();
	assert.deepEqual(await adapter.preflightWorkflow!(recoveryRef, f.ctx), { ok: true });
	await adapter.controlExecution!(recoveryRef, "resume", "resume", f.ctx);
	await adapter.advanceWorkflow!(recoveryRef, f.ctx);
	await eventually(() => assert.deepEqual(actions, ["e2e"]));
	assert.equal((await f.store.readState())!.e2e.repairCount, 13);
	gate.resolve({ result: "needs_user", failure: { code: "fixture_stop", summary: "stop after launch proof" } });
	await eventually(async () => assert.equal((await f.store.readState())!.status, "attention"));
	assert.equal(actions.some((action) => action.includes("fix")), false);
});

test("one-time legacy E2E recovery rejects mismatched, unsafe, active, dirty, and stale inputs without mutation", async (t) => {
	const cases: Array<{ name: string; mutate?: (state: any) => void; input?: () => ReturnType<typeof recoveryInput>; prepare?: (f: Awaited<ReturnType<typeof recoveryFixture>>) => Promise<void>; pattern: RegExp }> = [
		{ name: "wrong target", mutate: (state) => { state.attentionTarget = { kind: "final-review" }; state.finalReview.status = "attention"; }, pattern: /approved legacy E2E recovery state/ },
		{ name: "wrong epoch", input: () => ({ ...recoveryInput(), attentionEpoch: 16 }), pattern: /epoch 17/ },
		{ name: "wrong status", mutate: (state) => { state.status = "attention"; }, pattern: /approved legacy E2E recovery state/ },
		{ name: "wrong path set", input: () => ({ ...recoveryInput(), reportPaths: recoveryReports.slice(0, 7) }), pattern: /exact eight/ },
		{ name: "Critical finding", mutate: (state) => { state.e2e.currentFindings![0]!.severity = "critical"; }, pattern: /Critical/ },
		{ name: "durable attempt", mutate: (state) => { state.e2e.attempt = { token: "active", owner: { sessionId: "s", processInstanceId: "p", activationId: "a" }, activatedAt: "2026-09-12T00:00:00.000Z" }; }, pattern: /active attempts/ },
		{ name: "ledger recovery", mutate: (state) => { state.ledgerRecoveries = { token: { action: "e2e", attemptToken: "token", sourceRole: "e2e-tester", reportPath: "/tmp/report", error: "failed" } }; }, pattern: /ledger recovery/ },
		{ name: "foreign dirt", prepare: async (f) => { await writeFile(join(f.root, "foreign.txt"), "foreign\n"); }, pattern: /Git dirt/ },
		{ name: "staged report", prepare: async (f) => { await exec("git", ["add", `agent-artifacts/${f.story.id}/${recoveryReports[0]}`], { cwd: f.root }); }, pattern: /Git dirt/ },
		{ name: "tracked modified report", prepare: async (f) => {
			const path = `agent-artifacts/${f.story.id}/${recoveryReports[0]}`;
			await exec("git", ["add", path], { cwd: f.root }); await exec("git", ["commit", "-qm", "track report"], { cwd: f.root });
			await writeFile(join(f.root, path), "modified\n");
		}, pattern: /Git dirt/ },
		{ name: "renamed report", prepare: async (f) => {
			const source = `agent-artifacts/${f.story.id}/${recoveryReports[0]}`;
			const target = `agent-artifacts/${f.story.id}/${recoveryReports[1]}`;
			await exec("git", ["add", source], { cwd: f.root }); await exec("git", ["commit", "-qm", "track report"], { cwd: f.root });
			await rm(join(f.root, target)); await exec("git", ["mv", source, target], { cwd: f.root }); await writeFile(join(f.root, source), "replacement\n");
		}, pattern: /Git dirt/ },
		{ name: "ignored report", prepare: async (f) => { await writeFile(join(f.root, ".git", "info", "exclude"), `agent-artifacts/${f.story.id}/${recoveryReports[0]}\n`); }, pattern: /ignored/ },
	];
	for (const entry of cases) await t.test(entry.name, async (t) => {
		const f = await recoveryFixture(t);
		if (entry.mutate) { const changed = structuredClone(f.state); entry.mutate(changed); await f.store.writeState(changed); }
		await entry.prepare?.(f);
		const before = await f.store.readState();
		await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, (entry.input ?? recoveryInput)()), entry.pattern);
		assert.deepEqual(await f.store.readState(), before);
	});
	await t.test("stale concurrent state", async (t) => {
		const f = await recoveryFixture(t); let changed = false;
		f.runtime.evidenceDescriptorOpened = async () => { if (changed) return; changed = true; await f.store.updateState((state) => ({ ...state!, attention: { ...state!.attention!, summary: "concurrent change" } })); };
		await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput()), /state changed/);
		assert.equal((await f.store.readState())!.attention?.summary, "concurrent change");
	});
	await t.test("changed evidence", async (t) => {
		const f = await recoveryFixture(t); let opens = 0;
		f.runtime.evidenceDescriptorOpened = async () => { if (++opens === 27) await writeFile(join(f.root, "agent-artifacts", f.story.id, recoveryReports[0]!), "changed\n"); };
		const before = await f.store.readState();
		await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput()), /evidence changed/);
		assert.deepEqual(await f.store.readState(), before);
	});
	await t.test("contract and HEAD change during contract load", async (t) => {
		const f = await recoveryFixture(t); let currentStory = f.story; let changed = false;
		f.runtime.workItems.readStory = async () => {
			const captured = currentStory;
			if (!changed) {
				changed = true; currentStory = { ...currentStory, title: "Changed contract" };
				await exec("git", ["commit", "--allow-empty", "-qm", "change contracts"], { cwd: f.root });
			}
			return captured;
		};
		const before = await f.store.readState();
		await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput()), /HEAD changed/);
		assert.deepEqual(await f.store.readState(), before);
	});
	await t.test("same-HEAD branch switch before serialized mutation", async (t) => {
		const f = await recoveryFixture(t); let opens = 0;
		f.runtime.evidenceDescriptorOpened = async () => { if (++opens === 27) await exec("git", ["switch", "-qc", "feature/same-head"], { cwd: f.root }); };
		const before = await f.store.readState();
		await assert.rejects(recoverScheduledMessagesE2eOnce(f.runtime, recoveryInput()), /canonical branch/);
		assert.deepEqual(await f.store.readState(), before);
	});
});

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

test("integration repair accepts full pinned ranges after partial concurrent cherry-picks", async (t) => {
	const tasks = [task("gateway"), task("ios")];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["gateway", "ios"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		tasks,
	});
	await writeFile(join(f.root, "shared.txt"), "base\n");
	await exec("git", ["add", "shared.txt"], { cwd: f.root });
	await exec("git", ["commit", "-qm", "shared base"], { cwd: f.root });
	let gatewayHead = ""; let iosHead = ""; let repairBase = ""; let repairPrompt = "";
	useProductionExecutor(f, async (input) => {
		if (input.taskId === "gateway") {
			for (let index = 0; index < 5; index++) {
				if (index === 0) await writeFile(join(input.cwd, "shared.txt"), "gateway\n");
				else await writeFile(join(input.cwd, `gateway-${index}.txt`), `gateway ${index}\n`);
				await exec("git", ["add", "."], { cwd: input.cwd });
				const date = `2001-01-01T00:00:0${index}Z`;
				await exec("git", ["commit", "-qm", `gateway ${index + 1}`], { cwd: input.cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
			}
			gatewayHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
			return { text: "gateway complete" };
		}
		if (input.taskId === "ios") {
			await writeFile(join(input.cwd, "shared.txt"), "ios\n");
			await writeFile(join(input.cwd, "ios.txt"), "ios\n");
			await exec("git", ["add", "."], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "ios"], { cwd: input.cwd, env: { ...process.env, GIT_AUTHOR_DATE: "2001-01-02T00:00:00Z", GIT_COMMITTER_DATE: "2001-01-02T00:00:00Z" } });
			iosHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
			return { text: "ios complete" };
		}
		if (input.action === "integration-repair") {
			repairBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
			repairPrompt = input.attemptUserPrompt;
			assert.equal((await exec("git", ["merge-base", "--is-ancestor", gatewayHead, repairBase], { cwd: f.root }).then(() => true, () => false)), false, "canonical has patch-equivalent gateway commits, not the exact contribution history");
			assert.equal(await readFile(join(input.cwd, "gateway-4.txt"), "utf8"), "gateway 4\n", "successful cherry-picks remain on canonical before repair");
			await assert.rejects(access(join(input.cwd, "ios.txt")), /ENOENT/, "the conflicting iOS contribution has not reached canonical");
			await exec("git", ["merge", "--no-ff", "--no-commit", "-s", "ours", gatewayHead, iosHead], { cwd: input.cwd });
			await writeFile(join(input.cwd, "shared.txt"), "gateway + ios\n");
			await writeFile(join(input.cwd, "ios.txt"), "ios\n");
			await exec("git", ["add", "shared.txt", "ios.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "final integration repair"], { cwd: input.cwd });
			return { text: "integrated exact contribution ancestry" };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 12_000);
	const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
	assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "gateway + ios\n");
	assert.equal(await readFile(join(f.root, "gateway-4.txt"), "utf8"), "gateway 4\n");
	assert.equal(await readFile(join(f.root, "ios.txt"), "utf8"), "ios\n");
	for (const pinned of [gatewayHead, iosHead]) await exec("git", ["merge-base", "--is-ancestor", pinned, head], { cwd: f.root });
	assert.match(repairPrompt, new RegExp(`Current canonical merge parent: ${repairBase}`));
	assert.match(repairPrompt, new RegExp(`gateway: ${gatewayHead}`));
	assert.match(repairPrompt, new RegExp(`ios: ${iosHead}`));
	assert.match(repairPrompt, /do not squash, cherry-pick, or recreate contribution commits/i);
	assert.match(repairPrompt, /exactly one final repair commit/i);
});

test("integration repair accepts a pinned head already in canonical ancestry", async (t) => {
	const tasks = [task("included"), task("pending")];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["included", "pending"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		tasks,
	});
	await writeFile(join(f.root, "shared.txt"), "base\n");
	await exec("git", ["add", "shared.txt"], { cwd: f.root }); await exec("git", ["commit", "-qm", "shared base"], { cwd: f.root });
	let includedHead = ""; let pendingHead = ""; let seeded = false; let capturedBase = "";
	const originalMutex = f.runtime.mutex;
	f.runtime.mutex = { async run(owner: string, operation: () => Promise<unknown>) {
		if (owner.startsWith("story-repair:") && !seeded) {
			seeded = true;
			await exec("git", ["merge", "--no-ff", "-s", "ours", "-m", "retain included contribution ancestry", includedHead], { cwd: f.root });
			capturedBase = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
		}
		return originalMutex.run(owner, operation);
	} };
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			const included = input.taskId === "included";
			await writeFile(join(input.cwd, "shared.txt"), included ? "included\n" : "pending\n");
			await writeFile(join(input.cwd, `${input.taskId}.txt`), `${input.taskId}\n`);
			await exec("git", ["add", "."], { cwd: input.cwd });
			const date = included ? "2002-01-01T00:00:00Z" : "2002-01-02T00:00:00Z";
			await exec("git", ["commit", "-qm", input.taskId], { cwd: input.cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
			const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim();
			if (included) includedHead = head; else pendingHead = head;
			return { text: `${input.taskId} complete` };
		}
		if (input.action === "integration-repair") {
			assert.match(input.attemptUserPrompt, new RegExp(`Current canonical merge parent: ${capturedBase}`));
			await exec("git", ["merge", "--no-ff", "--no-commit", "-s", "ours", pendingHead], { cwd: input.cwd });
			await writeFile(join(input.cwd, "shared.txt"), "included + pending\n");
			await writeFile(join(input.cwd, "pending.txt"), "pending\n");
			await exec("git", ["add", "shared.txt", "pending.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "final pending integration"], { cwd: input.cwd });
			return { text: "pending contribution integrated" };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 12_000);
	const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
	for (const pinned of [includedHead, pendingHead]) await exec("git", ["merge-base", "--is-ancestor", pinned, head], { cwd: f.root });
	assert.equal(await readFile(join(f.root, "shared.txt"), "utf8"), "included + pending\n");
});

test("integration repair rejects a missing pin, an unrelated commit, and an empty merge without moving canonical", async (t) => {
	const tasks = [task("left"), task("right")];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["left", "right"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		tasks,
	});
	await writeFile(join(f.root, "shared.txt"), "base\n");
	await exec("git", ["add", "shared.txt"], { cwd: f.root }); await exec("git", ["commit", "-qm", "shared base"], { cwd: f.root });
	const heads = new Map<string, string>(); let repairs = 0; let canonicalBeforeRepair = "";
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			await writeFile(join(input.cwd, "shared.txt"), `${input.taskId}\n`);
			await exec("git", ["add", "shared.txt"], { cwd: input.cwd });
			const date = input.taskId === "left" ? "2003-01-01T00:00:00Z" : "2003-01-02T00:00:00Z";
			await exec("git", ["commit", "-qm", input.taskId], { cwd: input.cwd, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
			heads.set(input.taskId, (await exec("git", ["rev-parse", "HEAD"], { cwd: input.cwd })).stdout.trim());
			return { text: `${input.taskId} complete` };
		}
		if (input.action === "integration-repair") {
			const canonical = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
			canonicalBeforeRepair ||= canonical;
			assert.equal(canonical, canonicalBeforeRepair, "a rejected repair must not move canonical before retry");
			repairs++;
			if (repairs === 1) {
				await writeFile(join(input.cwd, "missing-pin.txt"), "missing\n");
				await exec("git", ["add", "missing-pin.txt"], { cwd: input.cwd }); await exec("git", ["commit", "-qm", "omit pinned heads"], { cwd: input.cwd });
			} else if (repairs === 2) {
				await writeFile(join(input.cwd, "unrelated.txt"), "unrelated\n");
				await exec("git", ["add", "unrelated.txt"], { cwd: input.cwd }); await exec("git", ["commit", "-qm", "unrelated extra commit"], { cwd: input.cwd });
				await exec("git", ["merge", "--no-ff", "-s", "ours", "-m", "final merge after unrelated commit", heads.get("left")!, heads.get("right")!], { cwd: input.cwd });
			} else {
				await exec("git", ["merge", "--no-ff", "-s", "ours", "-m", "empty ancestry-only merge", heads.get("left")!, heads.get("right")!], { cwd: input.cwd });
			}
			return { text: "invalid integration repair" };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	f.runtime.config.limits.repairRounds = 3;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 12_000);
	assert.equal(repairs, 3);
	assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim(), canonicalBeforeRepair);
	await assert.rejects(access(join(f.root, "missing-pin.txt")), /ENOENT/);
	await assert.rejects(access(join(f.root, "unrelated.txt")), /ENOENT/);
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

test("stable repair path refuses foreign repository ownership without deleting it", async (t) => {
	const f = await fixture(t, { plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "required" } }] } });
	const foreign = await mkdtemp(join(tmpdir(), "pibox-foreign-repair-"));
	t.after(() => rm(foreign, { recursive: true, force: true }));
	await exec("git", ["init", "-q", "-b", "foreign"], { cwd: foreign });
	await exec("git", ["config", "user.email", "tests@example.com"], { cwd: foreign }); await exec("git", ["config", "user.name", "Tests"], { cwd: foreign });
	await writeFile(join(foreign, "foreign.txt"), "preserve\n"); await exec("git", ["add", "foreign.txt"], { cwd: foreign }); await exec("git", ["commit", "-qm", "foreign"], { cwd: foreign });
	const repairPath = join(f.root, ".worktree", "pibox", "example", "review-fix-delivery");
	await mkdir(join(repairPath, ".."), { recursive: true });
	await exec("git", ["clone", "-q", foreign, repairPath]);
	let repairLaunches = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "implementation.txt"), "implemented\n"); await exec("git", ["add", "implementation.txt"], { cwd: input.cwd }); await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
			return { text: "implemented" };
		}
		if (input.action === "review") return { text: JSON.stringify({ result: "repairable", summary: "repair", findings: [{ id: "bug", severity: "major", code: "bug", summary: "repair" }] }) };
		if (input.action === "review-fix") repairLaunches++;
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.attention?.code, "workspace_invariant"), 8_000);
	assert.equal(repairLaunches, 0);
	assert.equal(await readFile(join(repairPath, "foreign.txt"), "utf8"), "preserve\n");
	assert.match((await adapter.snapshot("work-item:example", f.ctx)).runtime.attention?.summary ?? "", /belongs to another Git repository/);
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
	await eventually(() => assert.deepEqual([...launched].sort(), ["a", "b", "c"]));
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

test("a capacity-blocked stage boundary checkpoints the completed stage clock exactly once", async (t) => {
	const calls: string[] = [];
	let capacityExhausted = false;
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [
			{ id: "foundation", tasks: [], mode: "sequential", checks: [], review: { mode: "skip" } },
			{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "skip" } },
		] },
		tasks: [task("task-a")],
		execute: async ({ action }) => {
			calls.push(action.kind);
			if (action.kind === "integration") {
				capacityExhausted = true;
				return { ...passed(), integratedCommit: "foundation-integrated" };
			}
			return passed();
		},
	});
	f.runtime.config.limits.maxConcurrency = 1;
	f.runtime.config.limits.maxActiveSubagentsPerSession = 1;
	f.runtime.launcher.activeCount = () => capacityExhausted ? 1 : 0;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => {
		const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
		assert.equal(runtime.stages[0]?.status, "completed");
		assert.equal(runtime.stages[1]?.tasks[0]?.status, "pending");
		assert.equal(runtime.metrics.open, undefined, "the completed stage must retain no open category or stage attribution");
	});
	assert.equal(calls.includes("task-launch"), false, "the capacity-blocked next-stage child must not activate");

	const store = new StoryRuntimeStore(f.root, "example");
	const beforeIdleState = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	const priorStageTiming = structuredClone(beforeIdleState.metrics.stageBreakdown?.foundation);
	assert.ok(priorStageTiming && priorStageTiming.workflowMs > 0, "the prior stage interval is durably checkpointed");
	const beforeIdleEvents = await store.readDebugTail(50);
	const beforeIdleFile = await stat(store.statePath);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	const afterIdleState = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	const afterIdleEvents = await store.readDebugTail(50);
	const afterIdleFile = await stat(store.statePath);
	assert.deepEqual(afterIdleState.metrics.stageBreakdown?.foundation, priorStageTiming, "blocked queue time is not added to the completed stage");
	assert.equal(afterIdleState.metrics.open, undefined);
	assert.equal(afterIdleEvents.length, beforeIdleEvents.length, "idle advancement appends no repeated metric event");
	assert.equal(afterIdleFile.ino, beforeIdleFile.ino, "idle advancement does not rewrite the checkpointed state");
	assert.equal(calls.includes("task-launch"), false);
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
			if (action.kind === "e2e" && e2eRuns++ === 0) {
				await mkdir(join(runtime.identity.root, "agent-artifacts", "example", "evidence"), { recursive: true });
				await writeFile(join(runtime.identity.root, "agent-artifacts", "example", "evidence", "failed.txt"), "failed\n");
				return { result: "repairable", failure: { code: "journey", summary: "journey failed" }, evidenceRefs: ["evidence/failed.txt"] };
			}
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
	assert.deepEqual(snapshot.runtime?.e2e.evidenceRefs, ["evidence/failed.txt", "evidence/passed.txt"]);
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
	const workerContexts: Array<{ action: string; stable: string; supplement?: string }> = [];
	let e2eStablePrompt = "";
	let e2eScratchDirectory = "";
	useProductionExecutor(f, async (input) => {
		workerContexts.push({ action: input.action, stable: input.stableSystemContext, supplement: input.initialSystemSupplement });
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
			const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
			await mkdir(evidenceRoot, { recursive: true });
			const evidenceRefs = Array.from({ length: 65 }, (_, index) => `evidence/journey-${index}.txt`);
			await Promise.all(evidenceRefs.map((reference) => writeFile(join(f.root, "agent-artifacts", "example", reference), "journey passed\n")));
			return { text: JSON.stringify({ result: "passed", summary: "journey passed", findings: [], evidenceRefs }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.outcomeStatus, "written"), 8_000);
	const committed = (await exec("git", ["show", "--pretty=format:", "--name-only", "HEAD"], { cwd: f.root })).stdout.trim().split("\n").filter(Boolean).sort();
	assert.equal(committed.filter((path) => path.startsWith("agent-artifacts/example/evidence/")).length, 66, "canonical report plus 65 attachments are retained");
	assert.ok(committed.includes("agent-artifacts/example/outcome.md"));
	assert.match(e2eStablePrompt, /\$PIBOX_E2E_SCRATCH_DIR/);
	assert.match(e2eStablePrompt, /workflow_e2e_report/);
	assert.match(e2eStablePrompt, /Final prose is not verdict authority/);
	await assert.rejects(access(e2eScratchDirectory), /ENOENT/, "disposable tool output is removed after the E2E attempt");
	assert.ok(evaluatorPrompts.length >= 3, "stage review, final review, and E2E receive dynamic attempts");
	for (const prompt of evaluatorPrompts) {
		assert.match(prompt, new RegExp(`Base commit: ${base}`));
		assert.match(prompt, /Head commit: [0-9a-f]{40}/);
		assert.match(prompt, new RegExp(`Review diff: ${base}\\.\\.[0-9a-f]{40}`));
		assert.doesNotMatch(prompt, /Curated integration risk/);
	}
	for (const context of workerContexts) {
		assert.doesNotMatch(context.stable, /Authoritative workflow ledger|Curated integration risk/);
		if (context.action === "task-launch") {
			assert.match(context.stable, /# Implementer/);
			assert.match(context.stable, /# Managed Task Protocol/);
			assert.match(context.stable, /use `workflow_ledger` with `action: "append"`/i);
			assert.match(context.supplement ?? "", /Authoritative workflow ledger \(treat as read-only\): \/.*\/agent-artifacts\/example\/ledger\.yaml/);
			assert.match(context.supplement ?? "", /Use the ordinary read tool/);
			assert.match(context.supplement ?? "", /Curated integration risk/);
		} else {
			assert.equal(context.supplement, undefined, `${context.action} evaluator receives no ledger seed`);
			assert.match(context.stable, /# Managed Review and E2E Protocol/);
			assert.match(context.stable, /receive no implementation ledger context or ledger tools/i);
			assert.match(context.stable, /Judge the contract, code, and direct verification evidence independently/i);
			assert.match(context.stable, /For re-review,[\s\S]+do not restart a broad initial audit/i);
			assert.match(context.stable, context.action === "e2e" ? /# End-to-End Evaluation/ : /# Code Review/);
		}
	}
	const outcome = await readFile(join(f.root, "agent-artifacts", "example", "outcome.md"), "utf8");
	for (const heading of ["Delivered stages", "Deterministic checks", "Review and E2E summaries", "Deviations", "Residual risks", "Metrics", "Evidence"]) assert.match(outcome, new RegExp(heading));
	assert.match(outcome, /None recorded\./);
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
});

test("production E2E repair retains immutable rich reports through fix, retest, and completion", async (t) => {
	const f = await fixture(t, {});
	const resultReport = JSON.stringify({
		caseResults: [{ id: "E2E-001", status: "failed", observations: ["Expected result missing"] }],
		result: "blocked",
		findings: ["Journey failed before repair"],
		evidenceRefs: ["evidence/result.json", "evidence/uncited-nested.json"],
		unknownEvaluatorField: { full: "REPORT-TAIL-SENTINEL" },
	}, null, 2) + "\n";
	const secondReport = JSON.stringify({ caseResults: [{ id: "E2E-002", status: "blocked", observations: ["Prerequisite unavailable"] }], extra: "SECOND-REPORT" }, null, 2) + "\n";
	const supportJson = JSON.stringify({ witness: "SUPPORT-BODY-MUST-NOT-BE-INLINED" }) + "\n";
	const malformedJson = "{ malformed current report\n";
	const rerunReport = JSON.stringify({
		caseResults: [{ id: "E2E-001", status: "passed", observations: ["Expected result visible"] }],
		result: "passed",
		findings: [],
		evidenceRefs: ["evidence/rerun-result.json"],
	}, null, 2) + "\n";
	let e2eRuns = 0;
	let retestPrompt = "";
	let repairPrompt = "";
	let repairStablePrompt = "";
	let e2eStablePrompt = "";
	let adapter!: ReturnType<typeof createHarnessWorkflowAdapter>;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "before repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.action === "e2e-fix") {
			repairPrompt = input.attemptUserPrompt;
			repairStablePrompt = input.stableSystemContext;
			assert.deepEqual(await adapter.preflightWorkflow!("work-item:example", f.ctx), { ok: true });
			await assert.rejects(access(join(input.cwd, "agent-artifacts", "example", "evidence", "result.json")), /ENOENT/, "canonical uncommitted report is absent from repair worktree");
			const unrelated = join(f.root, "unrelated.tmp");
			await writeFile(unrelated, "unrelated\n");
			await assert.rejects(adapter.preflightWorkflow!("work-item:example", f.ctx), /outside its validated evidence set.*unrelated\.tmp/);
			await rm(unrelated);
			await writeFile(join(input.cwd, "delivered.txt"), "after repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "repair journey"], { cwd: input.cwd });
			return { text: "repaired" };
		}
		if (input.role === "e2e-tester") {
			e2eStablePrompt = input.stableSystemContext;
			const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
			await mkdir(evidenceRoot, { recursive: true });
			if (e2eRuns++ === 0) {
				await writeFile(join(evidenceRoot, "result.json"), resultReport);
				await writeFile(join(evidenceRoot, "second.json"), secondReport);
				await writeFile(join(evidenceRoot, "support.json"), supportJson);
				await writeFile(join(evidenceRoot, "malformed.json"), malformedJson);
				return { text: JSON.stringify({ result: "repairable", summary: "journey failed", findings: [{ id: "journey", severity: "major", code: "missing_result", summary: "Expected result missing" }], evidenceRefs: ["evidence/result.json", "evidence/second.json", "evidence/support.json", "evidence/malformed.json"] }) };
			}
			retestPrompt = input.attemptUserPrompt;
			await writeFile(join(evidenceRoot, "rerun-result.json"), rerunReport);
			return { text: JSON.stringify({ result: "passed", summary: "journey passed", findings: [], evidenceRefs: ["evidence/rerun-result.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(runtime.e2e.evidenceRefs.length, 7, "two reports and five attachments remain cumulative");
	assert.deepEqual(runtime.e2e.currentFindings, []);
	assert.equal(runtime.e2e.currentEvidenceRefs?.length, 2);
	assert.equal(runtime.e2e.currentReportRef, runtime.e2e.currentEvidenceRefs?.[0]);
	assert.match(runtime.e2e.currentReportRef ?? "", /^evidence\/e2e-[^/]+\/report\.json$/);
	assert.match(retestPrompt, /Prior retained evidence[\s\S]*evidence\/e2e-/);
	assert.match(repairPrompt, /FULL literal canonical report JSON/);
	assert.match(repairPrompt, /"schemaVersion":1/);
	assert.match(repairPrompt, /"result":"repairable"/);
	assert.match(repairPrompt, /Supporting canonical root paths:/);
	assert.match(repairPrompt, /Reproduce concrete failure or witness before patching/);
	assert.match(repairPrompt, /unexecuted coverage or unmet prerequisites/);
	assert.doesNotMatch(repairStablePrompt, /FULL literal canonical report JSON/, "current context stays out of stable SYSTEM prompt");
	assert.match(e2eStablePrompt, /workflow_e2e_report/);
	assert.match(e2eStablePrompt, /Final prose is not verdict authority/);
	const committed = (await exec("git", ["ls-tree", "-r", "--name-only", "HEAD", "agent-artifacts/example/evidence"], { cwd: f.root })).stdout.trim().split("\n");
	assert.equal(committed.length, 7);
	assert.equal((await exec("git", ["status", "--porcelain"], { cwd: f.root })).stdout, "");
	assert.doesNotMatch(await readFile(join(f.root, ".gitignore"), "utf8"), /evidence/);
});

test("request_changes E2E fix uses same current-context entrance and augments it with guidance", async (t) => {
	const f = await fixture(t, {});
	const report = JSON.stringify({ caseResults: [{ id: "E2E-001", status: "failed", observations: ["REQUEST-REPORT"] }], extra: { retained: true } }, null, 2) + "\n";
	let e2eRuns = 0;
	let fixPrompt = "";
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "before request repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.action === "e2e-fix") {
			fixPrompt = input.attemptUserPrompt;
			await writeFile(join(input.cwd, "delivered.txt"), "after request repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "requested E2E repair"], { cwd: input.cwd });
			return { text: "repaired" };
		}
		if (input.role === "e2e-tester") {
			const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
			await mkdir(evidenceRoot, { recursive: true });
			if (e2eRuns++ === 0) {
				await writeFile(join(evidenceRoot, "request.json"), report);
				return { text: JSON.stringify({ result: "repairable", summary: "request failure", findings: [{ id: "request", severity: "major", code: "request_failure", summary: "REQUEST-FINDING" }], evidenceRefs: ["evidence/request.json"] }) };
			}
			await writeFile(join(evidenceRoot, "request-passed.json"), JSON.stringify({ caseResults: [{ id: "E2E-001", status: "passed" }] }) + "\n");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/request-passed.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(attention.e2e.currentEvidenceRefs?.length, 2);
	assert.equal(attention.e2e.currentReportRef, attention.e2e.currentEvidenceRefs?.[0]);
	const historicalReport = JSON.stringify({ caseResults: [{ id: "E2E-HISTORICAL", status: "failed" }], marker: "COMMITTED-HISTORICAL-BODY" }) + "\n";
	const historicalPath = join(f.root, "agent-artifacts", "example", "evidence", "historical.json");
	await writeFile(historicalPath, historicalReport);
	await exec("git", ["add", "agent-artifacts/example/evidence/historical.json"], { cwd: f.root });
	await exec("git", ["commit", "-qm", "retain historical E2E report"], { cwd: f.root });
	const store = new StoryRuntimeStore(f.root, "example");
	const withHistoricalEvidence = (await store.readState())!;
	withHistoricalEvidence.e2e.evidenceRefs = ["evidence/historical.json", ...withHistoricalEvidence.e2e.evidenceRefs];
	await store.writeState(withHistoricalEvidence);
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "REQUEST-GUIDANCE", correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "e2e" } } }, f.ctx);
	const corrected = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.deepEqual(corrected.e2e.currentFindings, attention.e2e.currentFindings);
	assert.deepEqual(corrected.e2e.currentEvidenceRefs, attention.e2e.currentEvidenceRefs);
	await adapter.controlExecution!("work-item:example", "resume", "requested-e2e", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	assert.match(fixPrompt, /REQUEST-GUIDANCE/);
	assert.match(fixPrompt, /REQUEST-FINDING/);
	assert.match(fixPrompt, /FULL literal canonical report JSON/);
	assert.match(fixPrompt, /"summary":"request failure"/);
	assert.doesNotMatch(fixPrompt, /COMMITTED-HISTORICAL-BODY|evidence\/historical\.json/, "committed cumulative report absent from current citations stays out of prompt");
	assert.equal(await readFile(historicalPath, "utf8"), historicalReport);
	assert.match(fixPrompt, /## Current authoritative E2E report/);
	assert.match(fixPrompt, /Supporting canonical root paths/);
});

test("E2E repair rejects current report mutation between prompt capture and cumulative baseline without launch", async (t) => {
	const f = await fixture(t, {});
	const oldReport = JSON.stringify({ caseResults: [{ id: "E2E-001", status: "failed" }], marker: "OLD-PROMPT-BODY" }) + "\n";
	const newReport = JSON.stringify({ caseResults: [{ id: "E2E-001", status: "passed" }], marker: "NEW-FILE-BODY" }) + "\n";
	let repairLaunches = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "before repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.action === "e2e-fix") {
			repairLaunches++;
			return { text: "must not launch" };
		}
		if (input.role === "e2e-tester") {
			const currentPath = join(f.root, "agent-artifacts", "example", "evidence", "current.json");
			await mkdir(join(currentPath, ".."), { recursive: true });
			await writeFile(currentPath, oldReport);
			return { text: JSON.stringify({ result: "repairable", summary: "failed", findings: [], evidenceRefs: ["evidence/current.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const store = new StoryRuntimeStore(f.root, "example");
	const attention = (await store.readState())!;
	const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
	const currentPath = join(f.root, "agent-artifacts", "example", attention.e2e.currentReportRef!);
	const historicalPath = join(evidenceRoot, "historical.txt");
	await writeFile(historicalPath, "committed historical proof\n");
	await exec("git", ["add", "agent-artifacts/example/evidence/historical.txt"], { cwd: f.root });
	await exec("git", ["commit", "-qm", "retain historical proof"], { cwd: f.root });
	attention.e2e.evidenceRefs = ["evidence/historical.txt", ...attention.e2e.evidenceRefs];
	await store.writeState(attention);
	const headBefore = (await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim();
	let capturedCurrent = false;
	let mutatedBetweenCaptureAndBaseline = false;
	f.runtime.evidenceDescriptorOpened = async (openedPath: string) => {
		const runtime = await store.readState();
		if (runtime?.e2e.status !== "fixing") return;
		if (openedPath === currentPath && !capturedCurrent) {
			capturedCurrent = true;
			return;
		}
		if (openedPath === historicalPath && capturedCurrent && !mutatedBetweenCaptureAndBaseline) {
			mutatedBetweenCaptureAndBaseline = true;
			await writeFile(currentPath, newReport);
		}
	};
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "repair current failure", correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "e2e" } } }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "mutation-race", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => {
		const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(runtime.status, "attention");
		assert.match(runtime.attention?.summary ?? "", /evidence changed after it was cited: evidence\/e2e-[^/]+\/report\.json/);
	}, 8_000);
	assert.equal(capturedCurrent, true);
	assert.equal(mutatedBetweenCaptureAndBaseline, true);
	assert.equal(repairLaunches, 0);
	assert.equal(await readFile(currentPath, "utf8"), newReport);
	assert.equal(await readFile(historicalPath, "utf8"), "committed historical proof\n");
	assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: f.root })).stdout.trim(), headBefore);
});

test("completed E2E crash window permits only cited evidence during resume preflight", async (t) => {
	const f = await fixture(t, {});
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.role === "e2e-tester") {
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "accepted.json");
			await mkdir(join(evidence, ".."), { recursive: true });
			await writeFile(evidence, "{\"result\":\"passed\"}\n");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/accepted.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	const store = new StoryRuntimeStore(f.root, "example");
	const completed = (await store.readState())!;
	await exec("git", ["reset", "--mixed", "HEAD^"], { cwd: f.root });
	await rm(join(f.root, "agent-artifacts", "example", "outcome.md"));
	await store.writeState({ ...completed, outcomeStatus: "pending" });

	assert.deepEqual(await adapter.preflightWorkflow!("work-item:example", f.ctx), { ok: true });
	await writeFile(join(f.root, "uncited.tmp"), "uncited\n");
	await assert.rejects(adapter.preflightWorkflow!("work-item:example", f.ctx), /outside its validated evidence set.*uncited\.tmp/);
	await rm(join(f.root, "uncited.tmp"));
	const retained = (await store.readState())!.e2e;
	assert.equal(retained.evidenceRefs.length, 2);
	assert.ok(retained.evidenceRefs.includes(retained.currentReportRef!));
});

test("E2E fix pre-merge rejects unrelated canonical dirt and preserves it", async (t) => {
	const f = await fixture(t, {});
	let e2eRuns = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "before repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.action === "e2e-fix") {
			await writeFile(join(input.cwd, "delivered.txt"), "after repair\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "repair journey"], { cwd: input.cwd });
			await writeFile(join(f.root, "unrelated.tmp"), "preserve me\n");
			return { text: "repaired" };
		}
		if (input.role === "e2e-tester") {
			e2eRuns++;
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "result.json");
			await mkdir(join(evidence, ".."), { recursive: true });
			await writeFile(evidence, "{\"result\":\"blocked\"}\n");
			return { text: JSON.stringify({ result: "repairable", summary: "failed", findings: [], evidenceRefs: ["evidence/result.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	f.runtime.config.limits.repairRounds = 1;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(runtime.attention?.causeCode, "invalid_repair");
	assert.match(runtime.attention?.summary ?? "", /outside its validated evidence set.*unrelated\.tmp/);
	assert.equal(await readFile(join(f.root, "unrelated.tmp"), "utf8"), "preserve me\n");
	assert.equal(e2eRuns, 1, "failed pre-merge cleanliness must not launch retest");
});

test("E2E retest rejects mutation of prior proof and preserves both files", async (t) => {
	const f = await fixture(t, {});
	let e2eRuns = 0;
	let adapter!: ReturnType<typeof createHarnessWorkflowAdapter>;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch" || input.action === "e2e-fix") {
			await writeFile(join(input.cwd, "delivered.txt"), `${input.action}\n`);
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", input.action], { cwd: input.cwd });
			return { text: input.action };
		}
		if (input.role === "e2e-tester") {
			const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
			await mkdir(evidenceRoot, { recursive: true });
			if (e2eRuns++ === 0) {
				await writeFile(join(evidenceRoot, "result.json"), "{\"result\":\"blocked\"}\n");
				return { text: JSON.stringify({ result: "repairable", summary: "failed", findings: [], evidenceRefs: ["evidence/result.json"] }) };
			}
			const current = (await adapter.snapshot("work-item:example", f.ctx)).runtime.e2e.currentReportRef!;
			await writeFile(join(f.root, "agent-artifacts", "example", current), "{\"result\":\"tampered\"}\n");
			await writeFile(join(evidenceRoot, "rerun-result.json"), "{\"result\":\"passed\"}\n");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/rerun-result.json"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(runtime.attention?.code, "evidence_invalid");
	assert.match(runtime.attention?.summary ?? "", /evidence changed after it was cited: evidence\/e2e-[^/]+\/report\.json/);
	assert.equal(runtime.e2e.evidenceRefs.length, 2);
	assert.equal(await readFile(join(f.root, "agent-artifacts", "example", runtime.e2e.currentReportRef!), "utf8"), "{\"result\":\"tampered\"}\n");
});

test("E2E submission boundary pauses missing, ignored, and nonzero uncited report output", async (t) => {
	for (const scenario of ["missing", "ignored", "nonzero"] as const) {
		await t.test(scenario, async (t) => {
			const f = await fixture(t, {});
			if (scenario === "ignored") {
				await writeFile(join(f.root, ".gitignore"), "/.worktree/\n/agent-artifacts/*/state.yaml\n/agent-artifacts/*/ledger.yaml\n/agent-artifacts/*/events.jsonl\n/agent-artifacts/example/evidence/e2e-*/\n");
				await exec("git", ["add", ".gitignore"], { cwd: f.root });
				await exec("git", ["commit", "-qm", "ignore test evidence"], { cwd: f.root });
			}
			useProductionExecutor(f, async (input) => {
				if (input.action === "task-launch") {
					await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
					await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
					await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
					return { text: "delivered" };
				}
				if (input.role !== "e2e-tester") return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
				const evidenceRoot = join(f.root, "agent-artifacts", "example", "evidence");
				await mkdir(evidenceRoot, { recursive: true });
				if (scenario === "missing") return { text: JSON.stringify({ result: "passed", summary: "passed", evidenceRefs: ["evidence/missing.json"] }) };
				if (scenario === "ignored") {
					await writeFile(join(evidenceRoot, "ignored.json"), "{}\n");
					return { text: JSON.stringify({ result: "passed", summary: "passed", evidenceRefs: ["evidence/ignored.json"] }) };
				}
				await writeFile(join(evidenceRoot, "uncited.json"), "{}\n");
				return { text: "worker failed", exitCode: 1 };
			});
			const adapter = f.create(); await start(adapter, f.ctx);
			await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "paused"), 8_000);
			const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
			assert.equal(runtime.e2e.failure?.code, "e2e_report_protocol", JSON.stringify(runtime));
			assert.equal(runtime.e2e.repairCount, 0);
			assert.deepEqual(runtime.e2e.evidenceRefs, []);
			if (scenario === "ignored") assert.match(runtime.e2e.failure?.summary ?? "", /ignored/);
			if (scenario === "nonzero") assert.equal(await readFile(join(f.root, "agent-artifacts", "example", "evidence", "uncited.json"), "utf8"), "{}\n");
		});
	}
});

test("production launch honors trusted custom agent prompt body before managed protocol", async (t) => {
	const f = await fixture(t, {});
	const promptRoot = await mkdtemp(join(tmpdir(), "pibox-trusted-agent-"));
	t.after(() => rm(promptRoot, { recursive: true, force: true }));
	const promptPath = join(promptRoot, "trusted-implementer.md");
	await writeFile(promptPath, "---\nname: trusted-implementer\ndescription: Trusted implementation agent\ntools: [read, bash]\ntier: medium\n---\n\n# Trusted Custom Body\n\nHonor project-local implementation constraints.\n");
	let taskSystem = "";
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			taskSystem = input.stableSystemContext;
			await writeFile(join(input.cwd, "implemented.txt"), "done\n");
			await exec("git", ["add", "implemented.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
			return { text: "implemented" };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	f.runtime.config.agents.implementer.prompt = promptPath;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	assert.match(taskSystem, /^# Trusted Custom Body/);
	assert.match(taskSystem, /# Managed Task Protocol/);
	assert.match(taskSystem, /# Task task-a:/);
	assert.equal(taskSystem.indexOf("# Trusted Custom Body") < taskSystem.indexOf("# Managed Task Protocol"), true);
	assert.equal(taskSystem.indexOf("# Managed Task Protocol") < taskSystem.indexOf("# Task task-a:"), true);
});

test("sensitive E2E evidence pauses as a submission protocol failure", async (t) => {
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
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime?.status, "paused"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime!;
	assert.equal(runtime.e2e.failure?.code, "e2e_report_protocol", JSON.stringify(runtime));
	assert.equal(runtime.e2e.repairCount, 0);
	assert.equal(runtime.outcomeStatus, "pending");
	await assert.rejects(access(join(f.root, "agent-artifacts", "example", "outcome.md")));
});

test("E2E submission rejects FIFO and symlink evidence without blocking", async (t) => {
	for (const scenario of ["fifo", "symlink"] as const) await t.test(scenario, async (t) => {
		const f = await fixture(t, {});
		useProductionExecutor(f, async (input) => {
			if (input.action === "task-launch") {
				await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
				await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
				return { text: "delivered" };
			}
			if (input.role === "e2e-tester") {
				const root = join(f.root, "agent-artifacts", "example", "evidence");
				const evidence = join(root, "result.json");
				await mkdir(root, { recursive: true });
				if (scenario === "fifo") await exec("mkfifo", [evidence], { cwd: f.root });
				else if (scenario === "symlink") {
					await writeFile(join(root, "target.json"), "{}\n");
					await symlink("target.json", evidence);
				}
				return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/result.json"] }) };
			}
			return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
		});
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "paused"), 8_000);
		const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(runtime.e2e.failure?.code, "e2e_report_protocol", JSON.stringify(runtime));
		assert.equal(runtime.e2e.repairCount, 0);
		assert.match(runtime.e2e.failure?.summary ?? "", /regular file|symbolic link/);
	});
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
	let lockDepth = 0; let repairAttempts = 0; let canonicalBeforeRepair = ""; let repairSystemContext = "";
	f.runtime.mutex = { async run(_owner: string, operation: () => Promise<unknown>) { assert.equal(lockDepth, 0); lockDepth++; try { return await operation(); } finally { lockDepth--; } } };
	useProductionExecutor(f, async (input) => {
		if (input.taskId) {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver task"], { cwd: input.cwd });
			return { text: "delivered" };
		}
		if (input.role === "repair-implementer") {
			repairSystemContext = input.stableSystemContext;
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
	assert.match(repairSystemContext, /# Finding Repair/);
	assert.match(repairSystemContext, /# Managed Repair Protocol/);
	assert.match(repairSystemContext, /use `workflow_ledger` with `action: "append"`/i);
	assert.match(repairSystemContext, /successful repair still requires independent re-review or E2E/i);
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

test("first-demand reconciliation interrupts a paused active owner without launching", async (t) => {
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
	assert.deepEqual(await reconcileHarnessActivation(f.runtime), [{ workflowRef: "work-item:example", mode: "paused", ownerSessionId: "session", ownerProcessInstanceId: "process-a", ownerActivationId: "activation-a" }]);
	f.setOwner({ sessionId: "session", processInstanceId: "process-b", activationId: "activation-b" });
	const replacement = f.create();
	assert.deepEqual(await reconcileHarnessActivation(f.runtime), []);
	const interrupted = (await replacement.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(interrupted.status, "paused");
	assert.equal(interrupted.stages[0]?.tasks[0]?.status, "interrupted");
	assert.equal(interrupted.activationOwner, undefined);
	assert.equal(interrupted.metrics.open, undefined);
	assert.equal(interrupted.metrics.incompleteIntervals, 1);
	assert.deepEqual(interrupted.metrics.incompleteCategories, ["implementation"]);
	assert.equal(launches, 1, "first-demand reconciliation must not bind or launch work");
	await replacement.controlExecution!("work-item:example", "resume", "explicit-resume", f.ctx);
	await replacement.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(() => assert.equal(launches, 2));
	gate.resolve({ ...passed(), contributionCommit: "fresh" });
	await eventually(async () => assert.equal((await replacement.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
});

test("an exhausted iOS check accepts a same-story correction and executes the effective check without reimplementation", async (t) => {
	const oldCommand = "printf 'xcodebuild destination=iPhone-15'";
	const correctedCommand = "printf 'xcodebuild destination=iPhone-16'";
	const authored = task("task-a", [{ id: "ios", command: oldCommand }]);
	const observedCommands: string[] = [];
	const checkTokens: string[] = [];
	const f = await fixture(t, {
		tasks: [authored],
		execute: async (context) => {
			const { action } = context;
			if (action.kind === "task-launch") return { ...passed(), contributionCommit: "original-contribution" };
			if (action.kind === "task-check") {
				const command = (context.tasks.get("task-a")!.checks[0] as { command: string }).command;
				observedCommands.push(command); checkTokens.push(context.token);
				if (command === correctedCommand) return { ...passed(), checks: [{ id: "ios", status: "passed" }] };
				const failure = { code: "check_failed", causeCode: "check_configuration", summary: "Unable to find a destination matching iPhone 15", diagnostic: { checkId: "ios", command, exitCode: 70, stdout: "Available destinations follow", stderr: "error: Unable to find a destination matching\nSimulator inventory", outputTruncated: false } };
				return { result: "repairable", failure, checks: [{ id: "ios", status: "failed", failure }] };
			}
			if (action.kind === "integration") return { ...passed(), integratedCommit: "integrated-original" };
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const request = { action: "request_changes" as const, correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "task" as const, stageId: "delivery", taskId: "task-a" }, task: { checks: [{ id: "ios", command: correctedCommand }] } } };
	await assert.rejects(adapter.resolveAttention!("work-item:example", { ...request, correction: { ...request.correction, attentionEpoch: attention.attentionEpoch! + 1 } }, f.ctx, { dryRun: true }), /stale attention epoch/i);
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "missing" }, task: { description: "Different" } } }, f.ctx, { dryRun: true }), /does not match/i);
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { checks: [{ id: "ios", command: oldCommand }] } } }, f.ctx, { dryRun: true }), /no-op/i);
	await adapter.resolveAttention!("work-item:example", request, f.ctx, { dryRun: true });
	await adapter.resolveAttention!("work-item:example", request, f.ctx);
	const corrected = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(corrected.stages[0]!.tasks[0]!.status, "check_pending");
	assert.equal(corrected.stages[0]!.tasks[0]!.contributionCommit, "original-contribution");
	assert.equal(corrected.stages[0]!.tasks[0]!.repairCount, 0);
	assert.equal(corrected.executionCorrections?.[0]?.priorFailure.diagnostic?.command, oldCommand);
	assert.equal(corrected.executionCorrections?.[0]?.priorRepairCount, 0);
	assert.equal(corrected.executionCorrections?.[0]?.priorChecks?.[0]?.id, "ios");
	assert.equal(corrected.executionCorrections?.[0]?.priorChecks?.[0]?.status, "failed");
	await adapter.controlExecution!("work-item:example", "resume", "corrected-resume", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	const complete = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.deepEqual(observedCommands, [oldCommand, correctedCommand]);
	assert.notEqual(checkTokens[0], checkTokens[1]);
	assert.equal(complete.stages[0]!.tasks[0]!.contributionCommit, "original-contribution");
	assert.equal(complete.stages[0]!.tasks[0]!.checks[0]!.status, "passed");
	assert.equal(complete.executionCorrections?.length, 1);
	assert.match(await readFile(join(f.root, "agent-artifacts", "example", "outcome.md"), "utf8"), /Runtime correction 1 at delivery\/task-a: effective checks/);
});

test("adapter admits exact exhausted needs_user E2E guidance in dry-run and commit", async (t) => {
	const f = await fixture(t, { execute: async ({ action }) => action.kind === "task-launch"
		? { result: "needs_user", failure: { code: "setup", summary: "seed attention" } }
		: passed() });
	f.runtime.config.limits.repairRounds = 6;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const store = new StoryRuntimeStore(f.root, "example");
	await store.updateState((current) => {
		const next = structuredClone(current!);
		const failure = { code: "needs_user", summary: "approved fixture is required" };
		next.status = "attention";
		next.attentionEpoch = 16;
		next.attentionTarget = { kind: "e2e" };
		next.attention = failure;
		next.stages[0]!.status = "completed";
		next.stages[0]!.tasks[0]!.status = "completed";
		next.stages[0]!.tasks[0]!.contributionCommit = "retained-contribution";
		next.stages[0]!.integration = { status: "completed", repairCount: 0, contributionCommits: ["retained-contribution"], integratedCommit: "retained-integration", result: { code: "passed", summary: "integrated" } };
		next.stages[0]!.verification.status = "completed";
		next.finalReview = { status: "completed", iteration: 1, repairCount: 0, currentFindings: [], result: { code: "passed", summary: "reviewed" } };
		next.e2e = {
			status: "attention", repairCount: 12, failure, evidenceRefs: ["evidence/full-report.json"],
			currentEvidenceRefs: ["evidence/full-report.json"],
			currentFindings: [{ id: "fixture", severity: "major", code: "prerequisite", summary: "fixture unavailable" }],
		};
		return next;
	});
	const before = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const decision = { action: "request_changes" as const, prompt: "Fixture approval is complete; use supplied fixture endpoint.", correction: { attentionEpoch: 16, target: { kind: "e2e" as const } } };
	const projected = await adapter.resolveAttention!("work-item:example", decision, f.ctx, { dryRun: true });
	assert.equal(projected.status, "paused");
	assert.equal(projected.e2e.status, "fix_pending");
	assert.equal(projected.e2e.repairCount, 12);
	assert.deepEqual((await adapter.snapshot("work-item:example", f.ctx)).runtime, before, "dry-run does not mutate persisted state");
	await adapter.resolveAttention!("work-item:example", decision, f.ctx);
	const committed = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(committed.status, "paused");
	assert.equal(committed.e2e.repairCount, 12);
	assert.deepEqual(committed.e2e.currentFindings, before.e2e.currentFindings);
	assert.deepEqual(committed.e2e.currentEvidenceRefs, before.e2e.currentEvidenceRefs);
	assert.deepEqual(committed.e2e.evidenceRefs, before.e2e.evidenceRefs);
	assert.equal(committed.stages[0]!.tasks[0]!.contributionCommit, "retained-contribution");
	assert.deepEqual(committed.executionCorrections?.[0]?.priorFailure, before.e2e.failure);
	assert.equal(committed.executionCorrections?.[0]?.priorRepairCount, 12);
});

test("long request_changes guidance and corrected prose survive dry-run and persistence intact", async (t) => {
	const f = await fixture(t, { execute: async (context) => {
		if (context.action.kind === "task-launch") return { result: "needs_user", failure: { code: "blocked", summary: "needs guidance" } };
		return passed();
	} });
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const prompt = `prompt-start-${"p".repeat(3_129)}-prompt-end`;
	assert.equal(prompt.length, 3_153);
	const description = `description-start-${"d".repeat(12_100)}-description-end`;
	const decision = { action: "request_changes" as const, prompt, correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task" as const, stageId: "delivery", taskId: "task-a" }, task: { description },
	} };
	const projected = await adapter.resolveAttention!("work-item:example", decision, f.ctx, { dryRun: true });
	assert.equal(projected.stages[0]!.tasks[0]!.failure?.summary, prompt);
	assert.equal(projected.executionCorrections?.[0]?.prompt, prompt);
	await adapter.resolveAttention!("work-item:example", decision, f.ctx);
	const persisted = (await new StoryRuntimeStore(f.root, "example").readState())!;
	assert.equal(persisted.executionCorrections?.[0]?.prompt, prompt);
	assert.equal(persisted.executionCorrections?.[0]?.task?.description, description);
});

test("a correction accepts and executes more than 200 checks", async (t) => {
	const oldChecks = Array.from({ length: 201 }, (_, index) => ({ id: `check-${index + 1}`, command: index === 0 ? "old-command" : `true # ${index}` }));
	const correctedChecks = oldChecks.map((check, index) => index === 0 ? { ...check, command: "corrected-command" } : check);
	const f = await fixture(t, {
		tasks: [task("task-a", oldChecks)],
		execute: async (context) => {
			if (context.action.kind === "task-launch") return { ...passed(), contributionCommit: "contribution" };
			if (context.action.kind === "task-check") {
				const command = (context.tasks.get("task-a")!.checks[0] as { command: string }).command;
				if (command === "corrected-command") return passed();
				const failure = { code: "check_failed", summary: "first check failed", diagnostic: { checkId: "check-1", command, exitCode: 1, stdout: "", stderr: "failed", outputTruncated: false } };
				return { result: "repairable", failure, checks: [{ id: "check-1", status: "failed", failure }] };
			}
			if (context.action.kind === "integration") return { ...passed(), integratedCommit: "integrated" };
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { checks: correctedChecks },
	} }, f.ctx);
	const corrected = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(corrected.stages[0]!.tasks[0]!.checks.length, 201);
	await adapter.controlExecution!("work-item:example", "resume", "many-checks", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
});

test("semantic no-op check corrections reject string/object and default-profile representation changes", async (t) => {
	const f = await fixture(t, {
		tasks: [task("task-a", ["npm test"])],
		execute: async (context) => {
			if (context.action.kind === "task-launch") return { ...passed(), contributionCommit: "contribution" };
			if (context.action.kind === "task-check") {
				const failure = { code: "check_failed", summary: "failed", diagnostic: { checkId: "check-1", command: "npm test", exitCode: 1, stdout: "", stderr: "failed", outputTruncated: false } };
				return { result: "repairable", failure, checks: [{ id: "check-1", status: "failed", failure }] };
			}
			return passed();
		},
	});
	f.runtime.config.verification = { defaultProfile: "project", profiles: { project: { shell: "/bin/sh", requiredEnvironment: [] } } };
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" },
		task: { checks: [{ id: "check-1", command: "npm test", profile: "project" }] },
	} }, f.ctx, { dryRun: true }), /no-op/i);
});

test("a corrected stage verification command executes against the preserved integration", async (t) => {
	const oldCommand = "printf stage-old"; const correctedCommand = "printf stage-corrected";
	const observed: string[] = [];
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [{ id: "stage-ios", command: oldCommand }], review: { mode: "skip" } }] },
		execute: async (context) => {
			if (context.action.kind === "task-launch") return { ...passed(), contributionCommit: "task-contribution" };
			if (context.action.kind === "integration") return { ...passed(), integratedCommit: "preserved-integration" };
			if (context.action.kind === "verification") {
				const command = (context.plan.stages[0]!.checks[0] as { command: string }).command; observed.push(command);
				if (command === correctedCommand) return { ...passed(), checks: [{ id: "stage-ios", status: "passed" }] };
				return { result: "repairable", failure: { code: "check_failed", summary: "stage destination is stale" }, checks: [{ id: "stage-ios", status: "failed" }] };
			}
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	f.runtime.config.verification = { defaultProfile: "project", profiles: { project: { shell: "/bin/sh", requiredEnvironment: [] } } };
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "stage-verification", stageId: "delivery" },
		stageVerification: { checks: [{ id: "stage-ios", command: oldCommand, profile: "project" }] },
	} }, f.ctx, { dryRun: true }), /no-op/i);
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "stage-verification", stageId: "delivery" },
		stageVerification: { checks: [{ id: "stage-ios", command: correctedCommand }] },
	} }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "stage-check-resume", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	const complete = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.deepEqual(observed, [oldCommand, correctedCommand]);
	assert.equal(complete.stages[0]!.integration.integratedCommit, "preserved-integration");
	assert.equal(complete.stages[0]!.verification.repairCount, 0);
});

test("correction audit preserves failed checks and repair count when the latest failure is a repair", async (t) => {
	const checkFailure = { code: "check_failed", summary: "original check failed", diagnostic: { checkId: "unit", command: "npm test", exitCode: 1, stdout: "", stderr: "assertion", outputTruncated: false } };
	const f = await fixture(t, { tasks: [task("task-a", [{ id: "unit", command: "npm test" }])], execute: async (context) => {
		if (context.action.kind === "task-launch") return { ...passed(), contributionCommit: "contribution" };
		if (context.action.kind === "task-check") return { result: "repairable", failure: checkFailure, checks: [{ id: "unit", status: "failed", failure: checkFailure }] };
		if (context.action.kind === "task-repair") return { result: "repairable", failure: { code: "repair_failed", summary: "repair transport failed" } };
		return passed();
	} });
	f.runtime.config.limits.repairRounds = 1;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(attention.stages[0]!.tasks[0]!.repairCount, 1);
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { description: "Use the repaired transport boundary." },
	} }, f.ctx);
	const correction = (await adapter.snapshot("work-item:example", f.ctx)).runtime.executionCorrections?.at(-1)!;
	assert.equal(correction.priorFailure.summary, "repair transport failed");
	assert.equal(correction.priorRepairCount, 1);
	assert.equal(correction.priorChecks?.[0]?.failure?.diagnostic?.command, "npm test");
});

test("exhausted integration attention accepts new epoch-bound guidance and preserves contribution history", async (t) => {
	let integrations = 0; let repairs = 0;
	const f = await fixture(t, { execute: async (context) => {
		if (context.action.kind === "task-launch") return { ...passed(), contributionCommit: "same-contribution" };
		if (context.action.kind === "integration") { integrations++; return { result: "repairable", failure: { code: "report_too_large", summary: "integration report exceeded transport" } }; }
		if (context.action.kind === "integration-repair") { repairs++; return { ...passed(), integratedCommit: "same-integration" }; }
		return passed();
	} });
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const decision = { action: "request_changes" as const, prompt: "The transport is repaired; retry using the new bounded report evidence.", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "integration" as const, stageId: "delivery" },
	} };
	await adapter.resolveAttention!("work-item:example", decision, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "integration-guidance", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	const complete = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(integrations, 1); assert.equal(repairs, 1);
	assert.deepEqual(complete.stages[0]!.integration.contributionCommits, ["same-contribution"]);
	assert.equal(complete.stages[0]!.integration.integratedCommit, "same-integration");
	assert.equal(complete.executionCorrections?.at(-1)?.target.kind, "integration");
});

test("concurrent task failures reject a stale target and expose each authoritative correction boundary", async (t) => {
	const gates = { a: deferred<StoryWorkflowActionResult>(), b: deferred<StoryWorkflowActionResult>() };
	const started = new Set<string>();
	const repairReasons: string[] = [];
	const tasks = [task("a"), task("b")];
	const f = await fixture(t, {
		tasks,
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["a", "b"], mode: "concurrent", checks: [], review: { mode: "skip" } }] },
		execute: async ({ action }) => {
			if (action.kind === "task-launch") { started.add(action.taskId!); return gates[action.taskId as "a" | "b"].promise; }
			if (action.kind === "task-repair") { repairReasons.push(action.reason?.summary ?? ""); return { ...passed(), contributionCommit: `fixed-${action.taskId}` }; }
			if (action.kind === "integration") return { ...passed(), integratedCommit: "integrated" };
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(() => assert.deepEqual([...started].sort(), ["a", "b"]));
	gates.a.resolve({ result: "repairable", failure: { code: "failed-a", summary: "actual A" } });
	await eventually(async () => assert.deepEqual((await adapter.snapshot("work-item:example", f.ctx)).runtime.attentionTarget, { kind: "task", stageId: "delivery", taskId: "a" }));
	gates.b.resolve({ result: "repairable", failure: { code: "failed-b", summary: "actual B" } });
	await eventually(async () => {
		const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(runtime.attentionEpoch, 2);
		assert.deepEqual(runtime.attentionTarget, { kind: "task", stageId: "delivery", taskId: "b" });
	});
	const epochTwo = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "stale A", correction: {
		attentionEpoch: epochTwo.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "a" }, task: { description: "Stale A." },
	} }, f.ctx, { dryRun: true }), /authoritative attention boundary/i);
	const unchanged = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(unchanged.correctionSequence, undefined);
	assert.deepEqual(unchanged.stages[0]!.tasks.map((entry) => [entry.status, entry.failure?.summary]), [["attention", "actual A"], ["attention", "actual B"]]);
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "current B", correction: {
		attentionEpoch: epochTwo.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "b" }, task: { description: "Correct B." },
	} }, f.ctx);
	const remaining = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(remaining.status, "attention");
	assert.equal(remaining.attentionEpoch, 3);
	assert.deepEqual(remaining.attentionTarget, { kind: "task", stageId: "delivery", taskId: "a" });
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "current A", correction: {
		attentionEpoch: remaining.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "a" }, task: { description: "Correct A." },
	} }, f.ctx);
	const resolved = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(resolved.status, "paused");
	assert.deepEqual(resolved.executionCorrections?.map((entry) => entry.priorFailure.summary), ["actual B", "actual A"]);
	await adapter.controlExecution!("work-item:example", "resume", "all-resolved", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	assert.deepEqual(repairReasons.sort(), ["current A", "current B"]);
});

test("exhausted stage-review, final-review, and E2E guidance recover through fix and rerun", async (t) => {
	for (const targetKind of ["stage-review", "final-review", "e2e"] as const) {
		let evaluations = 0; let fixes = 0;
		const actionKind = targetKind === "stage-review" ? "review" : targetKind;
		const fixKind = targetKind === "stage-review" ? "review-fix" : targetKind === "final-review" ? "final-review-fix" : "e2e-fix";
		const f = await fixture(t, {
			plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: targetKind === "stage-review" ? "required" : "skip" } }] },
			execute: async ({ action }) => {
				if (action.kind === "task-launch") return { ...passed(), contributionCommit: "contribution" };
				if (action.kind === "integration") return { ...passed(), integratedCommit: "integration" };
				if (action.kind === actionKind) { evaluations++; return evaluations === 1 ? { result: "repairable", failure: { code: `${targetKind}_failed`, summary: `${targetKind} failed` } } : passed(); }
				if (action.kind === fixKind) { fixes++; return passed(); }
				return passed();
			},
		});
		f.runtime.config.limits.repairRounds = 0;
		const adapter = f.create(); await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
		const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		const target = targetKind === "stage-review" ? { kind: targetKind, stageId: "delivery" } as const : { kind: targetKind } as const;
		assert.deepEqual(attention.attentionTarget, target);
		await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: `new ${targetKind} evidence`, correction: { attentionEpoch: attention.attentionEpoch!, target } }, f.ctx);
		await adapter.controlExecution!("work-item:example", "resume", `${targetKind}-resume`, f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
		const complete = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		const slot = targetKind === "stage-review" ? complete.stages[0]!.review : targetKind === "final-review" ? complete.finalReview : complete.e2e;
		assert.equal(evaluations, 2); assert.equal(fixes, 1); assert.equal(slot.repairCount, 1);
	}
});

test("runtime-slot guidance rejects normal Critical review attention and an exhausted wrapper retaining it", async (t) => {
	const f = await fixture(t, {
		plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "required" } }] },
		execute: async ({ action }) => {
			if (action.kind === "task-launch") return { ...passed(), contributionCommit: "contribution" };
			if (action.kind === "integration") return { ...passed(), integratedCommit: "integration" };
			if (action.kind === "review") return { result: "critical", failure: { code: "security", summary: "critical risk" }, findings: [{ id: "critical", severity: "critical", code: "security", summary: "critical risk" }] };
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	let attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const decision = { action: "request_changes" as const, prompt: "do not waive", correction: { attentionEpoch: attention.attentionEpoch!, target: { kind: "stage-review" as const, stageId: "delivery" } } };
	await assert.rejects(adapter.resolveAttention!("work-item:example", decision, f.ctx, { dryRun: true }), /repair-exhausted/i);
	await new StoryRuntimeStore(f.root, "example").updateState((current) => {
		const next = structuredClone(current!);
		const wrapped = { code: "repair_exhausted", causeCode: "security", summary: "exhausted wrapper" };
		next.attention = wrapped; next.stages[0]!.review.failure = wrapped;
		return next;
	});
	attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await assert.rejects(adapter.resolveAttention!("work-item:example", { ...decision, correction: { ...decision.correction, attentionEpoch: attention.attentionEpoch! } }, f.ctx, { dryRun: true }), /cannot waive a retained Critical/i);
});

test("task correction guidance is attempt-local and a later prompt-less correction receives the new failure", async (t) => {
	const repairReasons: string[] = [];
	let repairs = 0;
	const f = await fixture(t, { execute: async ({ action }) => {
		if (action.kind === "task-launch") return { result: "repairable", failure: { code: "initial", summary: "initial failure" } };
		if (action.kind === "task-repair") {
			repairReasons.push(action.reason?.summary ?? ""); repairs++;
			return repairs === 1 ? { result: "repairable", failure: { code: "later", summary: "failure Q" } } : { ...passed(), contributionCommit: "fixed" };
		}
		if (action.kind === "integration") return { ...passed(), integratedCommit: "integrated" };
		return passed();
	} });
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	let attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "guidance P", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { description: "First corrected description." },
	} }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "first-correction", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(attention.stages[0]!.tasks[0]!.failure?.summary, "failure Q");
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { description: "Second corrected description." },
	} }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "second-correction", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	assert.deepEqual(repairReasons, ["guidance P", "failure Q"]);
});

test("corrected task prose reaches the fresh repair and later whole-branch review", async (t) => {
	const seen: Array<[string, string, string, string]> = [];
	const f = await fixture(t, {
		execute: async (context) => {
			const current = context.tasks.get("task-a")!;
			if (context.action.kind === "task-launch") return { result: "repairable", failure: { code: "worker_failed", summary: "factual capsule defect" } };
			if (context.action.kind === "task-repair" || context.action.kind === "final-review") seen.push([context.action.kind, current.description, current.scope, current.delivery]);
			if (context.action.kind === "task-repair") return { ...passed(), contributionCommit: "corrected-contribution" };
			if (context.action.kind === "integration") return { ...passed(), integratedCommit: "corrected-integration" };
			return passed();
		},
	});
	f.runtime.config.limits.repairRounds = 0;
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"));
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", prompt: "Use the corrected capsule.", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" },
		task: { description: "Corrected description.", scope: "Corrected scope.", delivery: "Corrected delivery." },
	} }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "prose-resume", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"));
	assert.deepEqual(seen, [
		["task-repair", "Corrected description.", "Corrected scope.", "Corrected delivery."],
		["final-review", "Corrected description.", "Corrected scope.", "Corrected delivery."],
	]);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(runtime.stages[0]!.tasks[0]!.repairCount, 1);
	assert.equal(runtime.executionCorrections?.[0]?.priorFailure.summary, "factual capsule defect");
});

test("known xcodebuild destination configuration failures reach attention before a repair worker is launched", async (t) => {
	const check = "printf 'xcodebuild: error: Unable to find a destination matching the provided destination specifier\\n' >&2; printf 'Available destinations: simulator inventory\\n'; exit 70";
	const f = await fixture(t, { tasks: [task("task-a", [{ id: "ios", command: check }])] });
	let repairs = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "implementation.txt"), "implemented\n");
			await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
			return { text: "implemented" };
		}
		if (input.action === "task-repair") repairs++;
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(repairs, 0);
	assert.equal(runtime.stages[0]!.tasks[0]!.repairCount, 0);
	assert.equal(runtime.attention?.causeCode, "check_configuration");
	assert.match(runtime.attention?.summary ?? "", /Unable to find a destination matching/);
	assert.match(runtime.attention?.diagnostic?.stdout ?? "", /Available destinations/);
	assert.match(runtime.attention?.diagnostic?.stderr ?? "", /error:/);
});

test("production xcodebuild correction recovers an exhausted repaired task without reimplementation", async (t) => {
	const authored = task("task-a");
	const f = await fixture(t, { tasks: [authored] });
	const bin = await mkdtemp(join(tmpdir(), "pibox-fake-xcode-")); t.after(() => rm(bin, { recursive: true, force: true }));
	const executable = join(bin, "xcodebuild"); const count = join(bin, "xcode-count");
	await writeFile(executable, `#!/bin/sh\ncase "$*" in *18.3.1*) exit 0;; esac\nif [ ! -f '${count}' ]; then : > '${count}'; echo 'Assertion failed before destination lookup' >&2; exit 1; fi\necho 'xcodebuild: error: Unable to find a destination matching the provided destination specifier:' >&2\necho '{ platform:iOS Simulator, OS:18.3, name:iPhone 16 }' >&2\nexit 70\n`);
	await chmod(executable, 0o755);
	const oldCommand = `${executable} test -destination 'platform=iOS Simulator,OS=18.3,name=iPhone 16'`;
	const correctedCommand = `${executable} test -destination 'platform=iOS Simulator,OS=18.3.1,name=iPhone 16'`;
	authored.checks = [{ id: "ios", command: oldCommand }];
	let implementations = 0; let repairs = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch" || input.action === "task-repair") {
			if (input.action === "task-launch") implementations++; else repairs++;
			await writeFile(join(input.cwd, "implementation.txt"), `${input.action}\n`, { flag: "a" });
			await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", input.action], { cwd: input.cwd });
			return { text: "committed" };
		}
		if (input.role === "e2e-tester") {
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "journey.txt");
			await mkdir(join(evidence, ".."), { recursive: true }); await writeFile(evidence, "passed\n");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/journey.txt"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [] }) };
	});
	f.runtime.config.limits.repairRounds = 1;
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const attention = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const beforeContribution = attention.stages[0]!.tasks[0]!.contributionCommit;
	assert.equal(attention.stages[0]!.tasks[0]!.repairCount, 1);
	assert.equal(attention.attention?.causeCode, "check_configuration");
	await adapter.resolveAttention!("work-item:example", { action: "request_changes", correction: {
		attentionEpoch: attention.attentionEpoch!, target: { kind: "task", stageId: "delivery", taskId: "task-a" }, task: { checks: [{ id: "ios", command: correctedCommand }] },
	} }, f.ctx);
	await adapter.controlExecution!("work-item:example", "resume", "xcode-corrected", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	const complete = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(implementations, 1); assert.equal(repairs, 1);
	assert.equal(complete.stages[0]!.tasks[0]!.repairCount, 1);
	assert.equal(complete.stages[0]!.tasks[0]!.contributionCommit, beforeContribution);
	assert.equal(complete.stages[0]!.integration.contributionCommits[0], beforeContribution);
	assert.ok(complete.stages[0]!.integration.integratedCommit);
	assert.equal(complete.executionCorrections?.at(-1)?.priorRepairCount, 1);
});

test("a bare destination-specifier assertion is not classified as an Xcode environment failure", () => {
	const failure = checkFailureSummary("unit", "npm test", { code: 1, stdout: "", stderr: "AssertionError: expected destination specifier", outputTruncated: false });
	assert.equal(failure.causeCode, "check_failed");
});

test("an identical deterministic failure stops after one real code repair", async (t) => {
	const f = await fixture(t, { tasks: [task("task-a", [{ id: "unit", command: "printf 'Assertion failed: expected true\\n' >&2; exit 1" }])] });
	let repairs = 0;
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") await writeFile(join(input.cwd, "implementation.txt"), "first\n");
		else if (input.action === "task-repair") { repairs++; await writeFile(join(input.cwd, "implementation.txt"), "first\nrepair\n"); }
		else return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
		await exec("git", ["commit", "-qm", input.action], { cwd: input.cwd });
		return { text: "committed" };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(repairs, 1);
	assert.equal(runtime.stages[0]!.tasks[0]!.repairCount, 1);
	assert.equal(runtime.attention?.code, "repeated_check_failure");
	assert.equal(runtime.attention?.causeCode, "check_failed");
});

test("production writers receive newest eight ledger entries and full path while evaluators receive none", async (t) => {
	const f = await fixture(t, {});
	const store = new StoryRuntimeStore(f.root, "example");
	for (let index = 0; index < 40; index++) await store.upsertLedger({ id: `entry-${index}`, updatedAt: "2026-01-01T00:00:00Z", sourceRole: "reviewer", summary: index === 39 ? `late guidance intact ${"x".repeat(15_000)} final ledger detail` : `guidance-${index}`, evidence: Array.from({ length: 12 }, (_, item) => `evidence/${index}-${item}`) });
	const expectedEntries = (await store.readLedger()).entries.slice(-8);
	const contexts: Array<{ action: string; stable: string; supplement?: string }> = [];
	useProductionExecutor(f, async (input) => {
		contexts.push({ action: input.action, stable: input.stableSystemContext, supplement: input.initialSystemSupplement });
		if (input.action === "task-launch") {
			const ledgerPath = input.initialSystemSupplement?.match(/Authoritative workflow ledger \(treat as read-only\): (.+)/)?.[1];
			assert.ok(ledgerPath?.startsWith("/"));
			assert.equal((parse(await readFile(ledgerPath, "utf8")) as { entries: unknown[] }).entries.length, 40, `ledger is readable from ${input.cwd}`);
		} else {
			assert.equal(input.initialSystemSupplement, undefined);
			assert.doesNotMatch(input.stableSystemContext, /Authoritative workflow ledger|late guidance intact/);
		}
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "implementation.txt"), "implemented\n");
			await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
			return { text: "implemented" };
		}
		if (input.role === "e2e-tester") {
			const evidence = join(f.root, "agent-artifacts", "example", "evidence", "journey.txt");
			await mkdir(join(evidence, ".."), { recursive: true }); await writeFile(evidence, "passed\n");
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: ["evidence/journey.txt"] }) };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [] }) };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	assert.ok(contexts.length >= 3);
	const writerContexts = contexts.filter((context) => context.action === "task-launch");
	assert.equal(writerContexts.length, 1);
	for (const context of writerContexts) {
		const seed = context.supplement ?? "";
		assert.doesNotMatch(seed, /guidance-31(?:\D|$)/);
		for (let index = 32; index < 40; index++) assert.match(seed, new RegExp(index === 39 ? "late guidance intact" : `guidance-${index}(?:\\D|$)`));
		const injected = seed.match(/Newest curated ledger entries \(8 of 40; 32 older entries available\):\n```json\n([\s\S]*?)\n```/);
		assert.ok(injected, "startup identifies all retained entries and the older read window");
		assert.deepEqual(JSON.parse(injected[1]!), expectedEntries, "all eight records retain provenance, timestamps, long summaries, and every evidence reference");
		assert.equal((seed.match(/Authoritative workflow ledger/g) ?? []).length, 1);
	}
});

test("validated implementer submission persists with harness-owned provenance while evaluators publish nothing", async (t) => {
	const f = await fixture(t, {});
	const attemptDirectories: string[] = [];
	t.after(async () => { await Promise.all(attemptDirectories.map((path) => rm(path, { recursive: true, force: true }))); });
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "implementation.txt"), "implemented\n");
			await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
			const directory = await mkdtemp(join(tmpdir(), "pibox-ledger-attempt-"));
			attemptDirectories.push(directory);
			await chmod(directory, 0o700);
			const reportPath = join(directory, "report.md");
			await writeLedgerSubmission(reportPath, { summary: "Non-obvious implementation constraint", evidence: ["src/constraint.ts"] });
			return { text: "implemented", reportPath };
		}
		return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	const entries = (await new StoryRuntimeStore(f.root, "example").readLedger()).entries;
	assert.equal(entries.length, 1);
	assert.match(entries[0]!.id, /^contribution:.+:task-launch$/);
	assert.equal(entries[0]!.sourceRole, "implementer");
	assert.equal(entries[0]!.summary, "Non-obvious implementation constraint");
	assert.deepEqual(entries[0]!.evidence, ["src/constraint.ts"]);
});

test("malformed submission surfaces attention after accepting validated contribution without relaunch", async (t) => {
	const f = await fixture(t, {});
	let launches = 0;
	const directories: string[] = [];
	t.after(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });
	useProductionExecutor(f, async (input) => {
		if (input.action !== "task-launch") return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		launches++;
		await writeFile(join(input.cwd, "implementation.txt"), "implemented\n");
		await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
		await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
		const directory = await mkdtemp(join(tmpdir(), "pibox-ledger-malformed-"));
		directories.push(directory); await chmod(directory, 0o700);
		await writeFile(join(directory, "workflow-ledger.json"), "{not-json", { mode: 0o600 });
		return { text: "implemented", reportPath: join(directory, "report.md") };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
	const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	assert.equal(launches, 1);
	assert.equal(runtime.stages[0]!.tasks[0]!.status, "completed");
	assert.equal(runtime.attention?.code, "ledger_persistence_failed");
	assert.match(runtime.attention?.summary ?? "", /malformed JSON/);
	assert.equal(Object.values(runtime.ledgerRecoveries ?? {})[0]?.submission, undefined);
	const recovered = await adapter.resolveAttention!("work-item:example", { action: "approve" }, f.ctx);
	assert.equal(recovered.status, "paused");
	assert.equal(recovered.ledgerRecoveries, undefined);
	await adapter.controlExecution!("work-item:example", "resume", "after-ledger-ack", f.ctx);
	await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	assert.equal(launches, 1);
});

test("concurrent valid submissions survive failed writes and recover independently without task relaunch", async (t) => {
	const tasks = [task("task-a"), task("task-b")];
	const f = await fixture(t, { tasks, plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: tasks.map((entry) => entry.id), mode: "concurrent", checks: [], review: { mode: "skip" } }] } });
	const launches = new Map<string, number>();
	const directories: string[] = [];
	const release = deferred<void>();
	t.after(async () => { await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true }))); });
	useProductionExecutor(f, async (input) => {
		if (input.action !== "task-launch") return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		launches.set(input.taskId, (launches.get(input.taskId) ?? 0) + 1);
		await writeFile(join(input.cwd, `${input.taskId}.txt`), "implemented\n");
		await exec("git", ["add", `${input.taskId}.txt`], { cwd: input.cwd }); await exec("git", ["commit", "-qm", `implement ${input.taskId}`], { cwd: input.cwd });
		const directory = await mkdtemp(join(tmpdir(), "pibox-ledger-retry-")); directories.push(directory); await chmod(directory, 0o700);
		const reportPath = join(directory, "report.md"); await writeLedgerSubmission(reportPath, { summary: `Retain ${input.taskId} note` });
		await release.promise;
		return { text: "implemented", reportPath };
	});
	const adapter = f.create(); await start(adapter, f.ctx);
	await eventually(() => assert.equal(launches.size, 2));
	const ledgerPath = join(f.root, "agent-artifacts", "example", "ledger.yaml");
	await writeFile(ledgerPath, "malformed-ledger", { mode: 0o600 }); release.resolve();
	await eventually(async () => { const runtime = (await adapter.snapshot("work-item:example", f.ctx)).runtime; assert.equal(Object.keys(runtime.ledgerRecoveries ?? {}).length, 2, JSON.stringify(runtime)); }, 8_000);
	await rm(ledgerPath, { force: true });
	const initial = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const expected = structuredClone(Object.values(initial.ledgerRecoveries ?? {})[0]!);
	const expectedOther = structuredClone(Object.values(initial.ledgerRecoveries ?? {})[1]!);
	await adapter.resolveAttention!("work-item:example", { action: "request_changes" }, f.ctx, { dryRun: true, expectedLedgerRecovery: expected });
	await adapter.resolveAttention!("work-item:example", { action: "request_changes" }, f.ctx, { dryRun: true, expectedLedgerRecovery: expected });
	const first = await adapter.resolveAttention!("work-item:example", { action: "request_changes" }, f.ctx, { expectedLedgerRecovery: expected });
	assert.equal(first.status, "attention"); assert.equal(Object.keys(first.ledgerRecoveries ?? {}).length, 1);
	await assert.rejects(adapter.resolveAttention!("work-item:example", { action: "request_changes" }, f.ctx, { expectedLedgerRecovery: expected }), /changed before settlement/);
	assert.deepEqual(Object.values((await adapter.snapshot("work-item:example", f.ctx)).runtime.ledgerRecoveries ?? {}), [expectedOther]);
	const recovered = await adapter.resolveAttention!("work-item:example", { action: "request_changes" }, f.ctx);
	assert.equal(recovered.status, "paused"); assert.equal(recovered.ledgerRecoveries, undefined);
	assert.deepEqual((await new StoryRuntimeStore(f.root, "example").readLedger()).entries.map((entry) => entry.summary).sort(), ["Retain task-a note", "Retain task-b note"]);
	await adapter.controlExecution!("work-item:example", "resume", "after-ledger-retries", f.ctx); await adapter.advanceWorkflow!("work-item:example", f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	assert.deepEqual([...launches].sort(), [["task-a", 1], ["task-b", 1]]);
});

test("production review preserves every complete finding and rejects malformed findings explicitly", async (t) => {
	for (const malformed of [false, true]) {
		const longSummary = `finding-start-${"x".repeat(4_500)}-finding-end`;
		const findings = Array.from({ length: 201 }, (_, index) => ({ id: `finding-${index}`, severity: index === 200 ? "critical" : "minor", code: `code-${index}`, summary: index === 200 ? longSummary : `summary-${index}`, path: `src/${"p".repeat(510)}-${index}.ts` }));
		const f = await fixture(t, { plan: { schemaVersion: 1, stages: [{ id: "delivery", tasks: ["task-a"], mode: "sequential", checks: [], review: { mode: "required" } }] } });
		useProductionExecutor(f, async (input) => {
			if (input.action === "task-launch") {
				await writeFile(join(input.cwd, "implementation.txt"), "implemented\n");
				await exec("git", ["add", "implementation.txt"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "implementation"], { cwd: input.cwd });
				return { text: "implemented" };
			}
			if (input.action === "review") return { text: JSON.stringify({ result: "critical", summary: "reviewed", findings: malformed ? [...findings, { severity: "minor", summary: "missing identity" }] : findings }) };
			return { text: JSON.stringify({ result: "passed", summary: "passed", findings: [], evidenceRefs: [] }) };
		});
		f.runtime.config.limits.repairRounds = 0;
		const adapter = f.create(); await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "attention"), 8_000);
		const review = (await adapter.snapshot("work-item:example", f.ctx)).runtime.stages[0]!.review;
		if (malformed) {
			assert.equal(review.currentFindings.length, 0);
			assert.equal(review.failure?.code, "repair_exhausted");
			assert.match(review.failure?.summary ?? "", /invalid_structured_result|invalid.*id/i);
		} else {
			assert.equal(review.currentFindings.length, 201);
			assert.equal(review.currentFindings[200]!.summary, longSummary);
			assert.ok(review.currentFindings[200]!.path!.length > 500);
		}
	}
});

test("bounded diagnostics retain early roots plus both stream heads and tails", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-check-output-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const command = "printf 'error: Unable to find a destination matching early\\n'; printf 'stderr begins\\n' >&2; i=0; while [ $i -lt 3000 ]; do printf 'simulator stdout %04d xxxxxxxxxx\\n' $i; printf 'simulator stderr %04d yyyyyyyyyy\\n' $i >&2; i=$((i+1)); done; exit 70";
	const executed = await runShell(command, root, new AbortController().signal);
	const failed = checkFailureSummary("ios", command, executed);
	assert.equal(executed.outputTruncated, true);
	assert.match(failed.summary, /Unable to find a destination matching early/);
	assert.match(failed.diagnostic.stdout, /^error: Unable/);
	assert.match(failed.diagnostic.stdout, /tail follows/);
	assert.match(failed.diagnostic.stdout, /simulator stdout 2999/);
	assert.match(failed.diagnostic.stderr, /^stderr begins/);
	assert.match(failed.diagnostic.stderr, /simulator stderr 2999/);
	assert.ok(failed.diagnostic.stdout.length < 20_000 && failed.diagnostic.stderr.length < 20_000);
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

test("tool-backed E2E report owns verdict, canonical publication, and current pointer", async (t) => {
	const f = await fixture(t, {});
	let token = "";
	let e2eTools: string[] = [];
	let reviewTools: string[] = [];
	useProductionExecutor(f, async (input) => {
		if (input.action === "task-launch") {
			await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
			await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
			await exec("git", ["commit", "-qm", "deliver"], { cwd: input.cwd });
			return { text: "done" };
		}
		if (input.action === "e2e") {
			token = input.attemptToken;
			e2eTools = input.tools;
			const witness = join(input.env.PIBOX_E2E_SCRATCH_DIR, "witness.txt");
			await writeFile(witness, "full Unicode witness 🧪\n");
			const reportPath = await submitE2eFixture(f, input, {
				cases: [{ case: "E2E-001", verdict: "passed", steps: ["exercise"], expected: "visible", observed: "visible 🧪", evidence: [witness] }],
				summary: "authoritative pass",
			});
			return { text: "free-form prose says failure but is irrelevant", reportPath };
		}
		reviewTools = input.tools;
		return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
	});
	const adapter = f.create();
	await start(adapter, f.ctx);
	await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
	const state = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
	const reportRef = `evidence/e2e-${token}/report.json`;
	assert.equal(state.e2e.currentReportRef, reportRef);
	assert.equal(state.e2e.currentEvidenceRefs?.[0], reportRef);
	assert.ok(state.e2e.evidenceRefs.includes(reportRef));
	assert.ok(e2eTools.includes("workflow_e2e_report"));
	assert.equal(reviewTools.includes("workflow_e2e_report"), false);
	const report = await readFile(join(f.root, "agent-artifacts", "example", reportRef), "utf8");
	assert.match(report, /visible 🧪/);
	assert.match(await readFile(join(f.root, "agent-artifacts", "example", state.e2e.currentEvidenceRefs![1]!), "utf8"), /full Unicode witness 🧪/);
});

test("publication preflight and rollback leave no invocation-owned canonical files", async (t) => {
	for (const scenario of ["selective-ignore", "late-write", "rollback-conflict", "owner-loss", "abort"] as const) await t.test(scenario, async (t) => {
		const f = await fixture(t, {});
		if (scenario === "selective-ignore") {
			await writeFile(join(f.root, ".gitignore"), "/.worktree/\n/agent-artifacts/*/state.yaml\n/agent-artifacts/*/ledger.yaml\n/agent-artifacts/*/events.jsonl\n*.skip\n");
			await exec("git", ["add", ".gitignore"], { cwd: f.root });
			await exec("git", ["commit", "-qm", "ignore selected evidence"], { cwd: f.root });
		}
		let adapter: ReturnType<typeof createHarnessWorkflowAdapter>;
		let staged: E2eReportSubmission | undefined;
		let publicationDescriptors = 0;
		let foreignDestination = "";
		f.runtime.evidenceDescriptorOpened = async (openedPath: string) => {
			if (!openedPath.includes(".tmp-")) return;
			publicationDescriptors++;
			if (publicationDescriptors !== 2) return;
			if (scenario === "late-write" || scenario === "rollback-conflict") {
				foreignDestination = openedPath.slice(0, openedPath.lastIndexOf(".tmp-"));
				if (scenario === "rollback-conflict") {
					assert.ok(staged);
					await writeFile(join(f.root, "agent-artifacts", "example", staged.publishSources[0]!.storyRelativePath), "foreign replacement");
				}
				await mkdir(foreignDestination);
			} else if (scenario === "owner-loss") {
				f.setOwner({ sessionId: "replacement", processInstanceId: "replacement", activationId: "replacement" });
			} else if (scenario === "abort") {
				await adapter.controlExecution!("work-item:example", "stop", "abort-publication", f.ctx);
			}
		};
		useProductionExecutor(f, async (input) => {
			if (input.action === "task-launch") {
				await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
				await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "deliver"], { cwd: input.cwd });
				return { text: "done" };
			}
			if (input.action === "e2e") {
				const first = join(input.env.PIBOX_E2E_SCRATCH_DIR, "first.txt");
				const second = join(input.env.PIBOX_E2E_SCRATCH_DIR, scenario === "selective-ignore" ? "second.skip" : "second.txt");
				await writeFile(first, "first"); await writeFile(second, "second");
				const reportPath = await submitE2eFixture(f, input, { cases: [{ case: "E2E-001", verdict: "passed", evidence: [first, second] }] });
				staged = await readE2eReportSubmission(reportPath, input.attemptToken);
				return { text: "submitted", reportPath };
			}
			return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
		});
		adapter = f.create();
		await start(adapter, f.ctx);
		if (scenario === "owner-loss") await eventually(async () => { assert.ok(staged); assert.equal(publicationDescriptors, 2); assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.e2e.status, "interrupted"); }, 8_000);
		else if (scenario === "abort") await eventually(async () => { assert.ok(staged); assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "stopped"); }, 8_000);
		else await eventually(async () => { assert.ok(staged); assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "paused"); }, 8_000);
		assert.ok(staged);
		const canonical = staged.publishSources.map((source) => join(f.root, "agent-artifacts", "example", source.storyRelativePath));
		await eventually(async () => { for (const path of canonical) if (path !== foreignDestination && !(scenario === "rollback-conflict" && path === canonical[0])) await assert.rejects(access(path)); });
		for (const source of staged.publishSources) await access(source.sourcePath);
		if (scenario === "late-write" || scenario === "rollback-conflict") await stat(foreignDestination);
		if (scenario === "rollback-conflict") {
			assert.equal(await readFile(canonical[0]!, "utf8"), "foreign replacement");
			assert.match((await adapter.snapshot("work-item:example", f.ctx)).runtime.e2e.failure?.summary ?? "", /rollback preserved changed or foreign paths/);
		}
	});
});

test("missing E2E tool submission pauses and plain resume reruns only E2E without repair charge", async (t) => {
	for (const budget of [0, 2]) await t.test(`repair budget ${budget}`, async (t) => {
		const f = await fixture(t, {});
		let e2eLaunches = 0;
		let fixerLaunches = 0;
		useProductionExecutor(f, async (input) => {
			if (input.action === "task-launch") {
				await writeFile(join(input.cwd, "delivered.txt"), "delivered\n");
				await exec("git", ["add", "delivered.txt"], { cwd: input.cwd });
				await exec("git", ["commit", "-qm", "deliver"], { cwd: input.cwd });
				return { text: "done" };
			}
			if (input.action === "e2e-fix") { fixerLaunches++; return { text: "must not run" }; }
			if (input.action === "e2e") {
				e2eLaunches++;
				if (e2eLaunches === 1) return { text: "forgot tool", reportPath: join(f.runtime.identity.privateRoot, "missing", "report.md") };
				return { text: "submitted", reportPath: await submitE2eFixture(f, input, { cases: [{ case: "E2E-001", verdict: "passed" }] }) };
			}
			return { text: JSON.stringify({ result: "passed", summary: "review passed", findings: [] }) };
		});
		f.runtime.config.limits.repairRounds = budget;
		const adapter = f.create();
		await start(adapter, f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.status, "paused"), 8_000);
		const paused = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(paused.attention, undefined);
		assert.equal(paused.e2e.status, "interrupted");
		assert.equal(paused.e2e.repairCount, 0);
		assert.match(paused.e2e.failure?.summary ?? "", /invalid or unreadable|without calling/);
		await adapter.controlExecution!("work-item:example", "resume", "resume-report", f.ctx);
		await adapter.advanceWorkflow!("work-item:example", f.ctx);
		await eventually(async () => assert.equal((await adapter.snapshot("work-item:example", f.ctx)).runtime.outcomeStatus, "written"), 8_000);
		const completed = (await adapter.snapshot("work-item:example", f.ctx)).runtime;
		assert.equal(e2eLaunches, 2);
		assert.equal(fixerLaunches, 0);
		assert.equal(completed.e2e.repairCount, 0);
	});
});
