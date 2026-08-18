import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowControlStore } from "../control-store.js";

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

test("pause and stop advance the fence so late settlements are stale", async (t) => {
	const store = new WorkflowControlStore(await root(t));
	const started = await store.apply({ workflowRef: "work-item:calendar", command: "start", sessionId: "session-a", operationId: "start" });
	await store.assertCurrent("work-item:calendar", "session-a", started.generation);
	const paused = await store.apply({ workflowRef: "work-item:calendar", command: "pause", sessionId: "session-a", operationId: "pause" });
	assert.equal(paused.mode, "paused");
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", started.generation), /Stale workflow ownership/);
	const resumed = await store.apply({ workflowRef: "work-item:calendar", command: "resume", sessionId: "session-a", operationId: "resume" });
	const stopped = await store.apply({ workflowRef: "work-item:calendar", command: "stop", sessionId: "session-a", operationId: "stop" });
	assert.ok(stopped.generation > resumed.generation);
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", resumed.generation), /Stale workflow ownership/);
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
	await assert.rejects(() => store.assertCurrent("work-item:calendar", "session-a", started.generation), /Stale workflow ownership/);
	await store.assertCurrent("work-item:calendar", "session-b", attached.generation);
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
