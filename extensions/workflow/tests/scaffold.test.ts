import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadHarnessConfig } from "../config.js";
import { HarnessError } from "../errors.js";
import { scaffoldHarness } from "../scaffold.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function emptyRepository(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-scaffold-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	return root;
}

test("initializes an empty Git repository with a committed economy policy", async (t) => {
	const root = await emptyRepository(t);
	const result = await scaffoldHarness(root, "economy");
	assert.equal(result.created, true);
	assert.equal(await git(root, "log", "-1", "--pretty=%s"), "chore(harness): initialize economy policy");
	assert.equal(await git(root, "status", "--porcelain"), "");
	const loaded = loadHarnessConfig(root, { home: join(root, "unused-home") });
	assert.equal(loaded.config.schemaVersion, 2);
	assert.deepEqual(loaded.config.modelTiers, {
		max: ["openai-codex/gpt-5.6-sol#high"],
		high: ["openai-codex/gpt-5.6-sol#medium"],
		medium: ["openai-codex/gpt-5.6-luna#max"],
		low: ["openai-codex/gpt-5.6-luna#medium"],
	});
	assert.equal(loaded.config.agents.implementer?.tier, "medium");
	assert.equal(loaded.config.agents["code-reviewer"]?.tier, "high");
	const policy = await readFile(join(root, ".pi", "harness.yaml"), "utf8");
	assert.match(policy, /Scaffold profile: economy/);
	assert.doesNotMatch(policy, /\nroles:\n/);
	assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "/.worktree/\n/.pibox/\n");
	assert.equal(await git(root, "check-ignore", "--no-index", ".worktree/pibox/probe"), ".worktree/pibox/probe");
	assert.equal(await git(root, "check-ignore", "--no-index", ".pibox/probe"), ".pibox/probe");
	assert.equal((await scaffoldHarness(root, "standard")).created, false);
});

test("prepares the worktree ignore for an existing harness policy", async (t) => {
	const root = await emptyRepository(t);
	await writeFile(join(root, ".gitignore"), "dist/\n");
	await import("node:fs/promises").then(({ mkdir }) => mkdir(join(root, ".pi"), { recursive: true }));
	await writeFile(join(root, ".pi", "harness.yaml"), "schemaVersion: 2\n");
	await git(root, "add", ".gitignore", ".pi/harness.yaml");
	await git(root, "commit", "--quiet", "-m", "existing policy");
	const result = await scaffoldHarness(root, "standard");
	assert.equal(result.created, false);
	assert.equal(result.worktreeIgnoreAdded, true);
	assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "dist/\n/.worktree/\n/.pibox/\n");
	assert.equal(await git(root, "log", "-1", "--pretty=%s"), "chore(harness): ignore repository-local worktrees");
});

test("refuses to initialize over unrelated dirty work", async (t) => {
	const root = await emptyRepository(t);
	await writeFile(join(root, "unrelated.txt"), "dirty\n");
	await assert.rejects(scaffoldHarness(root, "economy"), (error: unknown) => error instanceof HarnessError && error.code === "DIRTY_CANONICAL_BRANCH");
});
