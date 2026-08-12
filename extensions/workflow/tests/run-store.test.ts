import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../errors.js";
import { HarnessRunStore } from "../run-store.js";

test("authorizes immutable run scope with an unguessable credential", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HarnessRunStore(root, "work-item");
	const created = await store.create({
		repositoryId: "repository",
		workItemId: "work-item",
		taskId: "task-one",
		role: "implementer",
		attempt: 1,
		state: "launching",
		workspace: "/workspace",
		baseCommit: "abc",
	});
	assert.equal((await store.authorize(created.record.id, created.credential)).taskId, "task-one");
	await assert.rejects(
		store.authorize(created.record.id, "wrong"),
		(error: unknown) => error instanceof HarnessError && error.code === "CAPABILITY_DENIED",
	);
	const updated = await store.update(created.record.id, { state: "running", pid: 42 }, "run.started");
	assert.equal(updated.state, "running");
	assert.equal((await store.read(created.record.id)).pid, 42);
	await Promise.all([
		store.appendTranscript(created.record.id, { type: "message_update", delta: "redundant" }),
		store.appendTranscript(created.record.id, { type: "message_end", message: { role: "assistant", content: [] } }),
	]);
	await store.flushTranscript(created.record.id);
	const transcript = await import("node:fs/promises").then(({ readFile }) => readFile(join(store.runRoot(created.record.id), "transcript.jsonl"), "utf8"));
	assert.equal(transcript.trim().split("\n").length, 1);
	assert.match(transcript, /message_end/);
});
