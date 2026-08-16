import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildReviewPersistentContext, buildTaskPersistentContext } from "../implementation-context.js";
import { OrchestratorResourceService } from "../orchestrator-resources.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout.trim(); }
async function repository(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pibox-resource-api-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet"); await git(root, "config", "user.name", "Resource Test"); await git(root, "config", "user.email", "resource@example.test");
	await writeFile(join(root, "README.md"), "# Fixture\n"); await git(root, "add", "."); await git(root, "commit", "--quiet", "-m", "initial"); await git(root, "branch", "-M", "develop");
	return root;
}
function task(id = "build-app"): TaskManifest {
	return { schemaVersion: 1, id, title: "Build app", status: "ready", dependsOn: [], references: { specs: [], designs: [], decisions: [] }, execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "medium", rationale: "bounded" } }, assembly: { integrationUnit: "app", intermediateState: "complete" }, verification: { timing: "integration-unit", methods: ["test"], taskChecks: ["test -f app.txt"], rationale: "assembled" } };
}
const mutation = { rationale: "Resolve an implementation detail within delegated intent", sources: ["agent-message:change-1"] };

test("builds a focused persistent implementation packet", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "context-packet", title: "Context packet", kind: "change", intent: "Broad intent that referenced context makes unnecessary." });
	await store.putArtifact({ workItemId: "context-packet", id: "behavior", type: "spec", content: "# Behavior\n\n## Acceptance Criteria\n\n- **AC-001:** The app writes hello.\n- **AC-002:** The app deletes every record.\n", operation: "create" });
	await store.putArtifact({ workItemId: "context-packet", id: "architecture", type: "design", content: "# Architecture\n\nBroad design details that this bounded task does not need.", operation: "create" });
	const manifest = task(); manifest.references!.specs = ["behavior"]; manifest.references!.designs = ["architecture"];
	await store.defineTask({ workItemId: "context-packet", manifest, brief: "# Brief\n\nCreate the app using the assigned design boundary.", acceptance: "# Acceptance\n\nDeliver behavior#AC-001." });
	const packet = await buildTaskPersistentContext(store, "context-packet", manifest);
	assert.match(packet, /Persistent Implementation Context/);
	assert.match(packet, /Create the app/);
	assert.match(packet, /behavior#AC-001/);
	assert.match(packet, /Assigned acceptance criteria: behavior/);
	assert.match(packet, /The app writes hello/);
	assert.doesNotMatch(packet, /deletes every record|Broad design details/);
	assert.match(packet, /task_clarify.*broader design/i);
	assert.match(packet, /test -f app\.txt/);
	assert.doesNotMatch(packet, /Broad intent|planning revision|sha256|assignment rationale/i);
});

test("uses a self-contained task contract without eagerly loading story artifacts", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "self-contained", title: "Self-contained task", kind: "change", intent: "Broad story intent available through task_clarify." });
	await store.putArtifact({ workItemId: "self-contained", id: "architecture", type: "design", content: "# Architecture\n\nOptional broader design.", operation: "create" });
	const manifest = task("implement-slice");
	delete manifest.references;
	await store.defineTask({
		workItemId: "self-contained", manifest, narrativeSchemaVersion: 2,
		briefSections: { contributionGoal: "Deliver one complete slice.", context: ["The existing command owns this behavior."], boundaryIncluded: ["Update the command"], requiredWork: ["Implement and test the command"], integrationExpectation: "Ready for direct integration." },
		acceptanceSections: { deliverables: ["Working command"], acceptance: ["The command produces the required result."], boundaryProof: ["Focused command test passes"] },
	});
	const packet = await buildTaskPersistentContext(store, "self-contained", manifest);
	assert.match(packet, /authoritative, self-contained assignment/i);
	assert.match(packet, /The existing command owns this behavior/);
	assert.match(packet, /The command produces the required result/);
	assert.match(packet, /task_clarify.*additional intent/i);
	assert.doesNotMatch(packet, /Broad story intent|Optional broader design/);
});

