import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { REVIEW_CONTEXT_BUDGET_BYTES, TASK_CONTEXT_BUDGET_BYTES, buildReviewAttemptContext, buildReviewPersistentContext, buildTaskPersistentContext } from "../implementation-context.js";
import { OrchestratorResourceService } from "../orchestrator-resources.js";
import type { EvaluationManifest, TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";
import { WorkflowLedgerStore } from "../workflow-ledger.js";

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

test("completed reopen forks an editable linked amendment and keeps baseline immutable", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "delivered-baseline", title: "Delivered baseline", kind: "story", intent: "Ship the original behavior." });
	await store.putArtifact({ workItemId: "delivered-baseline", id: "baseline-journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Baseline journeys", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "Original behavior remains operational", setup: ["Prepare baseline"], actions: ["Exercise baseline"], expectedOutcomes: ["Baseline passes"], evidence: ["Record baseline result"] }] }, operation: "create" });
	await store.completeWorkItem("delivered-baseline", "# Outcome\n\nDelivered.");
	const baseline = await store.read("delivered-baseline");
	await assert.rejects(service.patch("work-item:delivered-baseline", { title: "Unsafe rewrite" }, { authority: mutation }), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.match(error.message, /complete and immutable.*workflow_transition.*reopen.*returned amendment work-item ref/i);
		const details = (error as any).details;
		assert.equal(details.guidance.tool, "workflow_transition");
		assert.equal(details.guidance.arguments.action, "reopen");
		return true;
	});

	const amendment = await store.transitionWorkItem("delivered-baseline", "reopen", "Add the follow-up behavior");
	assert.equal(amendment.id, "delivered-baseline-amendment-1");
	assert.equal(amendment.phase, "planning");
	assert.equal(amendment.amendment?.baselineWorkItemId, "delivered-baseline");
	assert.equal(amendment.amendment?.rootWorkItemId, "delivered-baseline");
	assert.equal(amendment.amendment?.generation, 1);
	assert.equal(amendment.amendment?.baselineRevision, baseline.planning.revision);
	assert.equal((await store.read("delivered-baseline")).phase, "complete");
	await service.transaction("harness: edit amendment", () => service.patch("work-item:delivered-baseline-amendment-1", { title: "Editable amendment" }, { authority: mutation }));
	assert.equal((await store.read("delivered-baseline-amendment-1")).title, "Editable amendment");
	assert.deepEqual((await service.summary("work-item:delivered-baseline") as any).amendments, ["work-item:delivered-baseline-amendment-1"]);
	assert.match((await store.readE2EMatrix("delivered-baseline-amendment-1"))?.content ?? "", /Original behavior remains operational/);
	const e2e: EvaluationManifest = { schemaVersion: 1, id: "amendment-e2e", type: "e2e", scope: { workItem: amendment.id }, status: "planned", required: true, attempt: 0, methods: [] };
	const context = await buildReviewPersistentContext(store, amendment.id, e2e);
	assert.match(context, /immutable amendment baseline: delivered-baseline\/e2e-matrix:baseline-journeys/);
	assert.match(context, /Original behavior remains operational/);
	assert.match(context, /current amendment: delivered-baseline-amendment-1\/intent:intent/);
	await store.completeWorkItem(amendment.id, "# Outcome\n\nAmendment delivered.");
	const second = await store.transitionWorkItem(amendment.id, "reopen", "Add another follow-up");
	assert.equal(second.id, "delivered-baseline-amendment-2");
	assert.equal(second.amendment?.baselineWorkItemId, amendment.id);
	assert.equal(second.amendment?.rootWorkItemId, "delivered-baseline");
	assert.equal(second.amendment?.generation, 2);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("resource creation continues the checked-out fix branch when branch hints are omitted", async (t) => {
	const root = await repository(t);
	await git(root, "switch", "-c", "fix/ongoing");
	const store = new WorkItemStore(root);
	const service = new OrchestratorResourceService(root, store);
	const createdFromCommit = await git(root, "rev-parse", "HEAD");
	const item = await service.create("work-item", undefined, { id: "follow-up-fix", title: "Follow-up fix", kind: "change", intent: "Continue the current fix branch." }, mutation) as Awaited<ReturnType<WorkItemStore["create"]>>;
	assert.equal(item.delivery?.workingBranch, "fix/ongoing");
	assert.equal(item.delivery?.createdFromCommit, createdFromCommit);
	assert.equal(await git(root, "branch", "--show-current"), "fix/ongoing");
});

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
	assert.doesNotMatch(packet, /Broad intent|planning revision|assignment rationale/i);
	assert.match(packet, new RegExp(`budgetBytes: ${TASK_CONTEXT_BUDGET_BYTES}`));
	assert.match(packet, /Context Source Manifest[\s\S]+digest: sha256:/);
	assert.ok(Buffer.byteLength(packet, "utf8") <= TASK_CONTEXT_BUDGET_BYTES);
});

