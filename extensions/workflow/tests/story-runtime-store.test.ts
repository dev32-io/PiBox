import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
	emptyWorkflowMetrics,
	effectiveExecutionOverrides,
	isCurrentAttempt,
	markWorkflowClockIncomplete,
	StoryRuntimeStore,
	transitionWorkflowClock,
	type ActivationOwner,
	type StoryRuntimeState,
	type TaskRuntimeState,
} from "../story-runtime-store.js";
import { resolveWorkflowAttention } from "../stage-state-machine.js";

async function fixture(t: test.TestContext, options: ConstructorParameters<typeof StoryRuntimeStore>[2] = {}) {
	const root = await mkdtemp(join(tmpdir(), "pibox-story-store-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return { root, store: new StoryRuntimeStore(root, "example-story", options) };
}

function state(status: StoryRuntimeState["status"] = "ready"): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId: "example-story",
		status,
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} },
		git: { canonicalBranch: "develop", baseCommit: "abc123" },
		stages: [],
		finalReview: { status: "pending", iteration: 0, repairCount: 0, currentFindings: [] },
		e2e: { status: "pending", repairCount: 0, evidenceRefs: [] },
		metrics: emptyWorkflowMetrics(),
	};
}

test("refuses the obsolete generic-slot runtime shape", async (t) => {
	const { store } = await fixture(t);
	await assert.rejects(store.writeState({ ...state(), finalReview: { id: "final-review", kind: "final-review", status: "pending", retryCount: 0 } } as never), /invalid runtime state/i);
});

test("rejects representative corrupt nested authoritative state", async (t) => {
	const { store } = await fixture(t);
	const valid = state();
	const validStage = { id: "delivery", status: "pending", tasks: [] as TaskRuntimeState[], integration: { status: "pending", repairCount: 0, contributionCommits: [] }, verification: { status: "pending", repairCount: 0, checks: [] }, review: { status: "pending", iteration: 0, repairCount: 0, currentFindings: [] } };
	const corruptions: unknown[] = [
		{ ...valid, status: "teleporting" },
		{ ...valid, stages: [{ ...validStage, id: 'x\"><img src=x onerror="globalThis.PWNED=1' }] },
		{ ...valid, stages: [{ ...validStage, tasks: [{ id: 'x\"><img src=x onerror="globalThis.PWNED=1', status: "pending", repairCount: 0, checks: [] }] }] },
		{ ...valid, steps: [] },
		{ ...valid, ledgerRecovery: { action: "task-launch", attemptToken: "old", sourceRole: "implementer", reportPath: "/tmp/report.md", error: "obsolete singular shape" } },
		{ ...valid, finalReview: { ...valid.finalReview, report: { verdict: "passed" } } },
		{ ...valid, git: { ...valid.git, baseCommit: "" } },
		{ ...valid, contracts: { story: valid.contracts.story, plan: valid.contracts.plan, tasks: { task: "task" } } },
		{ ...valid, contracts: { story: valid.contracts.story, plan: valid.contracts.plan } },
		{ ...valid, finalReview: { ...valid.finalReview, repairCount: -1 } },
		{ ...valid, finalReview: { ...valid.finalReview, status: "reviewing", attempt: { token: "token", owner: { sessionId: "s", processInstanceId: "p" }, activatedAt: "2026-01-01T00:00:00.000Z" } } },
		{ ...valid, finalReview: { ...valid.finalReview, status: "reviewing", attempt: { token: "token", owner: { sessionId: "s", processInstanceId: "p", activationId: "a" }, activatedAt: "not-a-time" } } },
		{ ...valid, finalReview: { ...valid.finalReview, currentFindings: [{ id: "f", severity: "urgent", code: "bad", summary: "invalid severity" }] } },
		{ ...valid, e2e: { ...valid.e2e, cases: [] } },
		{ ...valid, e2e: { ...valid.e2e, evidenceRefs: [42] } },
		{ ...valid, metrics: { ...valid.metrics, categories: { ...valid.metrics.categories, review: 1 } } },
		{ ...valid, metrics: { ...valid.metrics, open: { category: "orchestration", since: "2026-01-01T00:00:00.000Z" } } },
		{ ...valid, metrics: { ...valid.metrics, open: { category: "review", since: "not-a-time" } } },
		{ ...valid, stages: [validStage], metrics: { ...valid.metrics, open: { category: "review", since: "2026-01-01T00:00:00.000Z", stageId: "other-stage" } } },
		{ ...valid, stages: [validStage], metrics: { ...valid.metrics, stageBreakdown: { delivery: { workflowMs: 1, categories: { ...valid.metrics.categories, implementation: 1 }, incompleteIntervals: 0, incompleteCategories: [] } } } },
	];
	for (const corruption of corruptions) await assert.rejects(store.writeState(corruption as never), /invalid runtime state/i);
});

