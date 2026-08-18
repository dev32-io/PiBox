import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
			assignment: { agent: "implementer", tier: "medium", rationale: "fixture" },
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
	await store.create({ id: "feature", title: "Feature", kind: "story", branchKind: "feature", intent: "Add a feature" });
	await store.defineTask({ workItemId: "feature", manifest: task(), brief: "Add add-feature.txt", acceptance: "Feature exists" });
	await addParallelSibling(store, "feature", "feature-unit");
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "feature-check", type: "deterministic", scope: { workItem: "feature" }, status: "planned", required: true, attempt: 0, methods: ["files exist"] };
	await store.defineEvaluation("feature", evaluation);
	await store.submitPlanning("feature");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("feature");
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
	assert.deepEqual(integrated.taskIds, ["add-feature", "sibling"], "one listed-order merge barrier integrates the whole legacy concurrent stage");
	assert.deepEqual(integrated.checks.map(({ command }) => command), ["test -f add-feature.txt", "test -f sibling.txt"], "stage checks remain part of the barrier");
	assert.equal(await readFile(join(root, "add-feature.txt"), "utf8"), "add-feature\n");
	assert.equal(await readFile(join(root, "sibling.txt"), "utf8"), "sibling\n");
	assert.equal((await store.readTask("feature", "add-feature")).status, "merged");
	assert.equal((await store.readTask("feature", "sibling")).status, "merged");
	await assert.rejects(git(root, "show-ref", "--verify", "refs/pibox/stages/feature/feature-unit"), "concurrent stage base ref is cleaned after the barrier");
	assert.equal(await git(root, "branch", "--show-current"), "feature/feature");
	await store.recordEvaluation({ workItemId: "feature", evaluationId: "feature-check", verdict: "pass", report: "# Result\n\nBoth files exist.", evidence: [{ result: "passed", description: "stage files" }], findings: [{ id: "QUALITY-001", severity: "low", status: "accepted", summary: "Optional polish remains", blocking: false }] });
	const completed = await store.completeWorkItem("feature", "# Outcome\n\nDelivered the feature with deterministic evidence.");
	assert.equal(completed.phase, "complete");
	assert.match(await readFile(join(root, "agent-artifacts", "feature", "outcome.md"), "utf8"), /QUALITY-001/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("direct mergeTask and concurrent canonical metadata mutation share one coordinator", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "serialized", title: "Serialized", kind: "change", branchKind: "feature", intent: "serialize" });
	await store.defineTask({ workItemId: "serialized", manifest: task("merge-me", "delivery"), brief: "Merge contribution", acceptance: "merged" });
	await store.defineEvaluation("serialized", { schemaVersion: 1, id: "review", type: "deterministic", scope: { workItem: "serialized" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	await store.submitPlanning("serialized");
	const manager = new WorktreeManager(identity); await manager.validateWorkingBranch("serialized");
	const allocation = await manager.allocate("serialized", await store.readTask("serialized", "merge-me"));
	await store.updateTask("serialized", "merge-me", { status: "running", runtime: { executionMode: allocation.isolation, branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
	await writeFile(join(allocation.path, "merge-me.txt"), "merged\n"); await git(allocation.path, "add", "merge-me.txt"); await git(allocation.path, "commit", "--quiet", "-m", "implement merge-me");
	await store.updateTask("serialized", "merge-me", { status: "contribution_complete", runtime: { completedCommit: await git(allocation.path, "rev-parse", "HEAD") } });
	await Promise.all([
		manager.mergeTask("serialized", "merge-me"),
		store.recordEvaluation({ workItemId: "serialized", evaluationId: "review", verdict: "pass", report: "clean", evidence: [], findings: [] }),
	]);
	assert.equal(await git(root, "status", "--porcelain"), "");
	assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
	await assert.rejects(access(join(root, ".git", "index.lock")), /ENOENT/);
	await assert.rejects(git(root, "show-ref", "--verify", "refs/pibox/does-not-exist"));
});

test("surfaces post-merge settlement failure without silently dropping the stage ref", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "settlement-failure", title: "Settlement failure", kind: "change", branchKind: "feature", intent: "settle" });
	await store.defineTask({ workItemId: "settlement-failure", manifest: task("first", "delivery"), brief: "first", acceptance: "first" });
	await addParallelSibling(store, "settlement-failure", "delivery");
	await store.submitPlanning("settlement-failure");
	const manager = new WorktreeManager(identity);
	const allocations = await Promise.all(["first", "sibling"].map(async (id) => manager.allocate("settlement-failure", await store.readTask("settlement-failure", id))));
	for (let i = 0; i < allocations.length; i++) {
		const id = ["first", "sibling"][i]!; const allocation = allocations[i]!;
		await store.updateTask("settlement-failure", id, { status: "running", runtime: { executionMode: allocation.isolation, branch: allocation.branch, worktree: allocation.path, baseCommit: allocation.baseCommit } });
		await writeFile(join(allocation.path, `${id}.txt`), `${id}\n`); await git(allocation.path, "add", `${id}.txt`); await git(allocation.path, "commit", "--quiet", "-m", id);
		await store.updateTask("settlement-failure", id, { status: "contribution_complete", runtime: { completedCommit: await git(allocation.path, "rev-parse", "HEAD") } });
	}
	const failing = manager.workItems as unknown as { refreshReadyTasks: () => Promise<TaskManifest[]> };
	failing.refreshReadyTasks = async () => { throw new Error("refresh settlement failure"); };
	await assert.rejects(manager.mergeTask("settlement-failure", "first"), /managed recovery/);
	assert.equal(await git(root, "status", "--porcelain"), "");
	await git(root, "show-ref", "--verify", "refs/pibox/stages/settlement-failure/delivery");
});

test("explicit concurrent stages allocate independent worktrees from one pinned base", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "explicit", title: "Explicit concurrent", kind: "change", branchKind: "feature", intent: "Run concurrent tasks" });
	await store.defineTask({ workItemId: "explicit", manifest: task("first", "delivery"), brief: "First contribution", acceptance: "First accepted" });
	await store.defineTask({ workItemId: "explicit", manifest: task("second", "delivery"), brief: "Second contribution", acceptance: "Second accepted" });
	await store.putExecutionStage("explicit", { id: "delivery", tasks: ["first", "second"], mode: "concurrent" }, { rationale: "fixture" });
	await store.submitPlanning("explicit");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("explicit");
	const allocations = await Promise.all(["first", "second"].map(async (id) => manager.allocate("explicit", await store.readTask("explicit", id))));
	assert.deepEqual(allocations.map((allocation) => allocation.isolation), ["worktree", "worktree"]);
	assert.notEqual(allocations[0]!.path, allocations[1]!.path);
	assert.equal(allocations[0]!.baseCommit, allocations[1]!.baseCommit, "explicit concurrent tasks share one pinned stage base");
	assert.equal(await git(root, "branch", "--show-current"), "feature/explicit");
});

