import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverRepository, runGit } from "../repository.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await exec("git", args, { cwd });
}

test("Git failures surface stdout when stderr is empty", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-harness-git-error-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await git(root, "add", "README.md");
	await git(root, "commit", "--quiet", "-m", "initial");

	await assert.rejects(runGit(root, ["commit", "-m", "duplicate"]), /nothing to commit/i);
});

test("abortable Git operations terminate a live child and preserve cancellation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-harness-git-abort-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	const controller = new AbortController();
	const startedAt = Date.now();
	setTimeout(() => controller.abort(), 25);
	await assert.rejects(
		runGit(root, ["hash-object", "--stdin"], { signal: controller.signal }),
		(error: unknown) => error instanceof Error && error.name === "AbortError",
	);
	assert.ok(Date.now() - startedAt < 1_000, "cancellation does not wait for the Git child to finish naturally");
});

test("uses one stable repository identity across linked worktrees", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-harness-repo-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "main");
	const worktree = join(parent, "worker");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await git(root, "add", "README.md");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "worktree", "add", "--quiet", "-b", "worker", worktree);

	const mainIdentity = await discoverRepository(root, join(parent, "home"));
	const workerIdentity = await discoverRepository(worktree, join(parent, "home"));
	assert.equal(mainIdentity.id, workerIdentity.id);
	assert.equal(mainIdentity.root, await realpath(root));
	assert.equal(workerIdentity.root, await realpath(root));
	assert.equal(mainIdentity.privateRoot, workerIdentity.privateRoot);
	assert.equal(mainIdentity.privateRoot, join(await realpath(root), ".pibox"));
});
