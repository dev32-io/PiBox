import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { renderE2e } from "../../../workflow/authored-markdown.js";
import { parseAuthoredTaskDocument } from "../../../workflow/work-items.js";
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
		metrics: {
			workflowMs: 15, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 1 },
			open: { category: "implementation", since: "2025-01-02T00:00:00.000Z", stageId: "foundation" }, incompleteIntervals: 2, incompleteCategories: ["review"],
			stageBreakdown: { foundation: { workflowMs: 14, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 0 }, incompleteIntervals: 1, incompleteCategories: ["review"] } },
		}, outcomeStatus: "failed",
	});
	return { root, story };
}

test("current workflow projection aggregates operations and exposes only safe runtime fields", async (t) => {
	const { root, story } = await workflowFixture(t); const workspace = await new StoryBoardReader(root).readWorkspace(story); assert.ok(workspace?.workflow);
	assert.deepEqual(workspace.workflow.totals.tasks, { completed: 1, total: 2, active: 0, attention: 1 });
	assert.equal(workspace.workflow.totals.repairs, 8); assert.deepEqual(workspace.workflow.totals.checks, { passed: 2, failed: 2, running: 1, total: 5 });
	assert.deepEqual(workspace.workflow.totals.findings, { critical: 1, major: 1, minor: 1, total: 3 }); assert.deepEqual(workspace.workflow.attention, { tasks: 1, checks: 2, findings: 3, total: 6 });
	assert.equal(workspace.workflow.currentStageId, "foundation"); assert.equal(workspace.workflow.currentPhase, "implementation"); assert.equal(workspace.workflow.evidenceCount, 2);
	assert.deepEqual(workspace.workflow.metrics, {
		workflowMs: 15, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 1, repair: 0 }, incompleteIntervals: 2, incompleteCategories: ["review"],
		activeCategory: "implementation", activeSince: "2025-01-02T00:00:00.000Z", activeStageId: "foundation",
		stageBreakdown: { foundation: { workflowMs: 14, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 0, repair: 0 }, incompleteIntervals: 1, incompleteCategories: ["review"], activeCategory: "implementation", activeSince: "2025-01-02T00:00:00.000Z" } },
	});
	const stored = parse(await readFile(join(root, "agent-artifacts", story, "state.yaml"), "utf8"));
	assert.equal("repair" in stored.metrics.categories, false, "projection defaults old totals without writing state");
	assert.equal("repair" in stored.metrics.stageBreakdown.foundation.categories, false);
	assert.deepEqual(workspace.workflow.topAttention, { code: "workflow_attention", summary: "Inspect '[private path]' now" });
	assert.deepEqual(workspace.finalReview?.result, { code: "safe_text", summary: "Keep feature/foo, 1/2, and https://example.com/a" });
	const stage = workspace.stages?.[0]; assert.ok(stage); assert.equal(stage.mode, "concurrent"); assert.equal(stage.tasks.length, 2);
	assert.deepEqual(stage.timing, { workflowMs: 14, categories: { implementation: 5, integration: 4, verification: 3, review: 2, e2e: 0, repair: 0 }, incompleteIntervals: 1, incompleteCategories: ["review"], activeCategory: "implementation", activeSince: "2025-01-02T00:00:00.000Z" });
	assert.deepEqual(stage.tasks[1], { id: "second-task", title: "Second task", status: "attention", dependsOn: ["first-task", "missing-task"], incompleteDependencyCount: 1, repairCount: 2, checks: { passed: 0, failed: 0, running: 1, total: 1 }, failure: { code: "task_failed", summary: "Failed at ([private path])" }, reportId: "task-second-task" });
	assert.equal(stage.integration.repairCount, 1); assert.deepEqual(stage.verification.checks, { passed: 1, failed: 1, running: 0, total: 2 }); assert.deepEqual(stage.review.findings, { critical: 1, major: 0, minor: 1, total: 2 });
	assert.equal(workspace.finalReview?.reportId, "final-review"); assert.equal(workspace.finalE2E?.repairCount, 1);
	const serialized = JSON.stringify(workspace);
	for (const privateValue of ["private-session", "private-process", "private-activation", "private-token", "private/main", "private/integration", "private-base", "/Users/private", "/private/", "C:\\\\private", "sha256:", "open\":{", "since", "\"attempt\":{", "iteration", "contributionCommits", "integratedCommit"]) assert.doesNotMatch(serialized, new RegExp(privateValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.ok(workspace.reports.every((report) => report.attempt === undefined || Number.isInteger(report.attempt)));
});