test("derives singleton stages as direct feature-branch execution", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "serial", title: "Serial", kind: "change", branchKind: "fix", intent: "Run serially" });
	await store.defineTask({ workItemId: "serial", manifest: task(), brief: "Direct work", acceptance: "Direct accepted" });
	await store.submitPlanning("serial");
	const manager = new WorktreeManager(identity); await manager.validateWorkingBranch("serial");
	const allocation = await manager.allocate("serial", await store.readTask("serial", "add-feature"));
	assert.equal(allocation.path, identity.root); assert.equal(allocation.isolation, "repository"); assert.equal(allocation.branch, "fix/serial");
});

test("integrates explicit sequential stage tasks independently on the canonical branch", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "ordered", title: "Ordered", kind: "change", branchKind: "fix", intent: "Run ordered tasks" });
	await store.defineTask({ workItemId: "ordered", manifest: task("first", "ordered-stage"), brief: "First contribution", acceptance: "First exists" });
	await store.defineTask({ workItemId: "ordered", manifest: task("second", "ordered-stage"), brief: "Second contribution", acceptance: "Second exists" });
	await store.defineTask({ workItemId: "ordered", manifest: task("third", "ordered-stage"), brief: "Third contribution", acceptance: "Third exists" });
	await store.putExecutionStage("ordered", { id: "ordered-stage", tasks: ["first", "second", "third"], mode: "sequential", checks: ["test -f third.txt"] }, { rationale: "fixture" });
	await store.submitPlanning("ordered");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("ordered");

	const firstAllocation = await manager.allocate("ordered", await store.readTask("ordered", "first"));
	assert.equal(firstAllocation.path, identity.root);
	assert.equal(firstAllocation.branch, "fix/ordered");
	assert.equal(firstAllocation.isolation, "repository");
	await store.updateTask("ordered", "first", { status: "running", runtime: { executionMode: firstAllocation.isolation, branch: firstAllocation.branch, worktree: firstAllocation.path, baseCommit: firstAllocation.baseCommit } });
	await writeFile(join(root, "first.txt"), "first\n");
	await git(root, "add", "first.txt");
	await git(root, "commit", "--quiet", "-m", "implement first");
	const firstCommit = await git(root, "rev-parse", "HEAD");
	await store.updateTask("ordered", "first", { status: "contribution_complete", runtime: { completedCommit: firstCommit } });
	const firstIntegrated = await manager.mergeTask("ordered", "first");
	assert.deepEqual(firstIntegrated.checks, [], "non-final sequential task does not run stage checks");
	const firstIntegratedCommit = await git(root, "rev-parse", "HEAD");

	const secondAllocation = await manager.allocate("ordered", await store.readTask("ordered", "second"));
	assert.equal(secondAllocation.path, identity.root, "the next sequential task uses the canonical checkout");
	assert.equal(secondAllocation.baseCommit, firstIntegratedCommit, "the next task sees the prior integration");
	await store.updateTask("ordered", "second", { status: "running", runtime: { executionMode: secondAllocation.isolation, branch: secondAllocation.branch, worktree: secondAllocation.path, baseCommit: secondAllocation.baseCommit } });
	assert.equal(await readFile(join(root, "first.txt"), "utf8"), "first\n");
	await writeFile(join(root, "second.txt"), "second\n");
	await git(root, "add", "second.txt");
	await git(root, "commit", "--quiet", "-m", "implement second");
	await store.updateTask("ordered", "second", { status: "contribution_complete", runtime: { completedCommit: await git(root, "rev-parse", "HEAD") } });
	const secondIntegrated = await manager.mergeTask("ordered", "second");
	assert.deepEqual(secondIntegrated.taskIds, ["second"]);
	assert.deepEqual(secondIntegrated.checks, [], "second non-final sequential task does not run stage checks");

	const thirdAllocation = await manager.allocate("ordered", await store.readTask("ordered", "third"));
	assert.equal(thirdAllocation.baseCommit, await git(root, "rev-parse", "HEAD"));
	await store.updateTask("ordered", "third", { status: "running", runtime: { executionMode: thirdAllocation.isolation, branch: thirdAllocation.branch, worktree: thirdAllocation.path, baseCommit: thirdAllocation.baseCommit } });
	await writeFile(join(root, "third.txt"), "third\n");
	await git(root, "add", "third.txt");
	await git(root, "commit", "--quiet", "-m", "implement third");
	await store.updateTask("ordered", "third", { status: "contribution_complete", runtime: { completedCommit: await git(root, "rev-parse", "HEAD") } });
	const integrated = await manager.mergeTask("ordered", "third");
	assert.deepEqual(integrated.taskIds, ["third"]);
	assert.deepEqual(integrated.checks.map(({ command }) => command), ["test -f third.txt"], "final sequential task runs the stage check exactly once");
	assert.equal((await store.readTask("ordered", "first")).status, "merged");
	assert.equal((await store.readTask("ordered", "second")).status, "merged");
	assert.equal((await store.readTask("ordered", "third")).status, "merged");
	await assert.rejects(git(root, "show-ref", "--verify", "refs/pibox/stages/ordered/ordered-stage"));
});

