import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
	emptyWorkflowMetrics,
	isCurrentAttempt,
	markWorkflowClockIncomplete,
	StoryRuntimeStore,
	transitionWorkflowClock,
	type ActivationOwner,
	type StoryRuntimeState,
	type TaskRuntimeState,
} from "../story-runtime-store.js";

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
	const corruptions: unknown[] = [
		{ ...valid, status: "teleporting" },
		{ ...valid, steps: [] },
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
		{ ...valid, e2e: { ...valid.e2e, evidenceRefs: [`evidence/${"x".repeat(500)}`] } },
		{ ...valid, metrics: { ...valid.metrics, categories: { ...valid.metrics.categories, review: 1 } } },
		{ ...valid, metrics: { ...valid.metrics, open: { category: "orchestration", since: "2026-01-01T00:00:00.000Z" } } },
		{ ...valid, metrics: { ...valid.metrics, open: { category: "review", since: "not-a-time" } } },
	];
	for (const corruption of corruptions) await assert.rejects(store.writeState(corruption as never), /invalid runtime state/i);
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

test("ledger upsert moves an entry to the newest position and prunes to its bound", async (t) => {
	const { store } = await fixture(t, { maxLedgerEntries: 2 });
	await store.upsertLedger({ id: "a", updatedAt: "2026-01-01T00:00:00Z", sourceRole: "implementer", summary: "old a" });
	await store.upsertLedger({ id: "b", updatedAt: "2026-01-01T00:00:01Z", sourceRole: "reviewer", summary: "b" });
	await store.upsertLedger({ id: "a", updatedAt: "2026-01-01T00:00:02Z", sourceRole: "implementer", summary: "new a" });
	await store.upsertLedger({ id: "c", updatedAt: "2026-01-01T00:00:03Z", sourceRole: "implementer", summary: "c" });
	assert.deepEqual((await store.readLedger()).entries.map((entry) => [entry.id, entry.summary]), [["a", "new a"], ["c", "c"]]);
	assert.deepEqual((await store.pruneLedger(["a"])).entries.map((entry) => entry.id), ["c"]);
});

test("ledger rejects undeclared compatibility fields and malformed entries", async (t) => {
	const { store } = await fixture(t);
	await mkdir(store.storyRoot, { recursive: true });
	await writeFile(store.ledgerPath, "schemaVersion: 1\nentries:\n  - id: finding\n    updatedAt: 2026-01-01T00:00:00Z\n    sourceRole: reviewer\n    summary: bounded\n    report: legacy.md\n");
	await assert.rejects(store.readLedger(), /unsupported fields/);
	await writeFile(store.ledgerPath, "schemaVersion: 1\nentries:\n  - id: 42\n    updatedAt: nope\n    sourceRole: reviewer\n    summary: bounded\n");
	await assert.rejects(store.readLedger(), /bounded id|timestamp/);
});

test("exclusive clock transitions partition workflow time without summing concurrent roles", () => {
	let metrics = transitionWorkflowClock(emptyWorkflowMetrics(), "implementation", "2026-01-01T00:00:00.000Z");
	metrics = transitionWorkflowClock(metrics, "integration", "2026-01-01T00:00:10.000Z");
	metrics = transitionWorkflowClock(metrics, "review", "2026-01-01T00:00:13.000Z");
	metrics = transitionWorkflowClock(metrics, undefined, "2026-01-01T00:00:18.000Z");
	assert.equal(metrics.workflowMs, 18_000);
	assert.deepEqual(metrics.categories, { implementation: 10_000, integration: 3_000, verification: 0, review: 5_000, e2e: 0 });
	assert.equal(Object.values(metrics.categories).reduce((sum, value) => sum + value, 0), metrics.workflowMs);
	assert.equal(metrics.open, undefined);
});

test("owner-loss recovery marks but does not count an incomplete open interval", () => {
	const open = transitionWorkflowClock(emptyWorkflowMetrics(), "verification", "2026-01-01T00:00:00.000Z");
	const recovered = markWorkflowClockIncomplete(open);
	assert.equal(recovered.workflowMs, 0);
	assert.equal(recovered.categories.verification, 0);
	assert.equal(recovered.incompleteIntervals, 1);
	assert.deepEqual(recovered.incompleteCategories, ["verification"]);
	assert.equal(recovered.open, undefined);
});