test("fails closed when complete task requirements exceed the explicit context budget", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "budgeted-task", title: "Budgeted task", kind: "change", intent: "Budget context." });
	const manifest = task("oversized"); delete manifest.references;
	await store.defineTask({ workItemId: "budgeted-task", manifest, brief: `Required ${"x".repeat(400)}`, acceptance: "Must remain complete." });
	await assert.rejects(buildTaskPersistentContext(store, "budgeted-task", manifest, { maxBytes: 256 }), /exceeding its explicit 256-byte budget; requirements were not truncated/);
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

test("includes the exact E2E matrix for E2E and whole-branch reviewer context", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "matrix-context", title: "Matrix context", kind: "story", intent: "Exercise matrix context." });
	await store.putArtifact({ workItemId: "matrix-context", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Approved Matrix", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "exact approved content", setup: ["Prepare fixture"], actions: ["Run journey"], expectedOutcomes: ["Journey succeeds"], evidence: ["Record observable result"] }] }, operation: "create" });
	const e2e: EvaluationManifest = { schemaVersion: 1, id: "final-e2e", type: "e2e", scope: { workItem: "matrix-context" }, status: "planned", required: true, attempt: 0, methods: [] };
	const review: EvaluationManifest = { ...e2e, id: "review", type: "combined-review", checkpoint: "final-review" };
	const scopedReview: EvaluationManifest = { ...e2e, id: "scoped-review", type: "combined-review" };
	assert.match(await buildReviewPersistentContext(store, "matrix-context", e2e), /exact approved content/);
	assert.match(await buildReviewPersistentContext(store, "matrix-context", review), /exact approved content/);
	assert.doesNotMatch(await buildReviewPersistentContext(store, "matrix-context", scopedReview), /exact approved content/);
	await assert.rejects(
		buildReviewPersistentContext(store, "matrix-context", { ...e2e, context: { taskIds: [], artifactRefs: [{ workItemId: "matrix-context", artifactId: "intent" }] } }),
		/context artifact selection must exactly match its canonical review scope/,
		"an explicit E2E scope cannot omit the required matrix",
	);
});

test("idempotently generates one required review per execution stage before final gates", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "generated-reviews", title: "Generated reviews", kind: "story", intent: "Generate deterministic gates." });
	await store.putArtifact({ workItemId: "generated-reviews", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Journeys", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "Run", setup: ["Setup"], actions: ["Act"], expectedOutcomes: ["Pass"], evidence: ["Observe"] }] }, operation: "create" });
	const first = task("first"); first.assembly.stageId = "delivery";
	await store.defineTask({ workItemId: "generated-reviews", manifest: first, brief: "Implement", acceptance: "Works" });
	await store.putExecutionStage("generated-reviews", { id: "delivery", tasks: ["first"], checks: ["npm test -- focused"], review: { tier: "high", focus: ["Concurrency state transitions and durable recovery behavior"], rationale: "Medium is insufficient because this state machine has cross-process recovery races." } }, mutation);
	await store.ensureFinalEvaluations("generated-reviews", 2);
	await store.ensureFinalEvaluations("generated-reviews", 2);
	const item = await store.read("generated-reviews");
	assert.deepEqual(item.evaluations.map(({ id }) => id), ["stage-delivery-review", "final-branch-review", "final-e2e"]);
	await assert.rejects(readFile(join(root, "agent-artifacts", "generated-reviews", "evaluations", "final-branch-review", "report.md")), /ENOENT/, "generated checkpoints do not create pending reports");
	const stageReview = await store.readEvaluation("generated-reviews", "stage-delivery-review");
	assert.equal(stageReview.required, true);
	assert.equal(stageReview.checkpoint, "stage-review");
	assert.deepEqual(stageReview.methods, ["npm test -- focused"]);
});