test("normalizes only missing Repair totals in five-category persisted metrics", async (t) => {
	const { store } = await fixture(t);
	const legacy = state();
	legacy.stages = [{
		id: "delivery", status: "pending", tasks: [],
		integration: { status: "pending", repairCount: 0, contributionCommits: [] },
		verification: { status: "pending", repairCount: 0, checks: [] },
		review: { status: "pending", iteration: 0, repairCount: 0, currentFindings: [] },
	}];
	const fiveCategories = { implementation: 4, integration: 3, verification: 2, review: 1, e2e: 0 };
	legacy.metrics = {
		workflowMs: 10,
		categories: fiveCategories as never,
		incompleteIntervals: 0,
		incompleteCategories: [],
		stageBreakdown: { delivery: { workflowMs: 10, categories: { ...fiveCategories } as never, incompleteIntervals: 0, incompleteCategories: [] } },
	};
	await mkdir(store.storyRoot, { recursive: true });
	await writeFile(store.statePath, JSON.stringify(legacy));
	const normalized = (await store.readState())!;
	assert.deepEqual(normalized.metrics.categories, { ...fiveCategories, repair: 0 });
	assert.deepEqual(normalized.metrics.stageBreakdown?.delivery?.categories, { ...fiveCategories, repair: 0 });
	assert.equal(normalized.metrics.workflowMs, 10, "legacy sum remains unchanged");

	for (const categories of [
		{ implementation: 4, integration: 3, verification: 2, review: 1 },
		{ ...fiveCategories, unknown: 0 },
		{ ...fiveCategories, repair: "0" },
	]) {
		await writeFile(store.statePath, JSON.stringify({ ...legacy, metrics: { ...legacy.metrics, categories } }));
		await assert.rejects(store.readState(), /invalid runtime state/i);
	}
});

test("persists large valid workflow topology and authoritative collections without count ceilings", async (t) => {
	const { store } = await fixture(t);
	const checks = Array.from({ length: 201 }, (_, index) => ({ id: `check-${index}`, status: "pending" as const }));
	const tasks = Array.from({ length: 201 }, (_, index) => ({ id: `task-${index}`, status: "pending" as const, repairCount: 0, checks: structuredClone(checks) }));
	const findings = Array.from({ length: 201 }, (_, index) => ({ id: `finding-${index}`, severity: "minor" as const, code: "review", summary: `finding ${index}` }));
	const stages = Array.from({ length: 101 }, (_, index) => ({
		id: `stage-${index}`, status: "pending" as const, tasks: index === 0 ? tasks : [],
		integration: { status: "pending" as const, repairCount: 0, contributionCommits: Array.from({ length: 201 }, (_, commit) => `commit-${commit}`) },
		verification: { status: "pending" as const, repairCount: 0, checks: index === 0 ? checks : [] },
		review: { status: "pending" as const, iteration: 0, repairCount: 0, currentFindings: index === 0 ? findings : [] },
	}));
	const large: StoryRuntimeState = {
		...state(), stages,
		contracts: { ...state().contracts, tasks: Object.fromEntries(tasks.map((task) => [task.id, `sha256:${"c".repeat(64)}`])) },
		e2e: { ...state().e2e, evidenceRefs: Array.from({ length: 65 }, (_, index) => `evidence/${index}`) },
	};
	await store.writeState(large);
	const reloaded = (await store.readState())!;
	assert.equal(reloaded.stages.length, 101);
	assert.equal(reloaded.stages[0]!.tasks.length, 201);
	assert.equal(reloaded.stages[0]!.verification.checks.length, 201);
	assert.equal(reloaded.stages[0]!.review.currentFindings.length, 201);
	assert.equal(reloaded.e2e.evidenceRefs.length, 65);
});

test("loads pre-correction state and preserves complete check diagnostics", async (t) => {
	const { store } = await fixture(t);
	await store.writeState(state("attention"));
	assert.equal((await store.readState())?.executionCorrections, undefined, "old runtime state remains compatible");
	const diagnosticState = state("attention");
	diagnosticState.attentionEpoch = 1;
	diagnosticState.attention = {
		code: "repair_exhausted", causeCode: "check_configuration", summary: "destination unavailable",
		diagnostic: { checkId: "ios", command: "xcodebuild test", exitCode: 70, stdout: "simulators", stderr: "error: destination unavailable", outputTruncated: true },
	};
	diagnosticState.attention.diagnostic!.stdout = `head-${"x".repeat(20_001)}-tail`;
	await store.writeState(diagnosticState);
	assert.deepEqual((await store.readState())?.attention, diagnosticState.attention);
});

