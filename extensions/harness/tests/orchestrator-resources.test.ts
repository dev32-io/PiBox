import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildTaskPersistentContext } from "../implementation-context.js";
import { OrchestratorResourceService } from "../orchestrator-resources.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim(); }
async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-resource-api-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet"); await git(root, "config", "user.name", "Resource Test"); await git(root, "config", "user.email", "resource@example.test");
	await writeFile(join(root, "README.md"), "# Fixture\n"); await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "initial");
	return root;
}
function task(id = "build-app"): TaskManifest {
	return { schemaVersion: 1, id, title: "Build app", status: "ready", dependsOn: [], references: { specs: [], designs: [], decisions: [] }, execution: { isolation: "worktree", parallelism: "serial", resourceClaims: [], complexity: "low", assignment: { role: "implementer", model: "luna", effort: "low", minimumCapabilityRank: 0, allowFallback: true, rationale: "bounded" } }, assembly: { integrationUnit: "app", intermediateState: "complete" }, verification: { timing: "integration-unit", methods: ["test"], taskChecks: ["test -f app.txt"], rationale: "assembled" } };
}
const retain = { disposition: "retain-approval" as const, rationale: "Resolve an implementation detail within delegated intent", sources: ["agent-message:change-1"] };

test("builds a focused persistent implementation packet", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "context-packet", title: "Context packet", kind: "change", intent: "Broad intent that referenced context makes unnecessary." });
	await store.putArtifact({ workItemId: "context-packet", id: "behavior", type: "spec", content: "# Behavior\n\nThe app writes hello.", operation: "create" });
	const manifest = task(); manifest.references.specs = ["behavior"];
	await store.defineTask({ workItemId: "context-packet", manifest, brief: "# Brief\n\nCreate the app.", acceptance: "# Acceptance\n\nThe app is complete." });
	const packet = await buildTaskPersistentContext(store, "context-packet", manifest);
	assert.match(packet, /Persistent Implementation Context/);
	assert.match(packet, /Create the app/);
	assert.match(packet, /The app is complete/);
	assert.match(packet, /Referenced spec: behavior/);
	assert.match(packet, /The app writes hello/);
	assert.match(packet, /test -f app\.txt/);
	assert.doesNotMatch(packet, /Broad intent|planning revision|sha256|assignment rationale/i);
});