test("omits only explicitly skipped stage reviews while preserving final gates", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "selective-reviews", title: "Selective reviews", kind: "story", intent: "Review risk selectively." });
	await store.putArtifact({ workItemId: "selective-reviews", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Journeys", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "Run", setup: ["Setup"], actions: ["Act"], expectedOutcomes: ["Pass"], evidence: ["Observe"] }] }, operation: "create" });
	const mechanical = task("mechanical-task"); mechanical.assembly.stageId = "mechanical";
	await store.defineTask({ workItemId: "selective-reviews", manifest: mechanical, brief: "Mechanical change", acceptance: "Focused check passes" });
	await store.putExecutionStage("selective-reviews", { id: "mechanical", tasks: ["mechanical-task"], checks: ["test -f README.md"], review: { mode: "skip", rationale: "Local mechanical behavior is completely covered by its deterministic check." } }, mutation);
	await store.ensureFinalEvaluations("selective-reviews", 2);
	const item = await store.read("selective-reviews");
	assert.deepEqual(item.evaluations.map(({ id }) => id), ["final-branch-review", "final-e2e"]);
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

test("gives whole-branch review the exact execution diff and complete matrix", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "whole-branch", title: "Whole branch", kind: "story", intent: "Review the assembled feature." });
	await store.putArtifact({ workItemId: "whole-branch", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Whole journey", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "Integrated behavior", setup: ["Setup"], actions: ["Act"], expectedOutcomes: ["Pass"], evidence: ["Observe"] }] }, operation: "create" });
	await store.beginExecution("whole-branch");
	const item = await store.read("whole-branch");
	const head = await git(root, "rev-parse", "HEAD");
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "final-branch-review", type: "combined-review", checkpoint: "final-review", scope: { workItem: "whole-branch" }, status: "planned", required: true, attempt: 0, methods: [] };
	const packet = await buildReviewPersistentContext(store, "whole-branch", evaluation);
	const attempt = await buildReviewAttemptContext(store, "whole-branch", evaluation, head);
	assert.doesNotMatch(packet, new RegExp(`${item.delivery!.executionStartCommit}\\.\\.${head}`));
	assert.match(attempt, new RegExp(`${item.delivery!.executionStartCommit}\\.\\.${head}`));
	assert.match(`${packet}\n${attempt}`, /one integrated change|Integrated behavior/);
});

