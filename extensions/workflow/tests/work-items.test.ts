import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HarnessError } from "../errors.js";
import { validateExecutionTopology } from "../execution-topology.js";
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
	await git(root, "branch", "-M", "develop");
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

test("rejects a new final E2E launch without a matrix while preserving legacy E2E stories", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "new-no-matrix", title: "New", kind: "story", intent: "Needs journeys." });
	await assert.rejects(store.ensureFinalEvaluations("new-no-matrix"), /without an e2e-matrix artifact/);
});

test("final E2E cannot pass or be risk-accepted with incomplete matrix results", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "e2e-integrity", title: "E2E integrity", kind: "story", intent: "Require complete structured journey results." });
	await store.putArtifact({ workItemId: "e2e-integrity", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Journeys", sections: { cases: [
		{ id: "E2E-001", classification: "golden-path", journey: "First journey", setup: ["Setup"], actions: ["Act"], expectedOutcomes: ["Pass"], evidence: ["Observe"] },
		{ id: "E2E-002", classification: "recovery", journey: "Recovery journey", setup: ["Disconnect"], actions: ["Reconnect"], expectedOutcomes: ["Recover"], evidence: ["Observe recovery"] },
	] }, operation: "create" });
	await store.defineEvaluation("e2e-integrity", { schemaVersion: 1, id: "final-e2e", type: "e2e", checkpoint: "final-e2e", scope: { workItem: "e2e-integrity" }, status: "planned", required: true, attempt: 0, methods: ["run matrix"] });
	const result = (caseId: string, status: "pass" | "fail" | "blocked") => ({ caseId, status, executedActions: ["Act"], observations: [status], evidenceRefs: [`${caseId}.json`] });
	await assert.rejects(store.recordEvaluation({ workItemId: "e2e-integrity", evaluationId: "final-e2e", verdict: "pass", report: "Incomplete pass", evidence: [], caseResults: [result("E2E-001", "pass"), result("E2E-002", "blocked")] }), /cannot pass with incomplete cases/i);
	await store.recordEvaluation({ workItemId: "e2e-integrity", evaluationId: "final-e2e", verdict: "fail", report: "Recovery remains blocked", evidence: [], caseResults: [result("E2E-001", "pass"), result("E2E-002", "blocked")], findings: [{ id: "E2E-BLOCKED", severity: "high", status: "open", summary: "Recovery is blocked", blocking: true }] });
	await assert.rejects(store.approveEvaluation("e2e-integrity", "final-e2e", [{ findingId: "E2E-BLOCKED", rationale: "Attempt to accept an incomplete required journey." }]), /cannot be accepted as risk/i);
	const passed = await store.recordEvaluation({ workItemId: "e2e-integrity", evaluationId: "final-e2e", verdict: "pass", report: "Every journey passed", evidence: [], caseResults: [result("E2E-001", "pass"), result("E2E-002", "pass")], findings: [{ id: "E2E-BLOCKED", severity: "high", status: "resolved", summary: "Recovery now passes", blocking: false }] });
	assert.equal(passed.status, "passed");
	assert.equal(passed.result?.caseResults?.length, 2);
	assert.match(await readFile(join(root, "agent-artifacts", "e2e-integrity", "evaluations", "final-e2e", "report.md"), "utf8"), /## E2E Case Results[\s\S]+E2E-002.*pass/);
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

test("completion honors explicitly accepted blocking risks with durable authority", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "accepted-risk", title: "Accepted Risk", kind: "change", intent: "Complete with an authorized residual risk." });
	await store.defineEvaluation("accepted-risk", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "accepted-risk" }, status: "planned", required: true, attempt: 0, methods: ["review"] });
	await store.recordEvaluation({
		workItemId: "accepted-risk", evaluationId: "review", verdict: "fail", report: "One bounded risk remains.", evidence: [],
		findings: [{ id: "RISK-001", severity: "high", status: "open", summary: "Known bounded limitation", blocking: true }],
	});
	await store.approveEvaluation("accepted-risk", "review", [{ findingId: "RISK-001", rationale: "The manager explicitly accepts this non-critical bounded limitation." }]);
	const completed = await store.completeWorkItem("accepted-risk", undefined, { delivered: ["Reviewed behavior"], residualRisks: ["RISK-001 remains accepted"] });
	assert.equal(completed.phase, "complete");
	const outcome = await readFile(join(root, "agent-artifacts", "accepted-risk", "outcome.md"), "utf8");
	assert.match(outcome, /RISK-001.*accepted/);
	assert.match(outcome, /risk report: risk-acceptance\.md/);
});

