import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverRepository } from "../repository.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
	await exec("git", args, { cwd });
}

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
