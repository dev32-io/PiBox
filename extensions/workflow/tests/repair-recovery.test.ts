import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { discoverRepository } from "../repository.js";
import { RepairRecoveryStore } from "../repair-recovery.js";

const exec = promisify(execFile);

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-repair-recovery-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "source.txt"), "base\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-qm", "fixture"], { cwd: root });
	return { root, store: new RepairRecoveryStore(await discoverRepository(root)) };
}

test("records an exact dirty fixer workspace and accepts it unchanged", async (t) => {
	const { root, store } = await fixture(t);
	await writeFile(join(root, "source.txt"), "partial repair\n");
	await writeFile(join(root, "new-test.txt"), "partial test\n");
	const record = await store.record({ workItemId: "story", evaluationId: "review", agentId: "fixer", operationId: "repair:1", iteration: 1 });
	assert.equal(record.dirty, true);
	await store.assertCurrent(record);
	assert.equal((await store.read("story", "review"))?.agentId, "fixer");
});

test("rejects source changes after failed-fixer settlement", async (t) => {
	const { root, store } = await fixture(t);
	await writeFile(join(root, "source.txt"), "partial repair\n");
	const record = await store.record({ workItemId: "story", evaluationId: "review", agentId: "fixer", operationId: "repair:1", iteration: 1 });
	await writeFile(join(root, "source.txt"), "externally changed\n");
	await assert.rejects(store.assertCurrent(record), /changed after fixer fixer failed/);
});