test("completion rejects a blocking finding labeled accepted without manager authority", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "unauthorized-risk", title: "Unauthorized Risk", kind: "change", intent: "Reject evaluator-authored acceptance." });
	await store.defineEvaluation("unauthorized-risk", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "unauthorized-risk" }, status: "planned", required: true, attempt: 0, methods: ["review"] });
	await store.recordEvaluation({
		workItemId: "unauthorized-risk", evaluationId: "review", verdict: "pass", report: "Worker labeled its own risk accepted.", evidence: [],
		findings: [{ id: "RISK-002", severity: "high", status: "accepted", summary: "Unapproved limitation", blocking: true }],
	});
	await assert.rejects(store.completeWorkItem("unauthorized-risk", "# Outcome\n\nShould not complete."), /unresolved blocking finding/);
});

test("serializes complete canonical commits across independent WorkItemStore instances", async (t) => {
	const root = await repository(t);
	const firstStore = new WorkItemStore(root);
	const secondStore = new WorkItemStore(root);
	await firstStore.create({ id: "concurrent", title: "Concurrent", kind: "change", intent: "Exercise canonical serialization" });
	await Promise.all([
		firstStore.putArtifact({ workItemId: "concurrent", id: "first", type: "spec", content: "# First\n\nFirst contract.", operation: "create" }),
		secondStore.putArtifact({ workItemId: "concurrent", id: "second", type: "design", content: "# Second\n\nSecond contract.", operation: "create" }),
	]);
	const store = firstStore;
	const item = await store.read("concurrent");
	assert.equal(item.planning.revision, 3);
	assert.deepEqual(item.artifacts.map((artifact) => artifact.id).sort(), ["first", "intent", "second"]);
	assert.equal(await git(root, "rev-list", "--count", "HEAD"), "4");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("duplicate task completion settlement is an idempotent no-op", async (t) => {
	const root = await repository(t);
	const firstStore = new WorkItemStore(root);
	const secondStore = new WorkItemStore(root);
	await firstStore.create({ id: "duplicate-settlement", title: "Duplicate settlement", kind: "change", intent: "Settle one task once." });
	await firstStore.defineTask({
		workItemId: "duplicate-settlement",
		manifest: {
			schemaVersion: 1, id: "task", title: "Task", status: "ready", dependsOn: [], references: { specs: [], designs: [], decisions: [] },
			execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "Race regression fixture" } },
			assembly: { stageId: "delivery", intermediateState: "complete" },
			verification: { timing: "task", methods: [], taskChecks: [], rationale: "No-op settlement regression" },
		},
		brief: "Complete the task.",
		acceptance: "Completion is recorded exactly once.",
	});
	await firstStore.updateTask("duplicate-settlement", "task", { status: "running", runtime: { lastRunId: "run-1" } });
	const before = Number(await git(root, "rev-list", "--count", "HEAD"));
	const settlement = { status: "contribution_complete" as const, runtime: { completedCommit: "a".repeat(40) } };

	await Promise.all([
		firstStore.updateTask("duplicate-settlement", "task", settlement),
		secondStore.updateTask("duplicate-settlement", "task", settlement),
	]);

	const task = await firstStore.readTask("duplicate-settlement", "task");
	assert.equal(task.status, "contribution_complete");
	assert.equal(task.runtime?.completedCommit, "a".repeat(40));
	assert.equal(Number(await git(root, "rev-list", "--count", "HEAD")), before + 1);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("removeTask and removeEvaluation report original and rollback failures with owned paths", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "rollback-removals", title: "Rollback removals", kind: "change", intent: "Exercise removal rollback reporting" });
	await store.defineEvaluation("rollback-removals", { schemaVersion: 1, id: "review", type: "deterministic", scope: { workItem: "rollback-removals" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	const task: TaskManifest = {
		schemaVersion: 1, id: "planned-task", title: "Planned task", status: "draft", dependsOn: [], references: { specs: [], designs: [], decisions: [] },
		execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "rollback fixture" } },
		assembly: { stageId: "delivery", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "rollback fixture" },
	};
	await store.defineTask({ workItemId: "rollback-removals", manifest: task, brief: "Do it", acceptance: "It works" });
	const failing = store as unknown as { commit: () => Promise<void>; restore: () => Promise<void> };
	failing.commit = async () => { throw new Error("original commit failure"); };
	failing.restore = async () => { throw new Error("rollback restore failure"); };
	await assert.rejects(store.removeTask("rollback-removals", "planned-task", { rationale: "test" }), (error: unknown) => {
		assert.match(String(error), /original commit failure/); assert.match(String(error), /rollback restore failure/); assert.match(String(error), /agent-artifacts/); return true;
	});
	const evaluationRoot = await repository(t);
	const evaluationStore = new WorkItemStore(evaluationRoot);
	await evaluationStore.create({ id: "rollback-evaluation", title: "Rollback evaluation", kind: "change", intent: "Exercise evaluation rollback reporting" });
	await evaluationStore.defineEvaluation("rollback-evaluation", { schemaVersion: 1, id: "review", type: "deterministic", scope: { workItem: "rollback-evaluation" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	const evaluationFailing = evaluationStore as unknown as { commit: () => Promise<void>; restore: () => Promise<void> };
	evaluationFailing.commit = async () => { throw new Error("original commit failure"); };
	evaluationFailing.restore = async () => { throw new Error("rollback restore failure"); };
	await assert.rejects(evaluationStore.removeEvaluation("rollback-evaluation", "review", { rationale: "test" }), (error: unknown) => {
		assert.match(String(error), /original commit failure/); assert.match(String(error), /rollback restore failure/); assert.match(String(error), /agent-artifacts/); return true;
	});
});

test("evaluation evidence accepts source citations with line ranges", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "line-citations", title: "Line Citations", kind: "change", intent: "Retain ordinary reviewer source citations." });
	await store.defineEvaluation("line-citations", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "line-citations" }, status: "planned", required: true, attempt: 0, methods: ["review"] });
	await store.recordEvaluation({
		workItemId: "line-citations", evaluationId: "review", verdict: "fail", report: "A source finding remains.",
		evidence: [{ path: "README.md:1-1,1", result: "Source inspected", description: "Bounded line citation" }],
		findings: [{ id: "SRC-001", severity: "medium", status: "open", summary: "Source issue", blocking: true }],
	});
	const evidenceRoot = join(root, "agent-artifacts", "line-citations", "evidence", "review");
	const manifest = await readFile(join(evidenceRoot, "manifest.yaml"), "utf8");
	assert.match(manifest, /path: files\/001-1-README\.md/);
	assert.equal(await readFile(join(evidenceRoot, "files", "001-1-README.md"), "utf8"), "# Fixture\n");
});