test("includes the exact E2E matrix only for E2E reviewer context", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "matrix-context", title: "Matrix context", kind: "story", intent: "Exercise matrix context." });
	await store.putArtifact({ workItemId: "matrix-context", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Approved Matrix", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "exact approved content", setup: ["Prepare fixture"], actions: ["Run journey"], expectedOutcomes: ["Journey succeeds"], evidence: ["Record observable result"] }] }, operation: "create" });
	const e2e: EvaluationManifest = { schemaVersion: 1, id: "final-e2e", type: "e2e", scope: { workItem: "matrix-context" }, status: "planned", required: true, attempt: 0, methods: [] };
	const review: EvaluationManifest = { ...e2e, id: "review", type: "combined-review" };
	assert.match(await buildReviewPersistentContext(store, "matrix-context", e2e), /exact approved content/);
	assert.doesNotMatch(await buildReviewPersistentContext(store, "matrix-context", review), /exact approved content/);
});

test("builds durable reviewer context from scoped tasks and full plan artifacts", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "review-context", title: "Review context", kind: "change", intent: "Ship plan-conformant behavior." });
	await store.putArtifact({ workItemId: "review-context", id: "behavior", type: "spec", content: "# Behavior\n\n- **AC-001:** Render the durable result.", operation: "create" });
	await store.putArtifact({ workItemId: "review-context", id: "architecture", type: "design", content: "# Architecture\n\nUse the durable boundary design.", operation: "create" });
	const manifest = task(); manifest.references!.specs = ["behavior"]; manifest.references!.designs = ["architecture"];
	await store.defineTask({ workItemId: "review-context", manifest, brief: "# Brief\n\nImplement the durable result.", acceptance: "# Acceptance\n\nDeliver behavior#AC-001." });
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "review", type: "combined-review", scope: { task: manifest.id }, status: "planned", required: true, attempt: 0, methods: ["review"] };
	const packet = await buildReviewPersistentContext(store, "review-context", evaluation);
	assert.match(packet, /Persistent Review Context/);
	assert.match(packet, /build-app — Build app/);
	assert.match(packet, /Implement the durable result/);
	assert.match(packet, /Render the durable result/);
	assert.match(packet, /durable boundary design/);
	assert.match(packet, /across compaction and resumed attempts/i);
});

test("lists compact resource summaries without embedding complete task contracts", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "summary-flow", title: "Summary flow", kind: "change", intent: "A very broad intent that should not appear in catalogs." });
	await store.defineTask({ workItemId: "summary-flow", manifest: task(), brief: "A very long implementation brief that should only appear in bounded detail reads.", acceptance: "A very long acceptance contract that should only appear in bounded detail reads." });
	const items = await service.listSummaries("work-item");
	assert.deepEqual(items[0]?.counts, { artifacts: 1, tasks: 1, stages: 1, evaluations: 0 });
	assert.equal("resource" in items[0]!, false);
	const tasks = await service.listSummaries("task", "summary-flow");
	assert.equal(tasks[0]?.stageId, "app");
	assert.equal(JSON.stringify(tasks).includes("very long implementation brief"), false);
	assert.deepEqual((await service.summary("work-item:summary-flow/task:build-app")).availableViews, ["summary", "full"]);
});