test("legacy slot attention deterministically gains an authoritative target while workflow-level attention remains targetless", async (t) => {
	const { store } = await fixture(t);
	const failure = { code: "repair_exhausted", summary: "legacy failure" };
	const legacy: StoryRuntimeState = {
		...state("attention"), attention: failure, attentionEpoch: 2,
		stages: [{
			id: "delivery", status: "attention",
			tasks: [
				{ id: "a", status: "attention", repairCount: 0, checks: [], failure },
				{ id: "b", status: "attention", repairCount: 0, checks: [], failure },
			],
			integration: { status: "pending", repairCount: 0, contributionCommits: [] },
			verification: { status: "pending", repairCount: 0, checks: [] },
			review: { status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] },
		}],
	};
	await mkdir(store.storyRoot, { recursive: true });
	await writeFile(store.statePath, JSON.stringify(legacy));
	assert.deepEqual((await store.readState())?.attentionTarget, { kind: "task", stageId: "delivery", taskId: "a" });
	const globalOnly = state("attention");
	globalOnly.attention = { code: "plan_mismatch", summary: "unsafe global boundary" };
	await writeFile(store.statePath, JSON.stringify(globalOnly));
	assert.equal((await store.readState())?.attentionTarget, undefined);
});

test("reload retains complete correction history and cumulative effective overrides", async (t) => {
	const { store } = await fixture(t);
	const failure = { code: "repair_exhausted", summary: "needs correction" };
	let current: StoryRuntimeState = {
		...state("attention"), attention: failure, attentionEpoch: 1,
		stages: [{
			id: "delivery", status: "attention",
			tasks: [{ id: "task-a", status: "attention", repairCount: 0, checks: [], failure }],
			integration: { status: "pending", repairCount: 0, contributionCommits: [] },
			verification: { status: "pending", repairCount: 0, checks: [] },
			review: { status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] },
		}],
	};
	for (let sequence = 1; sequence <= 40; sequence++) {
		const correction = {
			sequence, attentionEpoch: current.attentionEpoch!, appliedAt: `2026-01-01T00:00:${String(sequence).padStart(2, "0")}.000Z`,
			target: { kind: "task" as const, stageId: "delivery", taskId: "task-a" },
			task: sequence % 2 ? { description: `description-${sequence}` } : { scope: `scope-${sequence}` },
			priorFailure: failure, priorRepairCount: 0,
		};
		const resolved = resolveWorkflowAttention(current, { action: "request_changes", correction }, 0);
		assert.equal(resolved.accepted, true);
		current = resolved.state;
		if (sequence < 40) {
			current.status = "attention"; current.attention = failure; current.attentionEpoch = sequence + 1;
			current.stages[0]!.status = "attention"; current.stages[0]!.tasks[0]!.status = "attention"; current.stages[0]!.tasks[0]!.failure = failure;
		}
	}
	await store.writeState(current);
	const reloaded = (await store.readState())!;
	const effective = effectiveExecutionOverrides(reloaded);
	assert.equal(reloaded.correctionSequence, 40);
	assert.equal(reloaded.executionCorrections?.length, 40);
	assert.equal(reloaded.executionCorrections?.[0]?.sequence, 1);
	assert.equal(effective.tasks[0]?.task.description, "description-39");
	assert.equal(effective.tasks[0]?.task.scope, "scope-40");
});

test("a previously compacted history remains valid and keeps every future correction without inventing lost entries", async (t) => {
	const { store } = await fixture(t);
	const failure = { code: "repair_exhausted", summary: "needs correction" };
	const corrections = Array.from({ length: 32 }, (_, index) => ({
		sequence: index + 9, attentionEpoch: index + 9, appliedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
		target: { kind: "task" as const, stageId: "delivery", taskId: "task-a" }, task: { description: `old-${index + 9}` }, priorFailure: failure,
	}));
	const legacy: StoryRuntimeState = {
		...state("attention"), attention: failure, attentionEpoch: 41, attentionTarget: { kind: "task", stageId: "delivery", taskId: "task-a" }, correctionSequence: 40,
		executionOverrides: { tasks: [{ stageId: "delivery", taskId: "task-a", task: { description: "old-40" } }], stageVerifications: [], guidance: [] },
		executionCorrections: corrections,
		stages: [{ id: "delivery", status: "attention", tasks: [{ id: "task-a", status: "attention", repairCount: 0, checks: [], failure }], integration: { status: "pending", repairCount: 0, contributionCommits: [] }, verification: { status: "pending", repairCount: 0, checks: [] }, review: { status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] } }],
	};
	await store.writeState(legacy);
	const nextCorrection = { sequence: 41, attentionEpoch: 41, appliedAt: "2026-01-01T00:01:00.000Z", target: { kind: "task" as const, stageId: "delivery", taskId: "task-a" }, task: { description: "new-41" }, priorFailure: failure };
	const resolved = resolveWorkflowAttention((await store.readState())!, { action: "request_changes", correction: nextCorrection }, 0);
	assert.equal(resolved.accepted, true);
	await store.writeState(resolved.state);
	const history = (await store.readState())!.executionCorrections!;
	assert.equal(history.length, 33);
	assert.deepEqual(history.map((entry) => entry.sequence), Array.from({ length: 33 }, (_, index) => index + 9));
});