test("revises an approved task in place while retaining approval continuity", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "resource-flow", title: "Resource flow", kind: "change", intent: "Deliver one app." });
	await store.defineTask({ workItemId: "resource-flow", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("resource-flow"); await store.approve("resource-flow");
	await service.transaction("harness: revise task", () => service.patch("work-item:resource-flow/task:build-app", { manifest: { title: "Build the revised app", assembly: { integrationUnit: "delivery" } } }, { authority: retain }));
	const after = await store.read("resource-flow");
	assert.equal(after.tasks.length, 1);
	assert.deepEqual(after.integrationUnits, [{ id: "delivery", tasks: ["build-app"], intermediatePolicy: "coherent" }]);
	assert.equal((await store.readTask("resource-flow", "build-app")).title, "Build the revised app");
	await service.transaction("harness: patch task verification", () => service.patch("work-item:resource-flow/task:build-app", { verification: { taskChecks: ["printf hello"] } }, { authority: retain }));
	assert.deepEqual((await store.readTask("resource-flow", "build-app")).verification.taskChecks, ["printf hello"]);
	assert.equal(after.planning.status, "approved");
	assert.equal(after.planning.approvalAmendments?.at(-1)?.revision, after.planning.revision);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("single-resource patches do not require a redundant coalescing commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "single-patch", title: "Single patch", kind: "change", intent: "Patch one task." });
	await store.defineTask({ workItemId: "single-patch", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("single-patch");
	const before = await store.read("single-patch");
	await service.transaction("harness: patch one task", () => service.patch("work-item:single-patch/task:build-app", { execution: { assignment: { model: "terra" } } }, { authority: retain }));
	const after = await store.read("single-patch");
	assert.equal(after.planning.revision, before.planning.revision + 1);
	assert.equal((await store.readTask("single-patch", "build-app")).execution.assignment.model, "terra");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("patches schema-v2 artifact metadata without downgrading its representation", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "artifact-change", title: "Artifact", kind: "change", intent: "Exercise artifact patching." });
	await store.putArtifact({ workItemId: "artifact-change", id: "contract", type: "spec", narrativeSchemaVersion: 2, title: "Original", sections: { context: "One contract.", requiredBehaviors: ["Remain editable."], acceptanceCriteria: [{ id: "AC-001", statement: "Title changes preserve schema metadata." }] }, operation: "create" });
	await service.transaction("harness: patch artifact", () => service.patch("work-item:artifact-change/artifact:contract", { title: "Revised" }, { authority: retain }));
	const artifact = await store.readArtifact("artifact-change", "contract");
	assert.equal(artifact.metadata.narrativeSchemaVersion, 2);
	assert.match(artifact.content, /^# Revised/m);
});

test("deletes an undelivered task and repairs integration membership", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "remove-task", title: "Remove task", kind: "change", intent: "Exercise deletion." });
	await store.defineTask({ workItemId: "remove-task", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await service.transaction("harness: delete task", () => service.delete("work-item:remove-task/task:build-app", { authority: retain }));
	const item = await store.read("remove-task");
	assert.deepEqual(item.tasks, []); assert.deepEqual(item.integrationUnits, []);
	assert.equal((await store.reconcile("remove-task")).planning.revision, item.planning.revision);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("squashes a coherent multi-resource change into one canonical commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "batch-change", title: "Batch", kind: "change", intent: "Original intent." });
	await store.defineTask({ workItemId: "batch-change", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("batch-change"); await store.approve("batch-change");
	const beforeCount = Number(await git(root, "rev-list", "--count", "HEAD"));
	const baseline = await store.read("batch-change");
	await service.transaction("harness: coherent batch", async () => {
		await service.patch("work-item:batch-change", { title: "Revised batch" }, { authority: retain });
		await service.patch("work-item:batch-change/task:build-app", { manifest: { title: "Revised task" } }, { authority: retain });
		await service.coalesceRevision("batch-change", baseline, retain);
	});
	assert.equal(Number(await git(root, "rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal((await store.read("batch-change")).planning.revision, baseline.planning.revision + 1);
	assert.equal((await store.read("batch-change")).planning.approvalAmendments?.length, 1);
	assert.equal(await git(root, "log", "-1", "--pretty=%s"), "harness(resource-api): coherent batch");
});

test("revises and removes planned evaluations without supplemental duplicates", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "evaluation-change", title: "Evaluation", kind: "change", intent: "Exercise evaluation CRUD." });
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "browser-proof", type: "e2e", scope: { workItem: "evaluation-change" }, status: "planned", required: true, attempt: 0, methods: ["basic browser check"], criteria: [] };
	await store.defineEvaluation("evaluation-change", evaluation);
	await service.transaction("harness: revise evaluation", () => service.patch("work-item:evaluation-change/evaluation:browser-proof", { methods: ["keyboard", "reduced motion"] }, { authority: retain }));
	assert.deepEqual((await store.readEvaluation("evaluation-change", "browser-proof")).methods, ["keyboard", "reduced motion"]);
	await service.transaction("harness: remove evaluation", () => service.delete("work-item:evaluation-change/evaluation:browser-proof", { authority: retain }));
	const item = await store.read("evaluation-change");
	assert.deepEqual(item.evaluations, []);
	assert.equal((await store.reconcile("evaluation-change")).planning.revision, item.planning.revision);
});

test("rolls back every canonical commit when a batch operation fails", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "atomic-change", title: "Atomic", kind: "change", intent: "Original intent." });
	const base = await git(root, "rev-parse", "HEAD");
	await assert.rejects(service.transaction("harness: failing batch", async () => {
		await service.patch("work-item:atomic-change", { title: "Changed" }, { authority: retain });
		throw new Error("second operation failed");
	}), /second operation failed/);
	assert.equal(await git(root, "rev-parse", "HEAD"), base);
	assert.equal((await store.read("atomic-change")).title, "Atomic");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("postponement stays mutable while archive requires explicit reopen", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "lifecycle", title: "Lifecycle", kind: "story", intent: "Exercise lifecycle." });
	await store.transitionWorkItem("lifecycle", "postpone", "Not scheduled yet");
	await service.transaction("harness: edit postponed", () => service.patch("work-item:lifecycle", { title: "Still mutable" }, { authority: retain }));
	await store.transitionWorkItem("lifecycle", "archive", "Explicitly finalized");
	await assert.rejects(service.patch("work-item:lifecycle", { title: "Rejected" }, { authority: retain }), /finalized/);
	await store.transitionWorkItem("lifecycle", "reopen", "New evidence warrants reopening");
	assert.equal((await store.read("lifecycle")).state, "active");
});