test("bounds stage review context to its tasks, story artifacts, checks, focus, and reviewed commit", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "stage-context", title: "Stage context", kind: "story", intent: "Story intent." });
	await store.putArtifact({ workItemId: "stage-context", id: "behavior", type: "spec", content: "# Behavior\n\nRequired story behavior.", operation: "create" });
	const first = task("first-task"); first.assembly.stageId = "first";
	const second = task("second-task"); second.assembly.stageId = "second";
	await store.defineTask({ workItemId: "stage-context", manifest: first, brief: "First brief", acceptance: "First acceptance" });
	await store.defineTask({ workItemId: "stage-context", manifest: second, brief: "Second brief must be excluded", acceptance: "Second acceptance" });
	await store.putExecutionStage("stage-context", { id: "first", tasks: ["first-task"], checks: ["npm test -- first"], review: { tier: "medium", focus: ["First-stage state transition correctness"] } }, mutation);
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "stage-first-review", type: "combined-review", checkpoint: "stage-review", stageId: "first", scope: { workItem: "stage-context" }, status: "planned", required: true, attempt: 0, methods: [] };
	const packet = await buildReviewPersistentContext(store, "stage-context", evaluation);
	const attempt = await buildReviewAttemptContext(store, "stage-context", evaluation, "a".repeat(40));
	assert.match(packet, /first-task|First brief|Story intent|Required story behavior|npm test -- first|First-stage state transition correctness/);
	assert.match(packet, new RegExp(`budgetBytes: ${REVIEW_CONTEXT_BUDGET_BYTES}`));
	assert.ok(Buffer.byteLength(packet, "utf8") <= REVIEW_CONTEXT_BUDGET_BYTES);
	assert.doesNotMatch(packet, new RegExp("a{40}"));
	assert.match(attempt, new RegExp("a{40}"));
	assert.doesNotMatch(packet, /second-task|Second brief/);
});

test("generated stage scope selects assigned contracts and directly relevant artifacts while legacy manifests remain readable", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "scoped-context", title: "Scoped context", kind: "story", intent: "Relevant intent." });
	await store.putArtifact({ workItemId: "scoped-context", id: "relevant-spec", type: "spec", content: "# Relevant\n\nRelevant requirement.", operation: "create" });
	await store.putArtifact({ workItemId: "scoped-context", id: "unrelated-design", type: "design", content: "# Unrelated\n\nMust not be injected.", operation: "create" });
	await store.putArtifact({ workItemId: "scoped-context", id: "journeys", type: "e2e-matrix", narrativeSchemaVersion: 2, title: "Journeys", sections: { cases: [{ id: "E2E-001", classification: "golden-path", journey: "Run", setup: ["Setup"], actions: ["Act"], expectedOutcomes: ["Pass"], evidence: ["Observe"] }] }, operation: "create" });
	const assigned = task("assigned"); assigned.assembly.stageId = "delivery"; assigned.references = { specs: ["relevant-spec"], designs: [], decisions: [] };
	const unrelated = task("unrelated"); unrelated.assembly.stageId = "later"; unrelated.references = { specs: [], designs: ["unrelated-design"], decisions: [] };
	await store.defineTask({ workItemId: "scoped-context", manifest: assigned, brief: "Assigned brief", acceptance: "Assigned acceptance" });
	await store.defineTask({ workItemId: "scoped-context", manifest: unrelated, brief: "Unrelated brief", acceptance: "Unrelated acceptance" });
	await store.putExecutionStage("scoped-context", { id: "delivery", tasks: ["assigned"], review: { tier: "medium" } }, mutation);
	await store.putExecutionStage("scoped-context", { id: "later", tasks: ["unrelated"], review: { mode: "skip", rationale: "The later fixture is outside this focused review boundary." } }, mutation);
	await store.ensureFinalEvaluations("scoped-context");
	const generated = await store.readEvaluation("scoped-context", "stage-delivery-review");
	assert.deepEqual(generated.context?.taskIds, ["assigned"]);
	assert.deepEqual(generated.context?.artifactRefs.map((ref) => ref.artifactId), ["intent", "relevant-spec"]);
	const scoped = await buildReviewPersistentContext(store, "scoped-context", generated);
	assert.match(scoped, /Assigned brief|Relevant requirement|Relevant intent/);
	assert.doesNotMatch(scoped, /Unrelated brief|Must not be injected/);
	await assert.rejects(
		buildReviewPersistentContext(store, "scoped-context", { ...generated, context: { ...generated.context!, taskIds: ["assigned", "unrelated"] } }),
		/context task selection must exactly match its assigned contracts/,
	);
	await assert.rejects(
		buildReviewPersistentContext(store, "scoped-context", { ...generated, context: { ...generated.context!, artifactRefs: [{ workItemId: "scoped-context", artifactId: "relevant-spec" }] } }),
		/context artifact selection must exactly match its canonical review scope/,
		"the current intent is mandatory",
	);
	await assert.rejects(
		buildReviewPersistentContext(store, "scoped-context", { ...generated, context: { ...generated.context!, artifactRefs: [{ workItemId: "scoped-context", artifactId: "intent" }] } }),
		/context artifact selection must exactly match its canonical review scope/,
		"scoped task references are mandatory",
	);
	await assert.rejects(
		buildReviewPersistentContext(store, "scoped-context", { ...generated, context: { ...generated.context!, artifactRefs: [...generated.context!.artifactRefs, { workItemId: "scoped-context", artifactId: "unrelated-design" }] } }),
		/context artifact selection must exactly match its canonical review scope/,
		"an explicit scope cannot broaden itself with unrelated artifacts",
	);
	const { context: _context, ...legacyBase } = generated;
	const legacy: EvaluationManifest = { ...legacyBase, id: "legacy" };
	const compatible = await buildReviewPersistentContext(store, "scoped-context", legacy);
	assert.match(compatible, /Must not be injected/, "stored manifests without context retain the bounded compatibility reader");
});

