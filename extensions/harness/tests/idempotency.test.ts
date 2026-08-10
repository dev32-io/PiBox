import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../errors.js";
import { IdempotencyStore, RepositoryMutex } from "../idempotency.js";

test("replays identical operations and rejects operation-id payload conflicts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-operations-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new IdempotencyStore(root);
	let calls = 0;
	const operationId = "call_xTpctS5CUCnFQUllaf0dJht9|fc_073ea487a273b16b";
	const first = await store.execute(operationId, { value: 1 }, async () => ({ receipt: ++calls }));
	const replay = await store.execute(operationId, { value: 1 }, async () => ({ receipt: ++calls }));
	assert.deepEqual(first, { receipt: 1 });
	assert.deepEqual(replay, first);
	assert.equal(calls, 1);
	await assert.rejects(
		store.execute(operationId, { value: 2 }, async () => ({ receipt: 3 })),
		(error: unknown) => error instanceof HarnessError && error.code === "CAPABILITY_DENIED",
	);
});

test("serializes canonical mutations and only recovers locks owned by dead processes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-mutex-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const mutex = new RepositoryMutex(root);
	const competingProcess = new RepositoryMutex(root);
	let release!: () => void;
	const held = mutex.run("first", () => new Promise<void>((resolve) => (release = resolve)));
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(competingProcess.run("second", async () => undefined), (error: unknown) => error instanceof HarnessError && error.code === "RESOURCE_LOCKED");
	assert.equal(await mutex.recoverStale(), false);
	release();
	await held;

	await mkdir(mutex.path, { recursive: true });
	await writeFile(join(mutex.path, "owner"), JSON.stringify({ pid: 99999999 }));
	assert.equal(await mutex.recoverStale(), true);
});