test("evaluation evidence rejects directories before copying any canonical files", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "directory-evidence", title: "Directory Evidence", kind: "change", intent: "Reject non-file evidence atomically." });
	await store.defineEvaluation("directory-evidence", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "directory-evidence" }, status: "planned", required: true, attempt: 0, methods: ["review"] });
	await mkdir(join(root, "evidence-directory"));
	await assert.rejects(store.recordEvaluation({
		workItemId: "directory-evidence", evaluationId: "review", verdict: "fail", report: "Directory evidence is invalid.",
		evidence: [
			{ path: "README.md", result: "Valid file appears before the invalid source." },
			{ path: "evidence-directory", result: "Directories are not canonical evidence files." },
		],
		findings: [],
	}), /Evidence path is not a regular file.*specific sanitized file/);
	const evidenceRoot = join(root, "agent-artifacts", "directory-evidence", "evidence", "review");
	await assert.rejects(readFile(join(evidenceRoot, "files", "001-1-README.md")), /ENOENT/);
	assert.equal((await store.readEvaluation("directory-evidence", "review")).attempt, 0);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("failed later evaluation recording preserves prior attempt evidence", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "evaluation-rollback", title: "Evaluation rollback", kind: "change", intent: "Preserve historical review evidence" });
	await store.defineEvaluation("evaluation-rollback", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "evaluation-rollback" }, status: "planned", required: true, attempt: 0, methods: ["review"] });
	await store.recordEvaluation({ workItemId: "evaluation-rollback", evaluationId: "review", verdict: "fail", report: "first report", evidence: [{ command: "first-check", result: "failed" }], findings: [{ id: "F1", severity: "high", status: "open", summary: "first finding", blocking: true }] });
	const evaluationRoot = join(root, "agent-artifacts", "evaluation-rollback", "evaluations", "review");
	const evidenceRoot = join(root, "agent-artifacts", "evaluation-rollback", "evidence", "review");
	const before = {
		evaluation: await readFile(join(evaluationRoot, "evaluation.yaml"), "utf8"),
		report: await readFile(join(evaluationRoot, "report.md"), "utf8"),
		evidence: await readFile(join(evidenceRoot, "manifest.yaml"), "utf8"),
	};
	const failing = store as unknown as { commit: () => Promise<void> };
	failing.commit = async () => { throw new Error("second evaluation commit failure"); };
	await assert.rejects(store.recordEvaluation({ workItemId: "evaluation-rollback", evaluationId: "review", verdict: "pass", report: "second report", evidence: [{ command: "second-check", result: "passed", path: "README.md" }], findings: [] }), /second evaluation commit failure/);
	assert.equal(await readFile(join(evaluationRoot, "evaluation.yaml"), "utf8"), before.evaluation);
	assert.equal(await readFile(join(evaluationRoot, "report.md"), "utf8"), before.report);
	assert.equal(await readFile(join(evidenceRoot, "manifest.yaml"), "utf8"), before.evidence);
	await assert.rejects(readFile(join(evidenceRoot, "files", "002-1-README.md")), /ENOENT/);
	await assert.rejects(readFile(join(evaluationRoot, "attempts", "002-report.md")), /ENOENT/);
	assert.equal((await store.readEvaluation("evaluation-rollback", "review")).attempt, 1);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("restore preserves the original mutation error without removing existing artifact directories", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "restore-error", title: "Restore error", kind: "change", intent: "Preserve rollback causality" });
	const task: TaskManifest = {
		schemaVersion: 1, id: "existing-task", title: "Existing task", status: "draft", dependsOn: [], references: { specs: [], designs: [], decisions: [] },
		execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "rollback fixture" } },
		assembly: { stageId: "delivery", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "rollback fixture" },
	};
	await store.defineTask({ workItemId: "restore-error", manifest: task, brief: "existing brief", acceptance: "existing acceptance" });
	const failing = store as unknown as { commit: () => Promise<void> };
	failing.commit = async () => { throw new Error("original commit failure"); };

	await assert.rejects(store.updateTask("restore-error", "existing-task", { status: "ready" }), /original commit failure/);
	assert.equal((await store.readTask("restore-error", "existing-task")).status, "draft");
	await assert.rejects(store.putArtifact({ workItemId: "restore-error", id: "new-design", type: "design", content: "# New design", operation: "create" }), /original commit failure/);
	await assert.rejects(readFile(join(root, "agent-artifacts", "restore-error", "design", "new-design.md")), /ENOENT/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("does not roll back committed removal when private backup cleanup fails", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	await store.create({ id: "cleanup-atomic", title: "Cleanup", kind: "change", intent: "cleanup" });
	const task: TaskManifest = {
		schemaVersion: 1, id: "delete-me", title: "Delete me", status: "draft", dependsOn: [], references: { specs: [], designs: [], decisions: [] },
		execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "cleanup" } },
		assembly: { stageId: "cleanup", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "cleanup" },
	};
	await store.defineTask({ workItemId: "cleanup-atomic", manifest: task, brief: "delete", acceptance: "deleted" });
	const failing = store as unknown as { discardBackup: () => Promise<void> };
	failing.discardBackup = async () => { throw new Error("cleanup failure"); };
	await assert.rejects(store.removeTask("cleanup-atomic", "delete-me", { rationale: "test" }), /No rollback was attempted/);
	assert.equal((await store.read("cleanup-atomic")).tasks.length, 0);
	assert.equal(await git(root, "status", "--porcelain"), "");
	assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
	assert.match(await git(root, "log", "-1", "--pretty=%s"), /remove task delete-me/);
});