test("commits the atomic authoritative state before a best-effort debug append", async (t) => {
	const { store } = await fixture(t);
	await mkdir(store.eventsPath, { recursive: true }); // force event open to fail after state replacement
	const result = await store.writeState(state("running"), { type: "workflow.started", resultCode: "started" });
	assert.equal(result.debugEventAppended, false);
	assert.equal((await store.readState())?.status, "running");
	assert.equal((parse(await readFile(store.statePath, "utf8")) as StoryRuntimeState).status, "running");
});

test("serializes concurrent read-modify-write callbacks", async (t) => {
	const { store } = await fixture(t);
	await store.writeState(state());
	await Promise.all(Array.from({ length: 12 }, () => store.updateState((current) => ({
		...current!,
		finalReview: { ...current!.finalReview, repairCount: current!.finalReview.repairCount + 1 },
	}))));
	assert.equal((await store.readState())?.finalReview.repairCount, 12);
});

test("an identity-preserving update skips state replacement and its debug event", async (t) => {
	const { store } = await fixture(t);
	await store.writeState(state("running"));
	const before = await stat(store.statePath);
	const result = await store.updateState((current) => current!, { type: "workflow.advanced", resultCode: "running" });
	const after = await stat(store.statePath);
	assert.equal(result.stateWritten, false);
	assert.equal(result.debugEventAppended, false);
	assert.equal(after.ino, before.ino, "a no-op must not atomically replace state.yaml");
	assert.deepEqual(await store.readDebugTail(), []);
});

test("rejects stale attempts by opaque token and activation owner", () => {
	const owner: ActivationOwner = { sessionId: "session-a", processInstanceId: "process-a", activationId: "activation-a" };
	const running: TaskRuntimeState = {
		id: "task-a",
		status: "implementing",
		repairCount: 0,
		checks: [],
		attempt: { token: "opaque-token", owner, activatedAt: "2026-01-01T00:00:00.000Z" },
	};
	assert.equal(isCurrentAttempt(running, "opaque-token", owner), true);
	assert.equal(isCurrentAttempt(running, "old-token", owner), false);
	assert.equal(isCurrentAttempt(running, "opaque-token", { ...owner, activationId: "activation-b" }), false);
	assert.equal(isCurrentAttempt(running, "opaque-token", { ...owner, processInstanceId: "process-b" }), false);
	assert.equal(isCurrentAttempt(running, "opaque-token", { ...owner, sessionId: "session-b" }), false);
	const { attempt: _attempt, ...settled } = running;
	assert.equal(isCurrentAttempt(settled, "opaque-token", owner), false);
});

test("reads a bounded filtered debug tail and tolerates a malformed trailing line", async (t) => {
	const { store } = await fixture(t, { now: () => new Date("2026-01-01T00:00:00.000Z"), maxDebugTailEntries: 3 });
	await store.appendDebug({ type: "task.started", taskId: "task-a" });
	await store.appendDebug({ type: "task.completed", taskId: "task-a", durationMs: 10, resultCode: "passed" });
	await store.appendDebug({ type: "task.completed", taskId: "task-b", durationMs: 20, resultCode: "failed" });
	await writeFile(store.eventsPath, "{malformed", { flag: "a" });
	await store.appendDebug({ type: "task.completed", taskId: "task-a", durationMs: 30, resultCode: "recovered" });
	const events = await store.readDebugTail(99, { types: ["task.completed"], taskId: "task-a" });
	assert.deepEqual(events.map((event) => event.resultCode), ["passed", "recovered"]);
});

test("debug serialization drops undeclared content fields", async (t) => {
	const { store } = await fixture(t);
	await store.appendDebug({ type: "review.completed", resultCode: "changes_requested", prompt: "secret", report: "body", statePatch: { status: "failed" } } as never);
	const raw = await readFile(store.eventsPath, "utf8");
	assert.doesNotMatch(raw, /secret|report|statePatch|body/);
});