test("legacy oversized failures project a compact card and sanitized detail without inventing a cause", async (t) => {
	const { root, story } = await workflowFixture(t); const statePath = join(root, "agent-artifacts", story, "state.yaml");
	const state = (await import("yaml")).parse(await readFile(statePath, "utf8"));
	state.stages[0].tasks[1].checks = [{ id: "ios-check", status: "failed", failure: summary("check_failed", "Failed") }];
	state.stages[0].tasks[1].failure = summary("repair_exhausted", `xcodebuild failed at /Users/private/worktree/build.log\n${"destination inventory ".repeat(70)}`);
	await writeFile(statePath, stringify(state));
	const reader = new StoryBoardReader(root); const workspace = await reader.readWorkspace(story); assert.ok(workspace);
	const failure = workspace.stages?.[0]?.tasks[1]?.failure; assert.ok(failure);
	assert.equal(failure.code, "repair_exhausted"); assert.equal(failure.causeCode, undefined); assert.equal(failure.failedCheckId, "ios-check");
	assert.equal(failure.summary, "xcodebuild failed at [private path]"); assert.match(failure.details ?? "", /destination inventory/); assert.doesNotMatch(failure.details ?? "", /Users\/private/);
	const detail = await reader.readTaskDetail(story, "second-task"); assert.deepEqual(detail?.failure, failure);
	const report = await reader.readReportDetail(story, "task-second-task"); assert.deepEqual(report?.failure, failure); assert.doesNotMatch(report?.body ?? "", /destination inventory/);
});

test("structured check diagnostics preserve cause, command, exit, streams, and truncation after sanitizing", async (t) => {
	const { root, story } = await workflowFixture(t); const statePath = join(root, "agent-artifacts", story, "state.yaml");
	const state = (await import("yaml")).parse(await readFile(statePath, "utf8"));
	state.stages[0].tasks[1].checks = [{ id: "check-2", status: "failed", failure: summary("check_failed", "Failed") }];
	state.stages[0].tasks[1].failure = {
		code: "repair_exhausted", causeCode: "unavailable_destination", summary: "No matching iOS Simulator destination.",
		diagnostic: { checkId: "check-2", command: "xcodebuild test --resultBundlePath /Users/private/result", exitCode: 70, stdout: "line one\nline two", stderr: "inventory\n/Users/private/worktree/device-list", outputTruncated: true },
	};
	await writeFile(statePath, stringify(state));
	const workspace = await new StoryBoardReader(root).readWorkspace(story); const failure = workspace?.stages?.[0]?.tasks[1]?.failure; assert.ok(failure);
	assert.deepEqual(failure, { code: "repair_exhausted", causeCode: "unavailable_destination", summary: "No matching iOS Simulator destination.", failedCheckId: "check-2", diagnostic: { checkId: "check-2", command: "xcodebuild test --resultBundlePath [private path]", exitCode: 70, stdout: "line one\nline two", stderr: "inventory\n[private path]", outputTruncated: true } });
	assert.doesNotMatch(JSON.stringify(failure), /Users\/private/);
});

