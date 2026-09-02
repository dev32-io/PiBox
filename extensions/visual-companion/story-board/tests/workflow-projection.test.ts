import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { StoryBoardReader } from "../index.js";

async function put(root: string, path: string, value: unknown): Promise<void> {
	const target = join(root, path); await mkdir(dirname(target), { recursive: true });
	await writeFile(target, typeof value === "string" ? value : stringify(value));
}

const owner = { sessionId: "private-session", processInstanceId: "private-process", activationId: "private-activation" };
const summary = (code: string, text: string) => ({ code, summary: text });
const review = (overrides: Record<string, unknown> = {}) => ({ status: "pending", iteration: 0, repairCount: 0, currentFindings: [], ...overrides });

async function workflowFixture(t: test.TestContext): Promise<{ root: string; story: string }> {
	const root = await mkdtemp(join(tmpdir(), "story-workflow-projection-")); t.after(() => rm(root, { recursive: true, force: true }));
	const story = "reactive-board"; const base = `agent-artifacts/${story}`;
	await put(root, `${base}/story.yaml`, { schemaVersion: 1, id: story, title: "Reactive board", kind: "story", spec: "# Spec\n\nPublic workflow projection.", design: "Design", e2e: "E2E" });
	await put(root, `${base}/plan.yaml`, { schemaVersion: 1, stages: [{ id: "foundation", mode: "concurrent", tasks: ["first-task", "second-task"], checks: ["npm test"], review: { mode: "required" } }] });
	for (const task of [
		{ id: "first-task", title: "First task", dependsOn: [] },
		{ id: "second-task", title: "Second task", dependsOn: ["first-task", "missing-task"] },
	]) await put(root, `${base}/tasks/${task.id}.yaml`, { schemaVersion: 1, ...task, description: "Do it", scope: "Only it", delivery: "Verified", checks: ["npm test"], assignment: { agent: "implementer", tier: "low", rationale: "Focused" } });
	await put(root, `${base}/state.yaml`, {
		schemaVersion: 1, storyId: story, status: "attention", activationOwner: owner, attention: summary("workflow_attention", "Inspect '/Users/Kevin Ye/private worktree/state.yaml' now"),
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: { "first-task": `sha256:${"c".repeat(64)}` } },
		git: { canonicalBranch: "private/main", baseCommit: "private-base", integrationBranch: "private/integration", integrationWorktree: "/Users/private/worktree" },
		stages: [{
			id: "foundation", status: "attention",
			tasks: [
				{ id: "first-task", status: "completed", repairCount: 1, checks: [{ id: "one", status: "passed" }, { id: "two", status: "failed", failure: summary("check_failed", "See /tmp/private.log") }], result: summary("done", "Written at /private/output") },
				{ id: "second-task", status: "attention", repairCount: 2, attempt: { token: "private-token", owner, activatedAt: "2025-01-01T00:00:00.000Z" }, checks: [{ id: "three", status: "running" }], failure: summary("task_failed", "Failed at (C:\\private\\worktree\\task.log)") },
			],
			integration: { status: "completed", repairCount: 1, contributionCommits: ["private-commit"], integratedCommit: "private-integrated", result: summary("integrated", "Integrated from /private/branch") },
			verification: { status: "attention", repairCount: 2, checks: [{ id: "four", status: "passed" }, { id: "five", status: "failed", failure: summary("verify_failed", "At /private/check") }], failure: summary("verification_failed", "Log /private/verification.log") },
			review: review({ status: "attention", iteration: 4, repairCount: 1, currentFindings: [{ id: "F-1", severity: "critical", code: "unsafe", summary: "At /private/source", path: "src/safe.ts", line: 2 }, { id: "F-2", severity: "minor", code: "minor", summary: "Minor" }], failure: summary("review_failed", "At /private/review") }),
		}],
		finalReview: review({ result: summary("safe_text", "Keep feature/foo, 1/2, and https://example.com/a"), currentFindings: [{ id: "F-3", severity: "major", code: "major", summary: "Major" }] }),
		e2e: { status: "pending", repairCount: 1, evidenceRefs: ["evidence/one.txt", "evidence/two.png"] },
		metrics: { workflowMs: 15, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 1 }, open: { category: "implementation", since: "2025-01-02T00:00:00.000Z" }, incompleteIntervals: 2, incompleteCategories: ["review"] }, outcomeStatus: "failed",
	});
	return { root, story };
}

