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

async function fixture(t: test.TestContext, options: { remote?: boolean } = {}) {
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
	await git(root, "branch", "-M", "develop");
	if (options.remote !== false) {
		const remote = join(parent, "remote.git");
		await git(parent, "init", "--bare", "--quiet", remote);
		await git(root, "remote", "add", "origin", remote);
		await git(root, "push", "--quiet", "-u", "origin", "develop");
	}
	return { parent, root, identity: await discoverRepository(root, join(parent, "home")) };
}

function task(id = "add-feature", stageId = "feature-unit", claim = `${id}-files`): TaskManifest {
	return {
		schemaVersion: 1,
		id,
		title: id,
		status: "ready",
		dependsOn: [],
		references: { specs: [], designs: [], decisions: [] },
		execution: {
			resourceClaims: [claim],
			assignment: { role: "implementer", tier: "medium", deliberation: "standard", rationale: "fixture" },
		},
		assembly: { stageId, intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: ["test"], taskChecks: [`test -f ${id}.txt`], rationale: "assembled check" },
	};
}

async function addParallelSibling(store: WorkItemStore, workItemId: string, stageId: string): Promise<void> {
	await store.defineTask({ workItemId, manifest: task("sibling", stageId), brief: "Sibling contribution", acceptance: "Sibling accepted" });
}

