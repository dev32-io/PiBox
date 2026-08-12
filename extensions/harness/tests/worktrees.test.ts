import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { discoverRepository } from "../repository.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";
import { ResourceLockSet, WorktreeManager } from "../worktrees.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

async function fixture(t: test.TestContext) {
	const parent = await mkdtemp(join(tmpdir(), "pibox-integration-"));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n");
	await git(root, "add", "README.md", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "initial");
	return { parent, root, identity: await discoverRepository(root, join(parent, "home")) };
}

function task(): TaskManifest {
	return {
		schemaVersion: 1,
		id: "add-feature",
		title: "Add feature",
		status: "ready",
		dependsOn: [],
		references: { specs: [], designs: [], decisions: [] },
		execution: {
			isolation: "worktree",
			parallelism: "allowed",
			resourceClaims: ["feature-files"],
			complexity: "medium",
			assignment: { role: "implementer", model: "terra", effort: "high", minimumCapabilityRank: 100, allowFallback: true, rationale: "fixture" },
		},
		assembly: { integrationUnit: "feature-unit", intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: ["test"], taskChecks: ["test -f feature.txt"], rationale: "assembled check" },
	};
}

test("allocates isolated work and atomically integrates a meaningful unit", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "feature", title: "Feature", kind: "story", intent: "Add a feature" });
	await store.defineTask({ workItemId: "feature", manifest: task(), brief: "Add feature.txt", acceptance: "feature.txt exists" });
	const evaluation: EvaluationManifest = {
		schemaVersion: 1,
		id: "feature-check",
		type: "deterministic",
		scope: { integrationUnit: "feature-unit" },
		status: "planned",
		required: true,
		attempt: 0,
		methods: ["test -f feature.txt"],
	};
	await store.defineEvaluation("feature", evaluation);
	await store.submitPlanning("feature");
	await store.approve("feature");
	const manager = new WorktreeManager(identity);
	const allocation = await manager.allocate("feature", await store.readTask("feature", "add-feature"));
	assert.equal(allocation.path, join(identity.root, ".worktree", "pibox", "feature", "add-feature"));
	await store.updateTask("feature", "add-feature", { status: "running", runtime: { branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	await writeFile(join(allocation.path, "feature.txt"), "implemented\n");
	await git(allocation.path, "add", "feature.txt");
	await git(allocation.path, "commit", "--quiet", "-m", "implement feature");
	const completedCommit = await git(allocation.path, "rev-parse", "HEAD");
	await store.updateTask("feature", "add-feature", {
		status: "contribution_complete",
		runtime: { branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit, completedCommit },
	});
	const integrated = await manager.integrateUnit("feature", "feature-unit");
	assert.equal(await readFile(join(root, "feature.txt"), "utf8"), "implemented\n");
	assert.equal((await store.readTask("feature", "add-feature")).status, "integrated");
	assert.match(await git(root, "show", "-s", "--format=%B", integrated.commit), /Harness-Integration-Unit: feature-unit/);
	await store.recordEvaluation({
		workItemId: "feature",
		evaluationId: "feature-check",
		verdict: "pass",
		report: "# Result\n\nThe integrated feature exists.",
		evidence: [{ command: "test -f feature.txt", result: "passed", path: "feature.txt" }],
		findings: [{ id: "QUALITY-001", severity: "low", status: "accepted", summary: "Optional polish remains", blocking: false }],
	});
	const completed = await store.completeWorkItem("feature", "# Outcome\n\nDelivered the feature with deterministic evidence.");
	assert.equal(completed.phase, "complete");
	assert.equal(completed.state, "complete");
	assert.match(await readFile(join(root, "agent-artifacts", "feature", "outcome.md"), "utf8"), /QUALITY-001/);
	assert.match(await readFile(join(root, "agent-artifacts", "feature", "evidence", "feature-check", "manifest.yaml"), "utf8"), /checksum: sha256:/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("resumes a dirty worktree recorded for the same task assignment", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "resume", title: "Resume", kind: "change", intent: "Resume retained work" });
	const manifest = task();
	await store.defineTask({ workItemId: "resume", manifest, brief: "Create a file", acceptance: "File exists" });
	await store.submitPlanning("resume");
	await store.approve("resume");
	const manager = new WorktreeManager(identity);
	const allocation = await manager.allocate("resume", await store.readTask("resume", manifest.id));
	await store.updateTask("resume", manifest.id, { status: "running", runtime: { branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	await writeFile(join(allocation.path, "partial.txt"), "retained\n");
	await store.updateTask("resume", manifest.id, { status: "cancelled" });
	await store.updateTask("resume", manifest.id, { status: "ready" });
	const resumed = await manager.allocate("resume", await store.readTask("resume", manifest.id));
	assert.equal(resumed.path, allocation.path);
	assert.equal(await readFile(join(resumed.path, "partial.txt"), "utf8"), "retained\n");
});

test("refuses allocation when the repository-local worktree root is not ignored", async (t) => {
	const { root, identity } = await fixture(t);
	await writeFile(join(root, ".gitignore"), "");
	await git(root, "add", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "remove ignore");
	const store = new WorkItemStore(root);
	await store.create({ id: "unignored", title: "Unignored", kind: "change", intent: "Test ignore enforcement" });
	const manifest = task();
	await store.defineTask({ workItemId: "unignored", manifest, brief: "Create a file", acceptance: "File exists" });
	await store.submitPlanning("unignored");
	await store.approve("unignored");
	await assert.rejects(
		new WorktreeManager(identity).allocate("unignored", await store.readTask("unignored", manifest.id)),
		(error: unknown) => error instanceof Error && /\/\.worktree\//.test(error.message),
	);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("resource claims fail closed while held and can be reacquired after release", async (t) => {
	const { identity } = await fixture(t);
	const first = new ResourceLockSet(identity.privateRoot);
	const second = new ResourceLockSet(identity.privateRoot);
	await first.acquire(["shared-schema", "index.html"], "first");
	await assert.rejects(second.acquire(["index.html"], "second"));
	await first.release();
	await second.acquire(["shared-schema"], "second");
	await second.release();
});