test("independent stores on linked worktrees share the common-dir canonical lock", async (t) => {
	const root = await repository(t);
	const linked = await mkdtemp(join(tmpdir(), "pibox-linked-worktree-"));
	await rm(linked, { recursive: true, force: true });
	await git(root, "worktree", "add", "--quiet", "-b", "linked-lock", linked, "develop");
	t.after(async () => { await git(root, "worktree", "remove", "--force", linked).catch(() => undefined); await rm(linked, { recursive: true, force: true }); });
	const mainStore = new WorkItemStore(root);
	const linkedStore = new WorkItemStore(linked);
	assert.equal(mainStore.coordinator.mutex.path, linkedStore.coordinator.mutex.path);
	assert.match(mainStore.coordinator.mutex.path, /[\\/]locks[\\/]canonical$/);
	let order = "";
	await Promise.all([
		mainStore.coordinator.run("main", async () => { order += "a"; await new Promise((resolve) => setTimeout(resolve, 20)); order += "b"; }),
		linkedStore.coordinator.run("linked", async () => { order += "c"; }),
	]);
	assert.ok(order === "abc" || order === "cab");
});

test("restores the original branch and removes only the transaction-owned branch after create failure", async (t) => {
	const root = await repository(t);
	const store = new WorkItemStore(root);
	const failing = store as unknown as { commit: () => Promise<void> };
	failing.commit = async () => { throw new Error("canonical create failure"); };
	await assert.rejects(store.create({ id: "atomic-create", title: "Atomic create", kind: "change", branchKind: "feature", intent: "rollback" }), /canonical create failure/);
	assert.equal(await git(root, "branch", "--show-current"), "develop");
	await assert.rejects(git(root, "show-ref", "--verify", "refs/heads/feature/atomic-create"));
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

test("rejects unsupported persisted execution stage modes", () => {
	assert.throws(() => parseWorkItemIndex(`schemaVersion: 1
id: invalid-mode
title: Invalid mode
kind: change
phase: planning
state: active
planning:
  revision: 1
artifacts: []
tasks: []
evaluations: []
executionStages:
  - id: delivery
    tasks: [task]
    mode: diagonal
`), /invalid execution stage mode/);
});

test("rejects evaluation-only planner stages", () => {
	const item = { executionStages: [{ id: "review", tasks: [] }], integrationUnits: [] } as any;
	assert.throws(() => validateExecutionTopology(item, [], []), /must contain at least one task/);
});

test("rejects same-stage blockers and conflicting parallel resource claims on submit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "bad-topology", title: "Bad topology", kind: "change", intent: "Reject unsafe stage topology." });
	const manifest = (id: string, dependsOn: string[], claim: string): TaskManifest => ({ schemaVersion: 1, id, title: id, status: "draft", dependsOn, references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [claim], assignment: { agent: "implementer", tier: "medium", rationale: "fixture" } }, assembly: { stageId: "parallel", intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "fixture" } });
	await store.defineTask({ workItemId: "bad-topology", manifest: manifest("first", [], "shared"), brief: "First", acceptance: "First accepted" });
	await store.defineTask({ workItemId: "bad-topology", manifest: manifest("second", ["first"], "other"), brief: "Second", acceptance: "Second accepted" });
	await assert.rejects(store.submitPlanning("bad-topology"), /blockers must be placed in an earlier execution stage/);
	const second = await store.readTaskContract("bad-topology", "second"); second.manifest.dependsOn = []; second.manifest.execution.resourceClaims = ["shared"];
	await store.reviseTask({ workItemId: "bad-topology", manifest: second.manifest, brief: second.brief, acceptance: second.acceptance, authority: { rationale: "write incomplete repair fixture" } });
	await assert.rejects(store.submitPlanning("bad-topology"), /conflicting resource claim shared/);
});