test("current Final E2E projects exact referenced case evidence without confusing recorded verdict and live phase", async (t) => {
	const { root, story } = await workflowFixture(t); const base = `agent-artifacts/${story}`;
	const storyValue = parse(await readFile(join(root, base, "story.yaml"), "utf8"));
	storyValue.e2e = renderE2e({ scope: "Current journey", cases: [
		{ id: "E2E-001", title: "Authored journey", exercise: "Exercise one", oracle: "Oracle one", proof: "Proof one" },
		{ id: "E2E-002", title: "Missing journey", exercise: "Exercise two", oracle: "Oracle two", proof: "Proof two" },
	] });
	await put(root, `${base}/story.yaml`, storyValue);
	const longObservation = "complete observation ".repeat(120_000);
	await put(root, `${base}/evidence/proof.txt`, "proof");
	await put(root, `${base}/evidence/older.json`, JSON.stringify({ result: "passed", summary: "<script>alert(1)</script> at /Users/private/report api_key=very-secret", findings: ["Previous finding retained"], caseResults: [
		{ caseId: "E2E-001", status: "passed", executedActions: ["Open journey"], observations: [longObservation], evidenceRefs: ["evidence/proof.txt", "https://attacker.invalid/private"] },
		{ caseId: "E2E-999", status: "blocked", executedActions: ["Unknown action"], observations: ["Report-only observation"], evidenceRefs: [] },
	] }));
	await put(root, `${base}/evidence/newer.json`, JSON.stringify({ result: "passed", summary: "bad duplicate", findings: [], caseResults: [
		{ caseId: "E2E-001", status: "blocked", executedActions: [], observations: [], evidenceRefs: [] },
		{ caseId: "E2E-001", status: "passed", executedActions: [], observations: [], evidenceRefs: [] },
	] }));
	const state = parse(await readFile(join(root, base, "state.yaml"), "utf8"));
	state.e2e = { status: "testing", repairCount: 3, evidenceRefs: ["evidence/older.json", "evidence/proof.txt", "evidence/newer.json"], result: { code: "repaired", summary: JSON.stringify({ result: "fixed", summary: "Ready for recheck", privatePath: "/Users/private/action" }) }, failure: { code: "blocked", summary: "Previous blocked guidance" } };
	await put(root, `${base}/state.yaml`, state);
	const reader = new StoryBoardReader(root); const workspace = await reader.readWorkspace(story); const report = await reader.readReportDetail(story, "final-e2e");
	assert.equal(workspace?.finalE2E?.status, "testing"); assert.equal(workspace?.reports.find((item) => item.id === "final-e2e")?.verdict, undefined);
	assert.equal(workspace?.reports.find((item) => item.id === "final-e2e")?.repairCount, 3);
	assert.equal(report?.title, "Final E2E"); assert.deepEqual(report?.currentE2E && { phase: report.currentE2E.phase, repairs: report.currentE2E.repairCount, prior: report.currentE2E.priorContext }, { phase: "testing", repairs: 3, prior: true });
	assert.equal(report?.currentE2E?.lastAction?.summary, "fixed — Ready for recheck"); assert.doesNotMatch(report?.currentE2E?.lastAction?.details ?? "", /Users\/private/);
	assert.equal(report?.recordedE2E?.sourceMemberPath, "evidence/older.json"); assert.equal(report?.recordedE2E?.result, "passed");
	assert.match(report?.recordedE2E?.summary ?? "", /<script>/); assert.doesNotMatch(report?.recordedE2E?.summary ?? "", /Users\/private|very-secret/);
	assert.deepEqual(report?.recordedE2E?.findings, ["Previous finding retained"]);
	assert.deepEqual(report?.recordedE2E?.cases.map((item) => [item.caseId, item.title, item.status, item.recorded]), [
		["E2E-001", "Authored journey", "passed", true], ["E2E-002", "Missing journey", "Not recorded", false], ["E2E-999", undefined, "blocked", true],
	]);
	assert.ok((report?.recordedE2E?.cases[0]?.observations[0]?.length ?? 0) > 2_000_000, "complete evidence content is retained");
	assert.equal(report?.recordedE2E?.cases[0]?.evidenceRefs[0]?.memberPath, "evidence/proof.txt"); assert.equal(report?.recordedE2E?.cases[0]?.evidenceRefs[1]?.memberPath, undefined);
	assert.ok(report?.recordedE2E?.diagnostics.some((item) => item.message.includes("earlier report")));
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

test("task details show effective runtime corrections without changing or misdiagnosing the authored baseline", async (t) => {
	const { root, story } = await workflowFixture(t); const base = `agent-artifacts/${story}`;
	const taskPath = join(root, base, "tasks/second-task.yaml");
	const original = await readFile(taskPath, "utf8");
	const baseline = parseAuthoredTaskDocument(original, taskPath);
	const state = parse(await readFile(join(root, base, "state.yaml"), "utf8"));
	state.contracts.tasks[baseline.id] = `sha256:${createHash("sha256").update(JSON.stringify(baseline)).digest("hex")}`;
	state.attentionEpoch = 1;
	state.executionCorrections = [{ sequence: 1, attentionEpoch: 1, appliedAt: "2026-09-11T00:00:00.000Z", target: { kind: "task", stageId: "foundation", taskId: baseline.id }, task: { description: "Corrected native destination", checks: ["xcodebuild test -destination 'platform=iOS Simulator,OS=18.3.1'"] }, priorFailure: { code: "check_configuration", summary: "Private previous failure at /tmp/prior-worktree" } }];
	await put(root, `${base}/state.yaml`, state);
	const reader = new StoryBoardReader(root); const task = await reader.readTaskDetail(story, baseline.id);
	assert.ok(task); assert.equal(task.executionCorrected, true);
	assert.equal(task.brief, "Corrected native destination");
	assert.deepEqual(task.verification?.taskChecks, ["xcodebuild test -destination 'platform=iOS Simulator,OS=18.3.1'"]);
	assert.equal(task.scope, baseline.scope);
	assert.ok(!task.diagnostics.some((item) => item.message.includes("runtime contract")));
	assert.doesNotMatch(JSON.stringify(task), /prior-worktree|priorFailure|executionCorrections/);
	assert.equal(await readFile(taskPath, "utf8"), original);

	// Compacted history must not hide an older still-effective correction.
	state.executionOverrides = { tasks: [{ stageId: "foundation", taskId: baseline.id, task: state.executionCorrections[0].task }], stageVerifications: [], guidance: [] };
	state.executionCorrections = [];
	state.correctionSequence = 33;
	state.attentionEpoch = 33;
	await put(root, `${base}/state.yaml`, state);
	const compacted = await new StoryBoardReader(root).readTaskDetail(story, baseline.id);
	assert.equal(compacted?.executionCorrected, true);
	assert.equal(compacted?.brief, "Corrected native destination");
	assert.deepEqual(compacted?.verification?.taskChecks, task.verification?.taskChecks);
});