test("review context fails closed instead of silently truncating requirements and never injects the on-demand ledger", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root);
	await store.create({ id: "review-budget", title: "Review budget", kind: "story", intent: `Required ${"z".repeat(500)}` });
	const manifest = task("reviewed");
	await store.defineTask({ workItemId: "review-budget", manifest, brief: "Review brief", acceptance: "Review acceptance" });
	const evaluation: EvaluationManifest = { schemaVersion: 1, id: "review", type: "combined-review", scope: { task: manifest.id }, status: "planned", required: true, attempt: 0, methods: [] };
	await assert.rejects(buildReviewPersistentContext(store, "review-budget", evaluation, { maxBytes: 300 }), /requirements were not truncated/);
	const ledgerMarker = "LEDGER-MARKER-MUST-BE-ON-DEMAND";
	await new WorkflowLedgerStore({ id: "repo", root, privateRoot: store.privateRoot }, "review-budget").append({ schemaVersion: 1, id: "entry", at: new Date(0).toISOString(), role: "implementer", text: ledgerMarker });
	const packet = await buildReviewPersistentContext(store, "review-budget", evaluation);
	assert.doesNotMatch(packet, new RegExp(ledgerMarker));
});

test("lists compact resource summaries without embedding complete task contracts", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "summary-flow", title: "Summary flow", kind: "change", intent: "A very broad intent that should not appear in catalogs." });
	await store.defineTask({ workItemId: "summary-flow", manifest: task(), brief: "A very long implementation brief that should only appear in bounded detail reads.", acceptance: "A very long acceptance contract that should only appear in bounded detail reads." });
	await store.putExecutionStage("summary-flow", { id: "app", tasks: ["build-app"], mode: "concurrent" }, mutation);
	const items = await service.listSummaries("work-item");
	assert.deepEqual(items[0]?.counts, { artifacts: 1, tasks: 1, stages: 1, evaluations: 0 });
	assert.equal("resource" in items[0]!, false);
	const tasks = await service.listSummaries("task", "summary-flow");
	assert.equal(tasks[0]?.stageId, "app");
	const stages = await service.listSummaries("stage", "summary-flow");
	assert.equal(stages[0]?.mode, "concurrent");
	assert.equal(JSON.stringify(tasks).includes("very long implementation brief"), false);
	assert.deepEqual((await service.summary("work-item:summary-flow/task:build-app")).availableViews, ["summary", "full"]);
});

