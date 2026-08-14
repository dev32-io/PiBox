import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessError } from "../errors.js";
import { RepositoryMutex } from "../idempotency.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
import { parseTaskManifest, parseWorkItemIndex, WorkItemStore } from "../work-items.js";

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

test("creates, catalogs, and submits canonical work-item artifacts for review", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const created = await store.create({ id: "session-model", title: "Session Model", kind: "story", intent: "# Intent\nReplace sessions." });
	assert.deepEqual(created.planning, { revision: 1 });
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
			resourceClaims: [],
			assignment: {
				agent: "implementer",
				tier: "max",
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
	assert.deepEqual(planned.executionStages, [{ id: "session-runtime", tasks: ["implement-identity"] }]);
	assert.deepEqual((await store.readTask("session-model", "implement-identity")).execution.assignment, { agent: "implementer", tier: "max", rationale: "Security-sensitive identity contract" });

	const submitted = await store.submitPlanning("session-model");
	assert.deepEqual(submitted.planning, { revision: 4 });
	assert.equal(submitted.state, "active");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("workflow start begins execution and activates draft tasks according to dependencies", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "activation", title: "Activation", kind: "change", intent: "Activate reviewed work." });
	const manifest = (id: string, dependsOn: string[], stageId: string): TaskManifest => ({
		schemaVersion: 1, id, title: id, status: "draft", dependsOn,
		references: { specs: [], designs: [], decisions: [] },
		execution: { resourceClaims: [id], assignment: { agent: "implementer", tier: "low", rationale: "Fixture" } },
		assembly: { stageId, intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: [], taskChecks: [], rationale: "Fixture" },
	});
	await store.defineTask({ workItemId: "activation", manifest: manifest("first", [], "foundation"), brief: "First task", acceptance: "First accepted" });
	await store.defineTask({ workItemId: "activation", manifest: manifest("second", ["first"], "delivery"), brief: "Second task", acceptance: "Second accepted" });
	await store.submitPlanning("activation");
	await store.beginExecution("activation");
	await store.activateDraftTasks("activation");
	assert.equal((await store.read("activation")).phase, "execution");
	assert.equal((await store.readTask("activation", "first")).status, "ready");
	assert.equal((await store.readTask("activation", "second")).status, "blocked");
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
		execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "medium", rationale: "bounded" } },
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

test("keeps legacy model assignments readable for replanning", () => {
	const manifest = parseTaskManifest(`schemaVersion: 1
id: legacy-task
title: Legacy task
status: ready
dependsOn: []
references: { specs: [], designs: [], decisions: [] }
execution:
  isolation: worktree
  parallelism: serial
  resourceClaims: []
  complexity: high
  assignment:
    role: implementer
    model: luna
    effort: low
    minimumCapabilityRank: 0
    allowFallback: false
    rationale: Historical plan
assembly: { stageId: legacy-stage, intermediateState: complete }
verification: { timing: task, methods: [], taskChecks: [], rationale: Historical proof }
`);
	assert.equal("model" in manifest.execution.assignment ? manifest.execution.assignment.model : undefined, "luna");
});

test("rejects same-stage blockers and conflicting parallel resource claims on submit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "bad-topology", title: "Bad topology", kind: "change", intent: "Reject unsafe stage topology." });
	const manifest = (id: string, dependsOn: string[], claim: string): TaskManifest => ({ schemaVersion: 1, id, title: id, status: "draft", dependsOn, references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [claim], assignment: { agent: "implementer", tier: "medium", rationale: "fixture" } }, assembly: { stageId: "parallel", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "fixture" } });
	await store.defineTask({ workItemId: "bad-topology", manifest: manifest("first", [], "shared"), brief: "First", acceptance: "First accepted" });
	await store.defineTask({ workItemId: "bad-topology", manifest: manifest("second", ["first"], "other"), brief: "Second", acceptance: "Second accepted" });
	await assert.rejects(store.submitPlanning("bad-topology"), /blockers must be placed in an earlier execution stage/);
	const second = await store.readTaskContract("bad-topology", "second"); second.manifest.dependsOn = []; second.manifest.execution.resourceClaims = ["shared"];
	await store.reviseTask({ workItemId: "bad-topology", manifest: second.manifest, brief: second.brief, acceptance: second.acceptance, authority: { rationale: "repair fixture" } });
	await assert.rejects(store.submitPlanning("bad-topology"), /conflicting resource claim shared/);
});

test("legacy approval metadata is readable and normalized away", async (t) => {
	const legacy = `schemaVersion: 1\nid: legacy-approval\nkind: change\ntitle: Legacy approval\nphase: planning\nstate: waiting_user\nplanning:\n  revision: 3\n  status: approved\n  approvedRevision: 3\n  approvedAt: 2026-01-01T00:00:00Z\nartifacts: []\ntasks: []\nintegrationUnits: []\nevaluations: []\n`;
	assert.deepEqual(parseWorkItemIndex(legacy).planning, { revision: 3 });
	const root = await repository(t); const store = new WorkItemStore(root);
	const itemRoot = store.workItemRoot("legacy-approval");
	await mkdir(itemRoot, { recursive: true });
	await writeFile(join(itemRoot, "index.yaml"), legacy);
	await git(root, "add", "agent-artifacts/legacy-approval/index.yaml");
	await git(root, "commit", "--quiet", "-m", "legacy fixture");
	await store.beginExecution("legacy-approval");
	const persisted = await readFile(join(itemRoot, "index.yaml"), "utf8");
	assert.doesNotMatch(persisted, /approvedRevision|approvedAt|status: approved/);
	assert.equal((await store.read("legacy-approval")).phase, "execution");
	assert.equal((await store.read("legacy-approval")).state, "active");
});