test("revises a reviewed task in place without an approval lifecycle", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "resource-flow", title: "Resource flow", kind: "change", intent: "Deliver one app." });
	await store.defineTask({ workItemId: "resource-flow", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("resource-flow");
	await service.transaction("harness: revise task", () => service.patch("work-item:resource-flow/task:build-app", { manifest: { title: "Build the revised app", assembly: { integrationUnit: "delivery" } } }, { authority: mutation }));
	const after = await store.read("resource-flow");
	assert.equal(after.tasks.length, 1);
	assert.deepEqual(after.executionStages, [{ id: "delivery", tasks: ["build-app"] }]);
	assert.equal((await store.readTask("resource-flow", "build-app")).title, "Build the revised app");
	assert.match((await store.readTaskContract("resource-flow", "build-app")).brief, /Build it/);
	await service.transaction("harness: patch task verification", () => service.patch("work-item:resource-flow/task:build-app", { verification: { taskChecks: ["printf hello"] } }, { authority: mutation }));
	assert.deepEqual((await store.readTask("resource-flow", "build-app")).verification.taskChecks, ["printf hello"]);
	assert.deepEqual(Object.keys((await store.read("resource-flow")).planning), ["revision"]);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("single-resource patches do not require a redundant coalescing commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "single-patch", title: "Single patch", kind: "change", intent: "Patch one task." });
	await store.defineTask({ workItemId: "single-patch", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("single-patch");
	const before = await store.read("single-patch");
	await service.transaction("harness: patch one task", () => service.patch("work-item:single-patch/task:build-app", { execution: { assignment: { tier: "high" } } }, { authority: mutation }));
	const after = await store.read("single-patch");
	assert.equal(after.planning.revision, before.planning.revision + 1);
	const assignment = (await store.readTask("single-patch", "build-app")).execution.assignment;
	assert.equal("tier" in assignment ? assignment.tier : undefined, "high");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("patches schema-v2 artifact metadata without downgrading its representation", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "artifact-change", title: "Artifact", kind: "change", intent: "Exercise artifact patching." });
	await store.putArtifact({ workItemId: "artifact-change", id: "contract", type: "spec", narrativeSchemaVersion: 2, title: "Original", sections: { context: "One contract.", requiredBehaviors: ["Remain editable."], acceptanceCriteria: [{ id: "AC-001", statement: "Title changes preserve schema metadata." }] }, operation: "create" });
	await service.transaction("harness: patch artifact", () => service.patch("work-item:artifact-change/artifact:contract", { title: "Revised" }, { authority: mutation }));
	const artifact = await store.readArtifact("artifact-change", "contract");
	assert.equal(artifact.metadata.narrativeSchemaVersion, 2);
	assert.match(artifact.content, /^# Revised/m);
});

test("deletes an undelivered task and repairs integration membership", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "remove-task", title: "Remove task", kind: "change", intent: "Exercise deletion." });
	await store.defineTask({ workItemId: "remove-task", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await service.transaction("harness: delete task", () => service.delete("work-item:remove-task/task:build-app", { authority: mutation }));
	const item = await store.read("remove-task");
	assert.deepEqual(item.tasks, []); assert.deepEqual(item.integrationUnits, []);
	assert.equal((await store.reconcile("remove-task")).planning.revision, item.planning.revision);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("squashes a coherent multi-resource change into one canonical commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "batch-change", title: "Batch", kind: "change", intent: "Original intent." });
	await store.defineTask({ workItemId: "batch-change", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await store.submitPlanning("batch-change");
	const beforeCount = Number(await git(root, "rev-list", "--count", "HEAD"));
	const baseline = await store.read("batch-change");
	await service.transaction("harness: coherent batch", async () => {
		await service.patch("work-item:batch-change", { title: "Revised batch" }, { authority: mutation });
		await service.patch("work-item:batch-change/task:build-app", { manifest: { title: "Revised task" } }, { authority: mutation });
		await service.coalesceRevision("batch-change", baseline, mutation);
	});
	assert.equal(Number(await git(root, "rev-list", "--count", "HEAD")), beforeCount + 1);
	assert.equal((await store.read("batch-change")).planning.revision, baseline.planning.revision + 1);
	assert.deepEqual(Object.keys((await store.read("batch-change")).planning), ["revision"]);
	assert.equal(await git(root, "log", "-1", "--pretty=%s"), "harness(resource-api): coherent batch");
});

test("revises and removes planned evaluations without supplemental duplicates", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "evaluation-change", title: "Evaluation", kind: "change", intent: "Exercise evaluation CRUD." });
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "browser-proof", type: "e2e", scope: { workItem: "evaluation-change" }, status: "planned", required: true, attempt: 0, methods: ["basic browser check"], criteria: [] };
	await store.defineEvaluation("evaluation-change", evaluation);
	await service.transaction("harness: revise evaluation", () => service.patch("work-item:evaluation-change/evaluation:browser-proof", { methods: ["keyboard", "reduced motion"] }, { authority: mutation }));
	assert.deepEqual((await store.readEvaluation("evaluation-change", "browser-proof")).methods, ["keyboard", "reduced motion"]);
	await service.transaction("harness: remove evaluation", () => service.delete("work-item:evaluation-change/evaluation:browser-proof", { authority: mutation }));
	const item = await store.read("evaluation-change");
	assert.deepEqual(item.evaluations, []);
	assert.equal((await store.reconcile("evaluation-change")).planning.revision, item.planning.revision);
});

test("rolls back every canonical commit when a batch operation fails", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "atomic-change", title: "Atomic", kind: "change", intent: "Original intent." });
	const base = await git(root, "rev-parse", "HEAD");
	await assert.rejects(service.transaction("harness: failing batch", async () => {
		await service.patch("work-item:atomic-change", { title: "Changed" }, { authority: mutation });
		throw new Error("second operation failed");
	}), /second operation failed/);
	assert.equal(await git(root, "rev-parse", "HEAD"), base);
	assert.equal((await store.read("atomic-change")).title, "Atomic");
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("writes complete plans with explicit create and revision-pinned update identity", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	const spec = { id: "behavior", type: "spec", content: "# Behavior\n\n## Acceptance Criteria\n\n- **AC-001:** The app works.\n" };
	const firstTask = { manifest: task("first-task"), brief: "Build the first behavior.", acceptance: "It works." };
	firstTask.manifest.assembly = { stageId: "first-stage", intermediateState: "complete" };
	const createPlan = {
		workItem: { id: "fresh-plan", title: "Fresh plan", kind: "change", branchKind: "feature", intent: "Create a fresh plan." },
		artifacts: [spec], tasks: [firstTask], integrationUnits: [{ id: "delivery", tasks: ["first-task"], intermediatePolicy: "coherent" }], evaluations: [],
	};
	const createBase = await git(root, "rev-parse", "HEAD");
	await assert.rejects(service.transaction("harness: reject invalid complete plan", () => service.writePlan({ mode: "create", plan: { ...createPlan, workItem: { ...createPlan.workItem, id: "broken-plan" }, tasks: [{ ...firstTask, manifest: { ...firstTask.manifest, references: { specs: ["missing-spec"], designs: [], decisions: [] } } }] } }, mutation)), /Unknown spec reference/);
	assert.equal(await git(root, "rev-parse", "HEAD"), createBase);
	await assert.rejects(store.read("broken-plan"), /does not exist/);
	await service.transaction("harness: create complete plan", () => service.writePlan({ mode: "create", plan: createPlan }, mutation));
	const created = await store.read("fresh-plan");
	assert.deepEqual(created.tasks.map((entry) => entry.id), ["first-task"]);
	const staleRevision = created.planning.revision;
	const secondTask = { manifest: task("second-task"), brief: "Build the replacement behavior.", acceptance: "It works better." };
	secondTask.manifest.assembly = { stageId: "second-stage", intermediateState: "complete" };
	const updatePlan = { ...createPlan, workItem: { ...createPlan.workItem, title: "Replaced plan" }, tasks: [secondTask], integrationUnits: [{ id: "delivery-v2", tasks: ["second-task"], intermediatePolicy: "coherent" }] };
	await service.transaction("harness: update complete plan", () => service.writePlan({ mode: "update", target: "work-item:fresh-plan", expectedRevision: staleRevision, plan: updatePlan }, mutation));
	const updated = await store.read("fresh-plan");
	assert.equal(updated.title, "Replaced plan");
	assert.deepEqual(updated.tasks.map((entry) => entry.id), ["second-task"]);
	assert.deepEqual(updated.integrationUnits.map((entry) => entry.id), ["delivery-v2"]);
	await assert.rejects(service.writePlan({ mode: "update", target: "work-item:fresh-plan", expectedRevision: staleRevision, plan: updatePlan }, mutation), /advanced from requested revision/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("returns the complete work-item plan for durable review", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "review-plan", title: "Review plan", kind: "story", intent: "Review all plan contracts." });
	await store.putArtifact({ workItemId: "review-plan", id: "behavior", type: "spec", content: "# Behavior\n\nOne behavior.", operation: "create" });
	await store.defineTask({ workItemId: "review-plan", manifest: task("review-task"), brief: "Structured worker boundary.", acceptance: "Observable worker proof." });
	const full = await service.get("work-item:review-plan") as any;
	assert.equal(full.revision, (await store.read("review-plan")).planning.revision);
	assert.equal(full.resource.artifacts.find((entry: any) => entry.id === "behavior").content.includes("One behavior"), true);
	assert.equal(full.resource.tasks[0].brief.includes("Structured worker boundary"), true);
	assert.equal(full.resource.tasks[0].acceptance.includes("Observable worker proof"), true);
});