test("planning remains editable source and submission compiles the complete topology", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "draft-compiler", title: "Draft compiler", kind: "change", intent: "Compile topology only at submission." });
	const manifest = (id: string, dependsOn: string[] = []): TaskManifest => ({ schemaVersion: 1, id, title: id, status: "draft", dependsOn, references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "medium", rationale: "fixture" } }, assembly: { stageId: id, intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "fixture" } });
	await store.defineTask({ workItemId: "draft-compiler", manifest: manifest("foundation"), brief: "Foundation", acceptance: "Foundation accepted" });
	await store.defineTask({ workItemId: "draft-compiler", manifest: manifest("feature", ["foundation"]), brief: "Feature", acceptance: "Feature accepted" });

	// Regroup in reverse authoring order. Each write is accepted, and a new stage
	// occupies the earliest position donated by its tasks rather than moving them
	// behind their dependants.
	await store.putExecutionStage("draft-compiler", { id: "feature-stage", mode: "sequential", tasks: ["feature"] }, { rationale: "draft regroup" });
	await store.putExecutionStage("draft-compiler", { id: "foundation-stage", mode: "sequential", tasks: ["foundation"] }, { rationale: "draft regroup" });
	assert.deepEqual((await store.read("draft-compiler")).executionStages?.map((stage) => stage.id), ["foundation-stage", "feature-stage"]);
	await store.submitPlanning("draft-compiler");

	// Temporary empty membership and a forward dependency are persisted as
	// advisory draft diagnostics instead of blocking the next edit.
	await store.putExecutionStage("draft-compiler", { id: "foundation-stage", mode: "sequential", tasks: [] }, { rationale: "temporarily detach foundation" });
	const feature = await store.readTaskContract("draft-compiler", "feature");
	feature.manifest.dependsOn = ["future-task"];
	await store.reviseTask({ workItemId: "draft-compiler", manifest: feature.manifest, brief: feature.brief, acceptance: feature.acceptance, authority: { rationale: "write forward dependency" } });
	const issues = await store.planningTopologyIssues("draft-compiler");
	assert.deepEqual(new Set(issues.map((issue) => issue.code)), new Set(["empty-stage", "unassigned-task", "unknown-dependency"]));
	await assert.rejects(store.submitPlanning("draft-compiler"), (error: unknown) => {
		assert.ok(error instanceof HarnessError);
		assert.match(error.message, /Plan compilation failed with 3 execution-topology issues/);
		assert.equal((error.details.issues as unknown[]).length, 3);
		return true;
	});
	await assert.rejects(store.beginExecution("draft-compiler"), /Plan compilation failed with 3 execution-topology issues/);
	assert.equal((await store.read("draft-compiler")).phase, "planning");

	await store.putExecutionStage("draft-compiler", { id: "foundation-stage", mode: "sequential", tasks: ["foundation"] }, { rationale: "restore foundation" });
	const repaired = await store.readTaskContract("draft-compiler", "feature");
	repaired.manifest.dependsOn = ["foundation"];
	await store.reviseTask({ workItemId: "draft-compiler", manifest: repaired.manifest, brief: repaired.brief, acceptance: repaired.acceptance, authority: { rationale: "repair dependency" } });
	assert.deepEqual(await store.planningTopologyIssues("draft-compiler"), []);
	await store.submitPlanning("draft-compiler");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("forward task references can be ordered after the pieces are written", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "forward-plan", title: "Forward plan", kind: "change", intent: "Write pieces before arranging them." });
	const manifest = (id: string, dependsOn: string[] = []): TaskManifest => ({ schemaVersion: 1, id, title: id, status: "draft", dependsOn, references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "medium", rationale: "fixture" } }, assembly: { stageId: id, intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "fixture" } });
	await store.defineTask({ workItemId: "forward-plan", manifest: manifest("feature", ["foundation"]), brief: "Feature", acceptance: "Feature accepted" });
	await store.defineTask({ workItemId: "forward-plan", manifest: manifest("foundation"), brief: "Foundation", acceptance: "Foundation accepted" });
	assert.deepEqual((await store.planningTopologyIssues("forward-plan")).map((issue) => issue.code), ["dependency-order"]);

	await store.removeExecutionStage("forward-plan", "feature", { rationale: "reorder draft" });
	await store.removeExecutionStage("forward-plan", "foundation", { rationale: "reorder draft" });
	await store.putExecutionStage("forward-plan", { id: "foundation-stage", mode: "sequential", tasks: ["foundation"] }, { rationale: "arrange draft" });
	await store.putExecutionStage("forward-plan", { id: "feature-stage", mode: "sequential", tasks: ["feature"] }, { rationale: "arrange draft" });
	assert.deepEqual(await store.planningTopologyIssues("forward-plan"), []);
	await store.submitPlanning("forward-plan");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("idempotent review-loop settlement does not attempt an empty Git commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "loop-settlement", title: "Loop settlement", kind: "change", intent: "Settle repair metadata idempotently." });
	await store.defineEvaluation("loop-settlement", { schemaVersion: 1, id: "review", type: "combined-review", scope: { workItem: "loop-settlement" }, status: "failed", required: true, attempt: 1, methods: ["review"] });
	await store.updateEvaluationLoop("loop-settlement", "review", { state: "fixing", iteration: 1, maxIterations: 3, managerPrompt: "Fix F1", fixerAgentId: "fixer" }, "failed");
	const settledHead = await git(root, "rev-parse", "HEAD");
	const replay = await store.updateEvaluationLoop("loop-settlement", "review", { state: "fixing", iteration: 1, maxIterations: 3, managerPrompt: "Fix F1", fixerAgentId: "fixer" }, "failed");
	assert.equal(replay.loop?.state, "fixing");
	assert.equal(await git(root, "rev-parse", "HEAD"), settledHead);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("revising a singleton task preserves stage order", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "singleton-order", title: "Singleton order", kind: "change", intent: "Preserve execution order." });
	const manifest = (id: string, stageId: string): TaskManifest => ({ schemaVersion: 1, id, title: id, status: "draft", dependsOn: [], references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "low", rationale: "fixture" } }, assembly: { stageId, intermediateState: "complete" }, verification: { timing: "task", methods: [], taskChecks: [], rationale: "fixture" } });
	await store.defineTask({ workItemId: "singleton-order", manifest: manifest("first", "first-stage"), brief: "First", acceptance: "First" });
	await store.putExecutionStage("singleton-order", { id: "first-stage", tasks: ["first"], mode: "sequential" }, { rationale: "fixture" });
	await store.defineTask({ workItemId: "singleton-order", manifest: manifest("second", "second-stage"), brief: "Second", acceptance: "Second" });
	const contract = await store.readTaskContract("singleton-order", "first");
	contract.manifest.title = "First revised";
	const revised = await store.reviseTask({ workItemId: "singleton-order", manifest: contract.manifest, brief: contract.brief, acceptance: contract.acceptance, authority: { rationale: "fixture" } });
	assert.deepEqual(revised.executionStages?.map((stage) => stage.id), ["first-stage", "second-stage"]);
	assert.deepEqual(revised.executionStages?.map((stage) => stage.tasks), [["first"], ["second"]]);
	assert.equal(revised.executionStages?.find((stage) => stage.id === "first-stage")?.mode, "sequential");
	assert.equal(await git(root, "status", "--porcelain"), "");
});