test("current workflow projection aggregates operations and exposes only safe runtime fields", async (t) => {
	const { root, story } = await workflowFixture(t); const workspace = await new StoryBoardReader(root).readWorkspace(story); assert.ok(workspace?.workflow);
	assert.deepEqual(workspace.workflow.totals.tasks, { completed: 1, total: 2, active: 0, attention: 1 });
	assert.equal(workspace.workflow.totals.repairs, 8); assert.deepEqual(workspace.workflow.totals.checks, { passed: 2, failed: 2, running: 1, total: 5 });
	assert.deepEqual(workspace.workflow.totals.findings, { critical: 1, major: 1, minor: 1, total: 3 }); assert.deepEqual(workspace.workflow.attention, { tasks: 1, checks: 2, findings: 3, total: 6 });
	assert.equal(workspace.workflow.currentStageId, "foundation"); assert.equal(workspace.workflow.currentPhase, "implementation"); assert.equal(workspace.workflow.evidenceCount, 2);
	assert.deepEqual(workspace.workflow.metrics, { workflowMs: 15, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 1 }, incompleteIntervals: 2, incompleteCategories: ["review"], activeCategory: "implementation" });
	assert.deepEqual(workspace.workflow.topAttention, { code: "workflow_attention", summary: "Inspect '[private path]' now" });
	assert.deepEqual(workspace.finalReview?.result, { code: "safe_text", summary: "Keep feature/foo, 1/2, and https://example.com/a" });
	const stage = workspace.stages?.[0]; assert.ok(stage); assert.equal(stage.mode, "concurrent"); assert.equal(stage.tasks.length, 2);
	assert.deepEqual(stage.tasks[1], { id: "second-task", title: "Second task", status: "attention", dependsOn: ["first-task", "missing-task"], incompleteDependencyCount: 1, repairCount: 2, checks: { passed: 0, failed: 0, running: 1, total: 1 }, failure: { code: "task_failed", summary: "Failed at ([private path])" }, reportId: "task-second-task" });
	assert.equal(stage.integration.repairCount, 1); assert.deepEqual(stage.verification.checks, { passed: 1, failed: 1, running: 0, total: 2 }); assert.deepEqual(stage.review.findings, { critical: 1, major: 0, minor: 1, total: 2 });
	assert.equal(workspace.finalReview?.reportId, "final-review"); assert.equal(workspace.finalE2E?.repairCount, 1);
	const serialized = JSON.stringify(workspace);
	for (const privateValue of ["private-session", "private-process", "private-activation", "private-token", "private/main", "private/integration", "private-base", "/Users/private", "/private/", "C:\\\\private", "sha256:", "open\":{", "since", "\"attempt\":{", "iteration", "contributionCommits", "integratedCommit"]) assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(workspace.reports.every((report) => report.attempt === undefined || Number.isInteger(report.attempt)));
});

test("authoritative runtime topology wins when the authored plan drifts", async (t) => {
	const { root, story } = await workflowFixture(t); const base = `agent-artifacts/${story}`;
	await put(root, `${base}/plan.yaml`, { schemaVersion: 1, stages: [{ id: "drifted-stage", mode: "sequential", tasks: ["first-task"], checks: [] }] });
	await put(root, `${base}/tasks/extra-task.yaml`, { schemaVersion: 1, id: "extra-task", title: "Extra task", dependsOn: [], description: "Drift", scope: "Drift", delivery: "Drift", checks: ["npm test"], assignment: { agent: "implementer", tier: "low", rationale: "Drift" } });
	const reader = new StoryBoardReader(root); const workspace = await reader.readWorkspace(story); assert.ok(workspace);
	assert.deepEqual(workspace.stages?.map((stage) => [stage.id, stage.mode, stage.taskIds]), [["foundation", "unknown", ["first-task", "second-task"]]]);
	assert.equal(workspace.story.taskCount, 2); assert.deepEqual(workspace.tasks.map((task) => task.id).sort(), ["first-task", "second-task"]);
	assert.equal(await reader.readTaskDetail(story, "extra-task"), undefined, "tasks outside runtime membership are not addressable");
	assert.ok(workspace.diagnostics.some((item) => item.path.endsWith("/plan.yaml") && item.message.includes("authoritative runtime state")));
	assert.ok(workspace.diagnostics.some((item) => item.path.endsWith("/extra-task.yaml") && item.message.includes("omitted")));
	assert.ok(workspace.tasks.some((task) => task.diagnostics.some((item) => item.message.includes("runtime contract"))), "contract drift is localized to task cards");
});