test("applies surgical plan edits in one revision and rejects stale edits", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "surgical-plan", title: "Surgical plan", kind: "story", intent: "Correct one written plan." });
	await store.defineTask({ workItemId: "surgical-plan", manifest: task("build-app"), brief: "Original structured boundary.", acceptance: "Original observable proof." });
	const baseline = await store.read("surgical-plan");
	const revisedManifest = task("build-app"); revisedManifest.title = "Build corrected app";
	await service.transaction("harness: edit plan", () => service.editPlan("work-item:surgical-plan", baseline.planning.revision, [
		{ action: "update", ref: "work-item:surgical-plan", value: { title: "Corrected plan" } },
		{ action: "update", ref: "work-item:surgical-plan/task:build-app", value: { manifest: revisedManifest, brief: "Corrected structured boundary.", acceptance: "Corrected observable proof." } },
	], mutation));
	const revised = await store.read("surgical-plan");
	assert.equal(revised.planning.revision, baseline.planning.revision + 1);
	assert.equal(revised.title, "Corrected plan");
	assert.equal((await store.readTask("surgical-plan", "build-app")).title, "Build corrected app");
	assert.match((await store.readTaskContract("surgical-plan", "build-app")).brief, /Corrected structured boundary/);
	await assert.rejects(service.editPlan("work-item:surgical-plan", baseline.planning.revision, [{ action: "update", ref: "work-item:surgical-plan", value: { title: "Stale" } }], mutation), /advanced from requested revision/);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("requires surgical create ids to match their exact refs", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "edit-identity", title: "Edit identity", kind: "story", intent: "Keep edit refs exact." });
	const revision = (await store.read("edit-identity")).planning.revision;
	await assert.rejects(service.transaction("harness: reject mismatched edit", () => service.editPlan("work-item:edit-identity", revision, [
		{ action: "update", ref: "work-item:edit-identity", value: { title: "Must roll back" } },
		{ action: "create", ref: "work-item:edit-identity/task:expected", value: { manifest: task("different"), brief: "Brief", acceptance: "Proof" } },
	], mutation)), /must match edit ref/);
	const unchanged = await store.read("edit-identity");
	assert.equal(unchanged.title, "Edit identity");
	assert.equal(unchanged.planning.revision, revision);
	assert.deepEqual(unchanged.tasks, []);
});

test("postponement stays mutable while archive requires explicit reopen", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "lifecycle", title: "Lifecycle", kind: "story", intent: "Exercise lifecycle." });
	await store.transitionWorkItem("lifecycle", "postpone", "Not scheduled yet");
	await service.transaction("harness: edit postponed", () => service.patch("work-item:lifecycle", { title: "Still mutable" }, { authority: mutation }));
	await store.transitionWorkItem("lifecycle", "archive", "Explicitly finalized");
	await assert.rejects(service.patch("work-item:lifecycle", { title: "Rejected" }, { authority: mutation }), /finalized/);
	await store.transitionWorkItem("lifecycle", "reopen", "New evidence warrants reopening");
	assert.equal((await store.read("lifecycle")).state, "active");
});
