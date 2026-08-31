import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowControlStore, workflowControlFence } from "../control-store.js";

async function root(t: test.TestContext): Promise<string> {
	const value = await mkdtemp(join(tmpdir(), "pibox-workflow-control-"));
	t.after(() => rm(value, { recursive: true, force: true }));
	return value;
}

test("migrates a pre-control workflow on its first explicit resume", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const resumed = await store.apply({ workflowRef: "work-item:legacy", command: "resume", sessionId: "session-a", operationId: "legacy-resume" });
	assert.equal(resumed.mode, "running");
	assert.equal(resumed.generation, 1);
	assert.equal(resumed.ownerSessionId, "session-a");
	await store.assertCurrent("work-item:legacy", "session-a", 1);
	const explicitResume = await store.apply({ workflowRef: "work-item:legacy", command: "resume", sessionId: "session-a", operationId: "user-resume" });
	assert.equal(explicitResume.mode, "running");
	assert.equal(explicitResume.generation, 2, "an explicit resume safely refences an already-running restored workflow");
	assert.equal(explicitResume.executionFence, resumed.executionFence, "same-owner resume does not revoke live attempt capabilities");
});

test("serializes ownership across store instances and replays commands idempotently", async (t) => {
	const privateRoot = await root(t);
	const first = new WorkflowControlStore(privateRoot);
	const second = new WorkflowControlStore(privateRoot);
	const started = await first.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start-1" });
	const replay = await second.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start-1" });
	assert.deepEqual(replay, started);
	await assert.rejects(() => second.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-b", operationId: "start-2" }), /already running/);
});

test("explicit resume transfers a crashed workflow to a fresh session generation", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const crashed = await store.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start" });
	const resumed = await store.apply({ workflowRef: "work-item:calendar", command: "resume", sessionId: "session-b", operationId: "fresh-resume" });
	assert.equal(resumed.ownerSessionId, "session-b");
	assert.ok(resumed.generation > crashed.generation);
	assert.ok(resumed.executionFence > crashed.executionFence, "ownership takeover revokes prior attempt capabilities");
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", crashed.generation), /Stale workflow ownership/);
	await store.assertCurrent("work-item:calendar", "session-b", resumed.generation);
});

test("scheduler pause preserves only the active-attempt fence and stop revokes it", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const started = await store.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start" });
	const attemptFence = workflowControlFence(started);
	await store.assertCurrent("work-item:calendar", "session-a", started.generation);
	const paused = await store.apply({ workflowRef: "work-item:calendar", command: "pause", sessionId: "session-a", operationId: "pause" });
	assert.equal(paused.mode, "paused");
	assert.equal(paused.executionFence, started.executionFence, "scheduler pause leaves active attempt capabilities valid");
	await store.assertActiveAttempt(attemptFence, { allowGenerationAdvance: true });
	await assert.rejects(() => store.assertFence(attemptFence, { allowGenerationAdvance: true }), /Stale workflow execution fence/, "bind, launch, and canonical mutation remain running-only");
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", started.generation), /Stale workflow ownership/);
	const stopped = await store.apply({ workflowRef: "work-item:calendar", command: "stop", sessionId: "session-a", operationId: "stop" });
	assert.ok(stopped.generation > paused.generation);
	assert.ok(stopped.executionFence > paused.executionFence, "stop synchronously revokes active attempt capabilities");
	await assert.rejects(() => store.assertActiveAttempt(attemptFence, { allowGenerationAdvance: true }), /Stale workflow execution fence/);
});

test("detach preserves running intent and attach creates a new fenced owner", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const started = await store.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start" });
	const detached = await store.apply({ workflowRef: "work-item:calendar", command: "detach", sessionId: "session-a", operationId: "shutdown" });
	assert.equal(detached.mode, "running");
	assert.equal(detached.ownerSessionId, undefined);
	const attached = await store.apply({ workflowRef: "work-item:calendar", command: "attach", sessionId: "session-b", operationId: "restore" });
	assert.equal(attached.ownerSessionId, "session-b");
	assert.ok(attached.generation > started.generation);
	assert.equal(attached.executionFence, started.executionFence, "same activation reload does not revoke its live attempts");
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", started.generation), /Stale workflow ownership/);
	await store.assertCurrent("work-item:calendar", "session-b", attached.generation);
});

test("only the same live activation may attach; a replacement activation must explicitly resume", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const owner = { sessionId: "session-a", processInstanceId: "process-a", activationId: "activation-a" };
	await store.apply({ workflowRef: "work-item:calendar", command: "start", ...owner, operationId: "start" });
	const detached = await store.apply({ workflowRef: "work-item:calendar", command: "detach", ...owner, operationId: "detach" });
	assert.equal(detached.ownerActivationId, owner.activationId);
	await assert.rejects(
		store.apply({ workflowRef: "work-item:calendar", command: "attach", sessionId: owner.sessionId, processInstanceId: "process-b", activationId: "activation-b", operationId: "unsafe-adoption" }),
		/another runtime activation.*explicit resume/i,
	);
	const resumed = await store.apply({ workflowRef: "work-item:calendar", command: "resume", sessionId: owner.sessionId, processInstanceId: "process-b", activationId: "activation-b", operationId: "explicit-recovery" });
	assert.equal(resumed.ownerActivationId, "activation-b");
	assert.ok(resumed.generation > detached.generation);
});

test("only one session can attach a detached running workflow", async (t) => {
	const privateRoot = await root(t);
	const owner = new WorkflowControlStore(privateRoot);
	await owner.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start" });
	await owner.apply({ workflowRef: "work-item:calendar", command: "detach", sessionId: "session-a", operationId: "detach" });
	const attempts = await Promise.allSettled([
		new WorkflowControlStore(privateRoot).apply({ workflowRef: "work-item:calendar", command: "attach", sessionId: "session-b", operationId: "attach-b" }),
		new WorkflowControlStore(privateRoot).apply({ workflowRef: "work-item:calendar", command: "attach", sessionId: "session-c", operationId: "attach-c" }),
	]);
	assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, 1);
	assert.equal(attempts.filter((attempt) => attempt.status === "rejected").length, 1);
});
