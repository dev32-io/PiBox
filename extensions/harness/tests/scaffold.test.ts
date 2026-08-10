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
	assert.equal(loaded.config.models.sol?.model, "gpt-5.6-luna");
	assert.equal(loaded.config.models.sol?.capabilityRank, 100);
	assert.deepEqual(loaded.config.roles.implementer?.models, [{ model: "luna", effort: "medium" }]);
	assert.deepEqual(loaded.config.roles["quality-reviewer"]?.models, [{ model: "luna", effort: "low" }]);
	assert.match(await readFile(join(root, ".pi", "harness.yaml"), "utf8"), /Scaffold profile: economy/);
	assert.equal((await scaffoldHarness(root, "standard")).created, false);
});

test("refuses to initialize over unrelated dirty work", async (t) => {
	const root = await emptyRepository(t);
	await writeFile(join(root, "unrelated.txt"), "dirty\n");
	await assert.rejects(scaffoldHarness(root, "economy"), (error: unknown) => error instanceof HarnessError && error.code === "DIRTY_CANONICAL_BRANCH");
});