test("resolves legacy stage modes in resource summaries", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "legacy-stage-summary", title: "Legacy stages", kind: "change", intent: "Expose resolved stage topology." });
	const first = task("legacy-singleton"); first.assembly.stageId = "legacy-single";
	const second = task("legacy-first"); second.assembly.stageId = "legacy-multi";
	const third = task("legacy-second"); third.assembly.stageId = "legacy-multi";
	for (const manifest of [first, second, third]) await store.defineTask({ workItemId: "legacy-stage-summary", manifest, brief: "Implement it.", acceptance: "It works." });
	await store.putExecutionStage("legacy-stage-summary", { id: "legacy-single", tasks: ["legacy-singleton"] }, mutation);
	await store.putExecutionStage("legacy-stage-summary", { id: "legacy-multi", tasks: ["legacy-first", "legacy-second"] }, mutation);
	const stages = await service.listSummaries("stage", "legacy-stage-summary");
	assert.equal(stages.find((stage) => stage.id === "legacy-single")?.mode, "sequential");
	assert.equal(stages.find((stage) => stage.id === "legacy-multi")?.mode, "concurrent");
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

test("deletes a draft stage and defers its unassigned tasks to submission", async (t) => {
	const root = await repository(t); const store = new WorkItemStore(root); const service = new OrchestratorResourceService(root, store);
	await store.create({ id: "remove-stage", title: "Remove stage", kind: "change", intent: "Edit stage topology freely." });
	await store.defineTask({ workItemId: "remove-stage", manifest: task(), brief: "Build it.", acceptance: "It works." });
	await service.transaction("harness: delete stage", () => service.delete("work-item:remove-stage/stage:app", { authority: mutation }));
	assert.deepEqual((await store.read("remove-stage")).executionStages, []);
	assert.deepEqual((await service.listSummaries("task", "remove-stage"))[0]?.stageId, undefined);
	assert.deepEqual((await store.planningTopologyIssues("remove-stage")).map((issue) => issue.code), ["unassigned-task"]);
	await assert.rejects(store.submitPlanning("remove-stage"), /not assigned to an execution stage/);
	await store.putExecutionStage("remove-stage", { id: "delivery", tasks: ["build-app"], mode: "sequential" }, mutation);
	await store.submitPlanning("remove-stage");
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
		artifacts: [spec], tasks: [firstTask], stages: [{ id: "delivery", tasks: ["first-task"], checks: ["npm test -- focused"] }],
	};
	const createBase = await git(root, "rev-parse", "HEAD");
	await assert.rejects(service.transaction("harness: reject invalid complete plan", () => service.writePlan({ mode: "create", plan: { ...createPlan, workItem: { ...createPlan.workItem, id: "broken-plan" }, tasks: [{ ...firstTask, manifest: { ...firstTask.manifest, references: { specs: ["missing-spec"], designs: [], decisions: [] } } }] } }, mutation)), /Unknown spec reference/);
	assert.equal(await git(root, "rev-parse", "HEAD"), createBase);
	await assert.rejects(store.read("broken-plan"), /does not exist/);
	// The failed transaction preserves its checkout; return deliberately to develop.
	await git(root, "switch", "develop");
	await service.transaction("harness: create complete plan", () => service.writePlan({ mode: "create", plan: createPlan }, mutation));
	const created = await store.read("fresh-plan");
	assert.deepEqual(created.tasks.map((entry) => entry.id), ["first-task"]);
	const staleRevision = created.planning.revision;
	const secondTask = { manifest: task("second-task"), brief: "Build the replacement behavior.", acceptance: "It works better." };
	secondTask.manifest.assembly = { stageId: "second-stage", intermediateState: "complete" };
	const updatePlan = { ...createPlan, workItem: { ...createPlan.workItem, title: "Replaced plan" }, tasks: [secondTask], stages: [{ id: "delivery-v2", tasks: ["second-task"], review: { tier: "medium" as const } }] };
	await service.transaction("harness: update complete plan", () => service.writePlan({ mode: "update", target: "work-item:fresh-plan", expectedRevision: staleRevision, plan: updatePlan }, mutation));
	const updated = await store.read("fresh-plan");
	assert.equal(updated.title, "Replaced plan");
	assert.deepEqual(updated.tasks.map((entry) => entry.id), ["second-task"]);
	assert.deepEqual(updated.executionStages?.map((entry) => entry.id), ["delivery-v2"]);
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