test("derives parallel worktrees and merges the stage through one atomic barrier", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "feature", title: "Feature", kind: "story", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Add a feature" });
	await store.defineTask({ workItemId: "feature", manifest: task(), brief: "Add add-feature.txt", acceptance: "Feature exists" });
	await addParallelSibling(store, "feature", "feature-unit");
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "feature-check", type: "deterministic", scope: { workItem: "feature" }, status: "planned", required: true, attempt: 0, methods: ["files exist"] };
	await store.defineEvaluation("feature", evaluation);
	await store.submitPlanning("feature");
	const manager = new WorktreeManager(identity);
	await manager.prepareFeatureBranch("feature");
	assert.equal((await store.read("feature")).planning.revision > 0, true, "workflow start needs no approval status");
	const allocations = [];
	for (const id of ["add-feature", "sibling"]) {
		const allocation = await manager.allocate("feature", await store.readTask("feature", id));
		allocations.push(allocation);
		assert.equal(allocation.isolation, "worktree");
		assert.equal(allocation.path, join(identity.root, ".worktree", "pibox", "feature", id));
		await store.updateTask("feature", id, { status: "running", runtime: { executionMode: allocation.isolation, branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
		await writeFile(join(allocation.path, `${id}.txt`), `${id}\n`);
		await git(allocation.path, "add", `${id}.txt`);
		await git(allocation.path, "commit", "--quiet", "-m", `implement ${id}`);
		await store.updateTask("feature", id, { status: "contribution_complete", runtime: { completedCommit: await git(allocation.path, "rev-parse", "HEAD") } });
	}
	assert.equal(allocations[0]!.baseCommit, allocations[1]!.baseCommit, "parallel tasks share one stage base");
	const integrated = await manager.mergeTask("feature", "add-feature");
	assert.deepEqual(integrated.taskIds, ["add-feature", "sibling"]);
	assert.equal(await readFile(join(root, "add-feature.txt"), "utf8"), "add-feature\n");
	assert.equal(await readFile(join(root, "sibling.txt"), "utf8"), "sibling\n");
	assert.equal((await store.readTask("feature", "add-feature")).status, "merged");
	assert.equal((await store.readTask("feature", "sibling")).status, "merged");
	assert.equal(await git(root, "branch", "--show-current"), "feature/feature");
	await store.recordEvaluation({ workItemId: "feature", evaluationId: "feature-check", verdict: "pass", report: "# Result\n\nBoth files exist.", evidence: [{ result: "passed", description: "stage files" }], findings: [{ id: "QUALITY-001", severity: "low", status: "accepted", summary: "Optional polish remains", blocking: false }] });
	const completed = await store.completeWorkItem("feature", "# Outcome\n\nDelivered the feature with deterministic evidence.");
	assert.equal(completed.phase, "complete");
	assert.match(await readFile(join(root, "agent-artifacts", "feature", "outcome.md"), "utf8"), /QUALITY-001/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("derives singleton stages as direct feature-branch execution", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "serial", title: "Serial", kind: "change", delivery: { branchType: "fix", branchMode: "create", baseBranch: "develop" }, intent: "Run serially" });
	await store.defineTask({ workItemId: "serial", manifest: task(), brief: "Direct work", acceptance: "Direct accepted" });
	await store.submitPlanning("serial");
	const manager = new WorktreeManager(identity); await manager.prepareFeatureBranch("serial");
	const allocation = await manager.allocate("serial", await store.readTask("serial", "add-feature"));
	assert.equal(allocation.path, identity.root); assert.equal(allocation.isolation, "repository"); assert.equal(allocation.branch, "fix/serial");
});

test("starts a new delivery from local develop when no origin is configured", async (t) => {
	const { root, identity } = await fixture(t, { remote: false });
	const store = new WorkItemStore(root);
	await store.create({ id: "local-only", title: "Local only", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Support a repository without a remote" });
	await store.submitPlanning("local-only");
	const prepared = await new WorktreeManager(identity).prepareFeatureBranch("local-only");
	assert.deepEqual(prepared, { baseBranch: "develop", featureBranch: "feature/local-only", created: true });
	assert.equal(await git(root, "branch", "--show-current"), "feature/local-only");
});

test("still rejects an inaccessible configured origin", async (t) => {
	const { parent, root, identity } = await fixture(t, { remote: false });
	await git(root, "remote", "add", "origin", join(parent, "missing.git"));
	const store = new WorkItemStore(root);
	await store.create({ id: "broken-origin", title: "Broken origin", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Fail closed when configured synchronization fails" });
	await store.submitPlanning("broken-origin");
	await assert.rejects(new WorktreeManager(identity).prepareFeatureBranch("broken-origin"), /does not appear to be a git repository|Could not read from remote repository/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
});

test("resumes a created delivery on its recorded feature branch", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "created-resume", title: "Created resume", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Resume an already started delivery" });
	await store.submitPlanning("created-resume");
	const manager = new WorktreeManager(identity);
	assert.equal((await manager.prepareFeatureBranch("created-resume")).created, true);
	assert.deepEqual(await manager.prepareFeatureBranch("created-resume"), { baseBranch: "develop", featureBranch: "feature/created-resume", created: false });
});

test("recovers a created delivery after reload while develop is checked out", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "reload-resume", title: "Reload resume", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Recover the recorded branch after reload" });
	await store.submitPlanning("reload-resume");
	const manager = new WorktreeManager(identity);
	await manager.prepareFeatureBranch("reload-resume");
	await git(root, "switch", "develop");
	assert.deepEqual(await manager.prepareFeatureBranch("reload-resume"), { baseBranch: "develop", featureBranch: "feature/reload-resume", created: false });
	assert.equal(await git(root, "branch", "--show-current"), "feature/reload-resume");
});

test("does not adopt an unrelated colliding feature branch", async (t) => {
	const { root, identity } = await fixture(t);
	await git(root, "branch", "feature/collision");
	const store = new WorkItemStore(root);
	await store.create({ id: "collision", title: "Collision", kind: "change", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Reject unrelated branch collisions" });
	await store.submitPlanning("collision");
	await assert.rejects(new WorktreeManager(identity).prepareFeatureBranch("collision"), /already exists/);
});

test("continues an explicitly recorded current feature branch without syncing develop", async (t) => {
	const { root, identity } = await fixture(t);
	await git(root, "switch", "-c", "feature/large-refactor");
	const store = new WorkItemStore(root);
	await store.create({ id: "follow-up", title: "Follow-up", kind: "change", delivery: { branchType: "feature", branchMode: "continue", baseBranch: "develop", featureBranch: "feature/large-refactor" }, intent: "Continue the larger refactor" });
	await store.submitPlanning("follow-up");
	const prepared = await new WorktreeManager(identity).prepareFeatureBranch("follow-up");
	assert.deepEqual(prepared, { baseBranch: "develop", featureBranch: "feature/large-refactor", created: false });
	assert.equal(await git(root, "branch", "--show-current"), "feature/large-refactor");
});

test("new delivery refuses to leave another branch implicitly", async (t) => {
	const { root, identity } = await fixture(t);
	await git(root, "switch", "-c", "feature/existing-work");
	const store = new WorkItemStore(root);
	await store.create({ id: "separate", title: "Separate", kind: "story", delivery: { branchType: "feature", branchMode: "create", baseBranch: "develop" }, intent: "Create separate work" });
	await store.submitPlanning("separate");
	await assert.rejects(new WorktreeManager(identity).prepareFeatureBranch("separate"), /must start from develop.*feature\/existing-work/);
});

test("resumes a dirty worktree recorded for the same task assignment", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "resume", title: "Resume", kind: "change", delivery: { branchType: "fix", branchMode: "create", baseBranch: "develop" }, intent: "Resume retained work" });
	const manifest = task();
	await store.defineTask({ workItemId: "resume", manifest, brief: "Create a file", acceptance: "File exists" });
	await addParallelSibling(store, "resume", "feature-unit");
	await store.submitPlanning("resume");
	const manager = new WorktreeManager(identity);
	await manager.prepareFeatureBranch("resume");
	const allocation = await manager.allocate("resume", await store.readTask("resume", manifest.id));
	await store.updateTask("resume", manifest.id, { status: "running", runtime: { branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	await writeFile(join(allocation.path, "partial.txt"), "retained\n");
	await store.updateTask("resume", manifest.id, { status: "cancelled" });
	await store.updateTask("resume", manifest.id, { status: "ready" });
	const resumed = await manager.allocate("resume", await store.readTask("resume", manifest.id));
	assert.equal(resumed.path, allocation.path);
	assert.equal(await readFile(join(resumed.path, "partial.txt"), "utf8"), "retained\n");
});

test("lists and safely cleans only inactive clean PiBox worktrees", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "cleanup", title: "Cleanup", kind: "change", delivery: { branchType: "fix", branchMode: "create", baseBranch: "develop" }, intent: "Test retained worktree cleanup" });
	const manifest = task();
	await store.defineTask({ workItemId: "cleanup", manifest, brief: "No-op", acceptance: "No-op" });
	await addParallelSibling(store, "cleanup", "feature-unit");
	await store.submitPlanning("cleanup");
	const manager = new WorktreeManager(identity);
	await manager.prepareFeatureBranch("cleanup");
	const allocation = await manager.allocate("cleanup", await store.readTask("cleanup", manifest.id));
	await store.updateTask("cleanup", manifest.id, { status: "running", runtime: { branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	assert.deepEqual((await manager.listManaged()).map(({ name, status, active }) => ({ name, status, active })), [{ name: "cleanup/add-feature", status: "clean", active: true }]);
	assert.equal((await manager.cleanupManaged()).length, 0);
	await store.updateTask("cleanup", manifest.id, { status: "cancelled" });
	assert.equal((await manager.cleanupManaged()).length, 1);
	assert.equal((await manager.listManaged()).length, 0);
});

test("refuses allocation when the repository-local worktree root is not ignored", async (t) => {
	const { root, identity } = await fixture(t);
	await writeFile(join(root, ".gitignore"), "");
	await git(root, "add", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "remove ignore");
	const store = new WorkItemStore(root);
	await store.create({ id: "unignored", title: "Unignored", kind: "change", delivery: { branchType: "fix", branchMode: "create", baseBranch: "develop" }, intent: "Test ignore enforcement" });
	const manifest = task();
	await store.defineTask({ workItemId: "unignored", manifest, brief: "Create a file", acceptance: "File exists" });
	await addParallelSibling(store, "unignored", "feature-unit");
	await store.submitPlanning("unignored");
	const manager = new WorktreeManager(identity);
	await manager.prepareFeatureBranch("unignored");
	await assert.rejects(
		manager.allocate("unignored", await store.readTask("unignored", manifest.id)),
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
