import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadHarnessConfig } from "../config.js";
import { HarnessError } from "../errors.js";
import { initializeHarnessRepository, scaffoldHarness } from "../scaffold.js";

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

test("bootstraps an empty directory as a develop repository without staging outside files", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-bootstrap-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previous = {
		authorName: process.env.GIT_AUTHOR_NAME,
		authorEmail: process.env.GIT_AUTHOR_EMAIL,
		committerName: process.env.GIT_COMMITTER_NAME,
		committerEmail: process.env.GIT_COMMITTER_EMAIL,
	};
	Object.assign(process.env, {
		GIT_AUTHOR_NAME: "Harness Test",
		GIT_AUTHOR_EMAIL: "harness@example.test",
		GIT_COMMITTER_NAME: "Harness Test",
		GIT_COMMITTER_EMAIL: "harness@example.test",
	});
	try {
		const result = await initializeHarnessRepository(root, "standard");
		assert.equal(result.gitInitialized, true);
		assert.equal(result.developCreated, true);
		assert.equal(await git(root, "branch", "--show-current"), "develop");
		assert.equal(await git(root, "status", "--porcelain"), "");
		assert.match(await readFile(join(root, ".pi", "harness.yaml"), "utf8"), /modelTiers:/);
	} finally {
		for (const [key, value] of Object.entries({
			GIT_AUTHOR_NAME: previous.authorName,
			GIT_AUTHOR_EMAIL: previous.authorEmail,
			GIT_COMMITTER_NAME: previous.committerName,
			GIT_COMMITTER_EMAIL: previous.committerEmail,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("refuses to wrap existing non-Git project files in an implicit baseline", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-bootstrap-existing-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, ".env"), "SECRET=value\n");
	await assert.rejects(initializeHarnessRepository(root, "standard"), (error: unknown) => error instanceof HarnessError && error.code === "DIRTY_CANONICAL_BRANCH");
	await assert.rejects(access(join(root, ".git")));
});

test("creates and checks out develop in an existing clean repository", async (t) => {
	const root = await emptyRepository(t);
	await writeFile(join(root, "README.md"), "fixture\n");
	await git(root, "add", "README.md");
	await git(root, "commit", "--quiet", "-m", "initial baseline");
	const result = await initializeHarnessRepository(root, "standard");
	assert.equal(result.gitInitialized, false);
	assert.equal(result.developCreated, true);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("initializes an empty Git repository with a committed economy policy", async (t) => {
	const root = await emptyRepository(t);
	const result = await scaffoldHarness(root, "economy");
	assert.equal(result.created, true);
	assert.equal(await git(root, "log", "-1", "--pretty=%s"), "chore(harness): initialize economy policy");
	assert.equal(await git(root, "status", "--porcelain"), "");
	const loaded = loadHarnessConfig(root, { home: join(root, "unused-home") });
	assert.equal(loaded.config.schemaVersion, 2);
	assert.deepEqual(loaded.config.modelTiers, {
		max: ["openai-codex/gpt-5.6-sol#high", "ollama-cloud/deepseek-v4-pro#max"],
		high: ["openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-pro#high"],
		medium: ["openai-codex/gpt-5.6-luna#max", "ollama-cloud/deepseek-v4-flash#max"],
		low: ["openai-codex/gpt-5.6-luna#low", "ollama-cloud/deepseek-v4-flash#low"],
		local: ["local-llm/meta/muse-glimmer#high"],
	});
	assert.equal(loaded.config.agents.implementer?.tier, "medium");
	assert.equal(loaded.config.agents["code-reviewer"]?.tier, "medium");
	assert.equal(loaded.config.limits.repairRounds, 8, "economy changes concurrency, not the bounded review/fix opportunity count");
	const policy = await readFile(join(root, ".pi", "harness.yaml"), "utf8");
	assert.match(policy, /Scaffold profile: economy/);
	assert.doesNotMatch(policy, /\nroles:\n/);
	assert.doesNotMatch(policy, /^\s+tools:/m, "repository harness policy must not duplicate agent frontmatter tools");
	assert.equal(await readFile(join(root, ".gitignore"), "utf8"), "/.worktree/\n/.pibox/\n");
	assert.equal(await git(root, "check-ignore", "--no-index", ".worktree/pibox/probe"), ".worktree/pibox/probe");
	assert.equal(await git(root, "check-ignore", "--no-index", ".pibox/probe"), ".pibox/probe");
	assert.equal((await scaffoldHarness(root, "standard")).created, false);
});

test("prepares the worktree ignore for an existing harness policy", async (t) => {
	const root = await emptyRepository(t);
	await writeFile(join(root, ".gitignore"), "dist/\n");
	await mkdir(join(root, ".pi"), { recursive: true });
	await writeFile(join(root, ".pi", "harness.yaml"), "schemaVersion: 2\n");
	await git(root, "add", ".gitignore", ".pi/harness.yaml");
	await git(root, "commit", "--quiet", "-m", "existing policy");
	await mkdir(join(root, ".pibox"), { recursive: true });
	await writeFile(join(root, ".pibox", "repository.yaml"), "schemaVersion: 1\n");
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
