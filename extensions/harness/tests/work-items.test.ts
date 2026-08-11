import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessError } from "../errors.js";
import { RepositoryMutex } from "../idempotency.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
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
	const linked = await store.linkArtifact("session-model", "identity", ["intent"]);
	assert.deepEqual(linked.artifacts.find((artifact) => artifact.id === "identity")?.links, ["intent"]);

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
	assert.equal(planned.planning.revision, 4);
	assert.deepEqual(planned.integrationUnits, [{ id: "session-runtime", tasks: ["implement-identity"], intermediatePolicy: "coherent" }]);
	assert.equal((await store.readTask("session-model", "implement-identity")).execution.assignment.model, "sol");

	const submitted = await store.submitPlanning("session-model");
	assert.equal(submitted.planning.status, "awaiting_approval");
	assert.equal(submitted.state, "waiting_user");
	const approved = await store.approve("session-model");
	assert.equal(approved.planning.status, "approved");
	assert.equal(approved.planning.approvedRevision, 4);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("renders schema-v2 intent, artifacts, and task contracts from semantic values", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({
		id: "structured",
		title: "Structured narratives",
		kind: "change",
		narrativeSchemaVersion: 2,
		intentSections: { problem: "Free-form artifacts drift.", desiredOutcome: "Stable readable artifacts.", scopeIncluded: ["Harness-owned Markdown"], successSignals: ["Required fields are rendered"] },
	});
	await store.putArtifact({
		workItemId: "structured", id: "contract", type: "spec", narrativeSchemaVersion: 2, title: "Narrative contract",
		sections: { context: "Models provide semantics.", requiredBehaviors: ["Capabilities render structure."], acceptanceCriteria: [{ id: "AC-001", statement: "Markdown has stable headings." }] }, operation: "create",
	});
	const manifest: TaskManifest = {
		schemaVersion: 1, id: "render-contract", title: "Render contract", status: "ready", dependsOn: [], references: { specs: ["contract"], designs: [], decisions: [] },
		execution: { isolation: "worktree", parallelism: "allowed", resourceClaims: [], complexity: "low", assignment: { role: "implementer", model: "luna", effort: "low", minimumCapabilityRank: 0, allowFallback: true, rationale: "bounded" } },
		assembly: { integrationUnit: "contract-unit", intermediateState: "complete" }, verification: { timing: "integration-unit", methods: ["test"], taskChecks: [], rationale: "assembled proof" },
	};
	await store.defineTask({
		workItemId: "structured", manifest, narrativeSchemaVersion: 2,
		briefSections: { contributionGoal: "Render one contract.", boundaryIncluded: ["Renderer"], requiredWork: ["Implement rendering"], integrationExpectation: "Complete contribution for contract-unit." },
		acceptanceSections: { deliverables: ["Renderer"], criterionContributions: [{ criteria: ["contract#AC-001"], contribution: "Stable headings" }], boundaryProof: ["Renderer unit test passes"] },
	});
	assert.match(await readFile(join(root, "agent-artifacts", "structured", "intent.md"), "utf8"), /## Desired Outcome/);
	assert.match(await readFile(join(root, "agent-artifacts", "structured", "specs", "contract.md"), "utf8"), /AC-001/);
	assert.match(await readFile(join(root, "agent-artifacts", "structured", "tasks", "render-contract", "acceptance.md"), "utf8"), /## Criterion Contributions/);
	assert.equal((await store.read("structured")).artifacts.find((artifact) => artifact.id === "contract")?.narrativeSchemaVersion, 2);
	const dangling: EvaluationManifest = { schemaVersion: 1, id: "dangling", type: "spec-review", scope: { workItem: "structured" }, status: "planned", required: true, attempt: 0, methods: ["review"], criteria: ["contract#AC-999"] };
	await assert.rejects(store.defineEvaluation("structured", dangling), /Dangling criterion reference/);
});

test("serializes complete canonical commits across independent mutex instances", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "concurrent", title: "Concurrent", kind: "change", intent: "Exercise canonical serialization" });
	const privateRoot = await mkdtemp(join(tmpdir(), "pibox-private-mutex-"));
	t.after(() => rm(privateRoot, { recursive: true, force: true }));
	const first = new RepositoryMutex(privateRoot);
	const second = new RepositoryMutex(privateRoot);
	await Promise.all([
		first.run("first-artifact", () => store.putArtifact({ workItemId: "concurrent", id: "first", type: "spec", content: "# First\n\nFirst contract.", operation: "create" })),
		second.run("second-artifact", () => store.putArtifact({ workItemId: "concurrent", id: "second", type: "design", content: "# Second\n\nSecond contract.", operation: "create" })),
	]);
	const item = await store.read("concurrent");
	assert.equal(item.planning.revision, 3);
	assert.deepEqual(item.artifacts.map((artifact) => artifact.id).sort(), ["first", "intent", "second"]);
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "4");
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

test("approval uses explicit planning status without contract hash gates", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "approval-status", title: "Approval Status", kind: "change", intent: "Original intent" });
	await store.submitPlanning("approval-status");
	const approved = await store.approve("approval-status");
	assert.equal(approved.planning.status, "approved");
	assert.equal((await store.reconcile("approval-status")).planning.status, "approved");
});
