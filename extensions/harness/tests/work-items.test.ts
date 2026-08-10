import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessError } from "../errors.js";
import type { TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim();
}

async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-harness-git-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "# Fixture\n");
	await git(root, "add", "README.md");
	await git(root, "commit", "--quiet", "-m", "initial");
	return root;
}

test("creates, catalogs, submits, and approves canonical work-item artifacts", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const created = await store.create({ id: "session-model", title: "Session Model", kind: "story", intent: "# Intent\nReplace sessions." });
	assert.equal(created.planning.status, "draft");
	assert.equal((await git(root, "log", "-1", "--pretty=%s")), "harness(session-model): create work item");

	const amended = await store.putArtifact({
		workItemId: "session-model",
		id: "identity",
		type: "spec",
		content: "# Identity\nIDs are server minted.",
		operation: "create",
	});
	assert.equal(amended.planning.revision, 2);
	assert.equal(amended.artifacts[1]?.path, "specs/identity.md");

	const task: TaskManifest = {
		schemaVersion: 1,
		id: "implement-identity",
		title: "Implement identity",
		status: "ready",
		dependsOn: [],
		references: { specs: ["identity"], designs: [], decisions: [] },
		execution: {
			isolation: "worktree",
			parallelism: "allowed",
			resourceClaims: [],
			complexity: "high",
			assignment: {
				role: "implementer",
				model: "sol",
				effort: "high",
				minimumCapabilityRank: 200,
				allowFallback: true,
				rationale: "Security-sensitive identity contract",
			},
		},
		assembly: { integrationUnit: "session-runtime", intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: ["test"], taskChecks: ["npm test"], rationale: "Runnable after assembly" },
	};
	const planned = await store.defineTask({
		workItemId: "session-model",
		manifest: task,
		brief: "Implement server-minted identity.",
		acceptance: "Session ids originate on the server.",
	});
	assert.equal(planned.planning.revision, 3);
	assert.deepEqual(planned.integrationUnits, [{ id: "session-runtime", tasks: ["implement-identity"], intermediatePolicy: "coherent" }]);
	assert.equal((await store.readTask("session-model", "implement-identity")).execution.assignment.model, "sol");

	const submitted = await store.submitPlanning("session-model");
	assert.equal(submitted.planning.status, "awaiting_approval");
	assert.equal(submitted.state, "waiting_user");
	const approved = await store.approve("session-model");
	assert.equal(approved.planning.status, "approved");
	assert.equal(approved.planning.approvedRevision, 3);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("fails loudly instead of hiding a dirty canonical branch", async (t) => {
	const root = await repository(t);
	await writeFile(join(root, "dirty.txt"), "dirty\n");
	const store = new WorkItemStore(root);
	await assert.rejects(
		store.create({ id: "blocked-change", title: "Blocked", kind: "change", intent: "Do work" }),
		(error: unknown) => error instanceof HarnessError && error.code === "DIRTY_CANONICAL_BRANCH",
	);
	assert.equal(await readFile(join(root, "dirty.txt"), "utf8"), "dirty\n");
});

test("detects out-of-band contract edits before approval", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "digest-check", title: "Digest Check", kind: "change", intent: "Original intent" });
	await store.submitPlanning("digest-check");
	await writeFile(join(root, "agent-artifacts", "digest-check", "intent.md"), "Changed outside capabilities\n");
	await git(root, "add", "agent-artifacts/digest-check/intent.md");
	await git(root, "commit", "--quiet", "-m", "out-of-band contract edit");
	await assert.rejects(
		store.approve("digest-check"),
		(error: unknown) => error instanceof HarnessError && error.code === "STALE_PLANNING_REVISION",
	);
});