test("creates and validates a working branch before the canonical work-item write", async (t) => {
	const { root, identity } = await fixture(t, { remote: false });
	const store = new WorkItemStore(root);
	const createdFromCommit = await git(root, "rev-parse", "HEAD");
	const item = await store.create({ id: "local-only", title: "Local only", kind: "change", branchKind: "feature", intent: "Support a repository without a remote" });
	assert.equal(item.delivery?.workingBranch, "feature/local-only");
	assert.equal(item.delivery?.createdFromCommit, createdFromCommit);
	assert.equal(await git(root, "branch", "--show-current"), "feature/local-only");
	assert.deepEqual(await new WorktreeManager(identity).validateWorkingBranch("local-only"), item.delivery);
	const executionHead = await git(root, "rev-parse", "HEAD");
	const begun = await store.beginExecution("local-only");
	assert.equal(begun.delivery?.executionStartCommit, executionHead);
	assert.equal((await store.beginExecution("local-only")).delivery?.executionStartCommit, executionHead);
});

test("fails creation safely when configured develop synchronization fails", async (t) => {
	const { parent, root } = await fixture(t, { remote: false });
	await git(root, "remote", "add", "origin", join(parent, "missing.git"));
	const store = new WorkItemStore(root);
	await assert.rejects(store.create({ id: "broken-origin", title: "Broken origin", kind: "change", branchKind: "feature", intent: "Fail closed" }), /does not appear to be a git repository|Could not read from remote repository/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	await assert.rejects(store.read("broken-origin"), /does not exist/);
});

test("workflow validation never switches away from the bound working branch", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "resume", title: "Resume", kind: "change", branchKind: "feature", intent: "Resume safely" });
	await git(root, "switch", "develop");
	await assert.rejects(new WorktreeManager(identity).validateWorkingBranch("resume"), /never switch branches/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
});

