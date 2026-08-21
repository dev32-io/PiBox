import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../errors.js";
import { HarnessRunStore } from "../run-store.js";

test("authorizes immutable run scope with an unguessable credential", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
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
	await assert.rejects(access(join(store.runRoot(created.record.id), "transcript.jsonl")), /ENOENT/, "Pi session and structured handoff replace the duplicate run transcript");
	await assert.rejects(access(join(store.runRoot(created.record.id), "events.jsonl")), /ENOENT/, "run events are consolidated into the repository stream");
	const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
	assert.deepEqual(events.filter((event) => event.data?.runId === created.record.id).map((event) => event.type), ["run.created", "run.started"]);
});