test("ledger upsert keeps all entries, moves same-id replacements newest, and supports explicit prune", async (t) => {
	const { store } = await fixture(t);
	for (let index = 0; index < 40; index++) await store.upsertLedger({ id: `entry-${index}`, updatedAt: "2026-01-01T00:00:00Z", sourceRole: "implementer", summary: `summary-${index}` });
	await store.upsertLedger({ id: "entry-0", updatedAt: "2026-01-01T00:00:02Z", sourceRole: "implementer", summary: "new zero", evidence: Array.from({ length: 20 }, (_, index) => `evidence/${index}`) });
	const entries = (await store.readLedger()).entries;
	assert.equal(entries.length, 40);
	assert.deepEqual(entries.at(-1), { id: "entry-0", updatedAt: "2026-01-01T00:00:02Z", sourceRole: "implementer", summary: "new zero", evidence: Array.from({ length: 20 }, (_, index) => `evidence/${index}`) });
	assert.equal((await store.pruneLedger(["entry-0"])).entries.length, 39);
});

test("ledger rejects undeclared compatibility fields and malformed entries", async (t) => {
	const { store } = await fixture(t);
	await mkdir(store.storyRoot, { recursive: true });
	await writeFile(store.ledgerPath, "schemaVersion: 1\nentries:\n  - id: finding\n    updatedAt: 2026-01-01T00:00:00Z\n    sourceRole: reviewer\n    summary: bounded\n    report: legacy.md\n");
	await assert.rejects(store.readLedger(), /unsupported fields/);
	await writeFile(store.ledgerPath, "schemaVersion: 1\nentries:\n  - id: 42\n    updatedAt: nope\n    sourceRole: reviewer\n    summary: bounded\n");
	await assert.rejects(store.readLedger(), /non-empty id|timestamp/);
});

test("exclusive clock transitions partition workflow time without summing concurrent roles", () => {
	let metrics = transitionWorkflowClock(emptyWorkflowMetrics(), "implementation", "2026-01-01T00:00:00.000Z");
	metrics = transitionWorkflowClock(metrics, "integration", "2026-01-01T00:00:10.000Z");
	metrics = transitionWorkflowClock(metrics, "review", "2026-01-01T00:00:13.000Z");
	metrics = transitionWorkflowClock(metrics, undefined, "2026-01-01T00:00:18.000Z");
	assert.equal(metrics.workflowMs, 18_000);
	assert.deepEqual(metrics.categories, { implementation: 10_000, integration: 3_000, verification: 0, review: 5_000, e2e: 0, repair: 0 });
	assert.equal(Object.values(metrics.categories).reduce((sum, value) => sum + value, 0), metrics.workflowMs);
	assert.equal(metrics.open, undefined);
});

test("exclusive clock attributes elapsed categories to their owning stages", () => {
	let metrics = transitionWorkflowClock(emptyWorkflowMetrics(), "implementation", "2026-01-01T00:00:00.000Z", "foundation");
	metrics = transitionWorkflowClock(metrics, "verification", "2026-01-01T00:00:10.000Z", "foundation");
	metrics = transitionWorkflowClock(metrics, "implementation", "2026-01-01T00:00:13.000Z", "interface");
	metrics = transitionWorkflowClock(metrics, undefined, "2026-01-01T00:00:18.000Z");
	assert.deepEqual(metrics.stageBreakdown?.foundation, {
		workflowMs: 13_000,
		categories: { implementation: 10_000, integration: 0, verification: 3_000, review: 0, e2e: 0, repair: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	});
	assert.deepEqual(metrics.stageBreakdown?.interface, {
		workflowMs: 5_000,
		categories: { implementation: 5_000, integration: 0, verification: 0, review: 0, e2e: 0, repair: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	});
});

test("owner-loss recovery marks but does not count an incomplete open interval", () => {
	const open = transitionWorkflowClock(emptyWorkflowMetrics(), "verification", "2026-01-01T00:00:00.000Z", "foundation");
	const recovered = markWorkflowClockIncomplete(open);
	assert.equal(recovered.workflowMs, 0);
	assert.equal(recovered.categories.verification, 0);
	assert.equal(recovered.incompleteIntervals, 1);
	assert.deepEqual(recovered.incompleteCategories, ["verification"]);
	assert.deepEqual(recovered.stageBreakdown?.foundation, {
		workflowMs: 0,
		categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0, repair: 0 },
		incompleteIntervals: 1,
		incompleteCategories: ["verification"],
	});
	assert.equal(recovered.open, undefined);
});