test("rejects branch collisions before writing a work item", async (t) => {
	const { root } = await fixture(t);
	await git(root, "branch", "feature/collision");
	const store = new WorkItemStore(root);
	await assert.rejects(store.create({ id: "collision", title: "Collision", kind: "change", branchKind: "feature", intent: "Reject collision" }), /already exists/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
});

test("rejects initial creation from a dirty, protected, or wrong checkout", async (t) => {
	const { root } = await fixture(t);
	const store = new WorkItemStore(root);
	await writeFile(join(root, "dirty.txt"), "dirty\n");
	await assert.rejects(store.create({ id: "dirty", title: "Dirty", kind: "story", branchKind: "feature", intent: "Reject dirty" }), /uncommitted changes/);
	await rm(join(root, "dirty.txt"));
	await git(root, "switch", "-c", "feature/existing-work");
	await assert.rejects(store.create({ id: "wrong", title: "Wrong", kind: "story", workingBranch: "feature/wrong", intent: "Reject wrong branch" }), /must be created from clean develop/);
	await git(root, "switch", "develop");
	await assert.rejects(store.create({ id: "protected", title: "Protected", kind: "story", workingBranch: "develop", intent: "Reject protected branch" }), /workingBranch must match/);
});

test("resumes a dirty worktree recorded for the same task assignment", async (t) => {
	const { root, identity } = await fixture(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "resume", title: "Resume", kind: "change", branchKind: "fix", intent: "Resume retained work" });
	const manifest = task();
	await store.defineTask({ workItemId: "resume", manifest, brief: "Create a file", acceptance: "File exists" });
	await addParallelSibling(store, "resume", "feature-unit");
	await store.submitPlanning("resume");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("resume");
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
	await store.create({ id: "cleanup", title: "Cleanup", kind: "change", branchKind: "fix", intent: "Test retained worktree cleanup" });
	const manifest = task();
	await store.defineTask({ workItemId: "cleanup", manifest, brief: "No-op", acceptance: "No-op" });
	await addParallelSibling(store, "cleanup", "feature-unit");
	await store.submitPlanning("cleanup");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("cleanup");
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
	await store.create({ id: "unignored", title: "Unignored", kind: "change", branchKind: "fix", intent: "Test ignore enforcement" });
	const manifest = task();
	await store.defineTask({ workItemId: "unignored", manifest, brief: "Create a file", acceptance: "File exists" });
	await addParallelSibling(store, "unignored", "feature-unit");
	await store.submitPlanning("unignored");
	const manager = new WorktreeManager(identity);
	await manager.validateWorkingBranch("unignored");
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
