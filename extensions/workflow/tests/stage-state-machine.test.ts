import assert from "node:assert/strict";
import test from "node:test";
import {
	activateWorkflowAction,
	advanceStageStateMachine,
	createStoryRuntimeState,
	interruptOwnedAttempts,
	resumeInterruptedWorkflow,
	resolveWorkflowAttention,
	settleWorkflowAction,
	startWorkflow,
	type ActionSettlement,
	type StageMachinePlan,
	type WorkflowAction,
} from "../stage-state-machine.js";
import type { RuntimeExecutionCorrection, RuntimeOwner, StoryRuntimeState } from "../story-runtime-store.js";

const ownerA: RuntimeOwner = { sessionId: "session-a", processInstanceId: "process-a", activationId: "activation-a" };
const ownerB: RuntimeOwner = { sessionId: "session-b", processInstanceId: "process-b", activationId: "activation-b" };
const at = "2026-01-01T00:00:00.000Z";

function plan(overrides: Partial<StageMachinePlan> = {}): StageMachinePlan {
	return {
		stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }, { id: "task-b" }], checks: [{ id: "stage-check" }], review: { mode: "required" } }],
		...overrides,
	};
}
function initial(value = plan()): StoryRuntimeState {
	return startWorkflow(createStoryRuntimeState(value, { storyId: "example-story", contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} }, git: { canonicalBranch: "develop", baseCommit: "abc" } }), ownerA);
}
function action(state: StoryRuntimeState, value: StageMachinePlan, kind?: WorkflowAction["kind"]): WorkflowAction {
	const actions = advanceStageStateMachine(value, state).actions;
	const found = kind ? actions.find((candidate) => candidate.kind === kind) : actions[0];
	assert.ok(found, `expected ${kind ?? "an action"}, got ${actions.map((candidate) => candidate.kind).join(",")}`);
	return found;
}
let tokenSequence = 0;
function settle(
	state: StoryRuntimeState,
	value: StageMachinePlan,
	workflowAction: WorkflowAction,
	result: ActionSettlement["result"] = "passed",
	extra: Partial<ActionSettlement> = {},
	budget = 2,
): StoryRuntimeState {
	const token = `token-${++tokenSequence}`;
	const active = activateWorkflowAction(state, workflowAction, token, ownerA, at);
	const settled = settleWorkflowAction(active, { action: workflowAction, token, owner: ownerA, result, ...extra }, budget);
	assert.equal(settled.accepted, true);
	return settled.state;
}

function completeTasksAndIntegration(state: StoryRuntimeState, value: StageMachinePlan): StoryRuntimeState {
	while (true) {
		const next = advanceStageStateMachine(value, state);
		const taskAction = next.actions.find((candidate) => candidate.kind === "task-launch" || candidate.kind === "task-check");
		if (!taskAction) break;
		state = settle(next.state, value, taskAction, "passed", taskAction.kind === "task-launch" ? { contributionCommit: `commit-${taskAction.taskId}` } : {});
	}
	const integration = action(state, value, "integration");
	return settle(advanceStageStateMachine(value, state).state, value, integration, "passed", { integratedCommit: "integrated" });
}

test("ordered sequential stages expose one task and hold later stages behind the barrier", () => {
	const value = plan({ stages: [
		{ id: "stage-a", mode: "sequential", tasks: [{ id: "a" }, { id: "b" }], checks: [], review: { mode: "skip" } },
		{ id: "stage-b", mode: "sequential", tasks: [{ id: "c" }], checks: [], review: { mode: "skip" } },
	] });
	let state = initial(value);
	let projected = advanceStageStateMachine(value, state);
	assert.deepEqual(projected.actions.map((item) => [item.kind, item.taskId]), [["task-launch", "a"]]);
	state = settle(projected.state, value, projected.actions[0]!, "passed", { contributionCommit: "a1" });
	projected = advanceStageStateMachine(value, state);
	assert.deepEqual(projected.actions.map((item) => item.taskId), ["b"]);
	assert.equal(projected.state.stages[1]?.status, "pending");
});

test("concurrent stages expose every pending task without summing them into steps", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "concurrent", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }], checks: [], review: { mode: "skip" } }] });
	const projected = advanceStageStateMachine(value, initial(value));
	assert.equal(projected.changed, true);
	assert.deepEqual(projected.actions.map((item) => item.taskId), ["a", "b", "c"]);
	assert.ok(projected.actions.every((item) => item.kind === "task-launch"));
});

test("an idle active attempt is an explicit no-op that preserves the authoritative state object", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }], checks: [], review: { mode: "skip" } }] });
	const projected = advanceStageStateMachine(value, initial(value));
	const active = activateWorkflowAction(projected.state, projected.actions[0]!, "active-token", ownerA, at);
	const idle = advanceStageStateMachine(value, active);
	assert.equal(idle.changed, false);
	assert.equal(idle.state, active);
	assert.deepEqual(idle.actions, []);
});

test("stage review is scheduled only when required", () => {
	for (const mode of ["required", "skip"] as const) {
		const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode } }] });
		let state = initial(value);
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"));
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"));
		const projected = advanceStageStateMachine(value, state);
		assert.equal(projected.actions[0]?.kind, mode === "required" ? "review" : "final-review");
		assert.equal(projected.state.stages[0]?.status, mode === "required" ? "running" : "completed");
	}
});

test("task checks fail into bounded automatic repair and rerun", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a", checks: [{ id: "unit" }] }], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-launch"), "passed", { contributionCommit: "task-commit" });
	const check = action(state, value, "task-check");
	state = settle(advanceStageStateMachine(value, state).state, value, check, "repairable", { checks: [{ id: "unit", status: "failed", failure: { code: "test_failed", summary: "unit failed" } }] });
	assert.equal(action(state, value).kind, "task-repair");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-repair"));
	assert.equal(state.stages[0]?.tasks[0]?.repairCount, 1);
	assert.equal(action(state, value).kind, "task-check");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-check"), "passed", { checks: [{ id: "unit", status: "passed" }] });
	assert.equal(state.stages[0]?.tasks[0]?.status, "completed");
	assert.equal(state.stages[0]?.tasks[0]?.contributionCommit, "task-commit");
	assert.equal(state.stages[0]?.tasks[0]?.result?.code, "passed");
});

test("integration conflicts and deterministic verification failures repair automatically", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [{ id: "check" }], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "repairable", { failure: { code: "conflict", summary: "merge conflict" } });
	assert.equal(action(state, value).kind, "integration-repair");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration-repair"), "passed", { integratedCommit: "merged" });
	assert.equal(state.stages[0]?.integration.integratedCommit, "merged");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"), "repairable", { checks: [{ id: "check", status: "failed" }] });
	assert.equal(action(state, value).kind, "verification-repair");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification-repair"), "passed", { integratedCommit: "verified-repair" });
	assert.equal(state.stages[0]?.verification.repairCount, 1);
	assert.equal(state.stages[0]?.integration.integratedCommit, "verified-repair", "the following stage pins the repaired canonical head");
	assert.equal(action(state, value).kind, "verification");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"), "passed", { checks: [{ id: "check", status: "passed" }] });
	assert.equal(state.stages[0]?.verification.checks[0]?.status, "passed");
});

test("a critical review finding requires attention even when labeled passed", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"), "passed", {
		findings: [{ id: "critical-a", severity: "critical", code: "security_risk", summary: "material security risk" }],
	});
	assert.equal(state.status, "attention");
	assert.deepEqual(state.attention, { code: "security_risk", summary: "material security risk" });
	assert.equal(state.finalReview.status, "attention");
});

test("review fixer returns to reviewer with structured current findings", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: "required" } }] });
	let state = completeTasksAndIntegration(initial(value), value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"));
	const finding = { id: "finding-a", severity: "major" as const, code: "bug", summary: "bounded bug", path: "src/a.ts", line: 4 };
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "review"), "repairable", { findings: [finding] });
	assert.deepEqual(state.stages[0]?.review.currentFindings, [finding]);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "review-fix"), "passed", { integratedCommit: "review-repair" });
	assert.equal(state.stages[0]?.integration.integratedCommit, "review-repair", "a stage review repair becomes the next stage's durable base");
	assert.equal(action(state, value).kind, "review");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "review"));
	assert.equal(state.stages[0]?.review.iteration, 2);
	assert.deepEqual(state.stages[0]?.review.currentFindings, []);
});

test("repair budget exhaustion and critical or unsafe outcomes require attention", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "repairable", {}, 0);
	assert.equal(state.status, "attention");
	assert.equal(state.attention?.code, "repair_exhausted");
	assert.equal(advanceStageStateMachine(value, state).actions[0]?.kind, "attention");

	for (const result of ["critical", "needs_user", "unsafe"] as const) {
		state = initial(value);
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), result, { failure: { code: result, summary: `${result} decision` } }, 8);
		assert.equal(state.status, "attention");
		assert.equal(state.attention?.code, result);
	}
});

test("final-review and E2E repair loops rerun their evaluator", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"), "repairable", { findings: [{ id: "f", severity: "major", code: "bug", summary: "fix me" }] });
	assert.equal(action(state, value).kind, "final-review-fix");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review-fix"));
	assert.equal(action(state, value).kind, "final-review");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
	assert.equal(state.finalReview.iteration, 2);
	const finding = { id: "e2e-f", severity: "major" as const, code: "missing", summary: "Result missing" };
	const workspaceReport = { workspaceId: "a".repeat(32), sessionId: "session", runId: "00000000-0000-4000-8000-000000000000", reportPath: `/tmp/pibox-e2e-workspace-${"a".repeat(32)}/evaluations/00000000-0000-4000-8000-000000000000/report.json`, reportSha256: "b".repeat(64) };
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "repairable", {
		failure: { code: "e2e_failed", summary: "whole E2E contract failed" }, findings: [finding], workspaceReport,
	});
	assert.equal(action(state, value).kind, "e2e-fix");
	assert.deepEqual(state.e2e.currentFindings, [finding]);
	assert.deepEqual(state.e2e.workspaceReport, workspaceReport);
	assert.equal(state.e2e.currentEvidenceRefs, undefined);
	assert.equal(state.e2e.currentReportRef, undefined);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e-fix"));
	assert.equal(action(state, value).kind, "e2e");
	assert.deepEqual(state.e2e.currentFindings, [finding], "fix settlement preserves evaluator context");
	assert.deepEqual(state.e2e.workspaceReport, workspaceReport);
	assert.deepEqual(state.e2e.evidenceRefs, []);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "passed", {
		findings: [], workspaceReport: { ...workspaceReport, runId: "00000000-0000-4000-8000-000000000001", reportPath: `/tmp/pibox-e2e-workspace-${"a".repeat(32)}/evaluations/00000000-0000-4000-8000-000000000001/report.json`, reportSha256: "c".repeat(64) },
	});
	assert.equal(state.e2e.status, "completed");
	assert.deepEqual(state.e2e.currentFindings, []);
	assert.equal(state.e2e.workspaceReport?.runId, "00000000-0000-4000-8000-000000000001");
	assert.equal(state.e2e.currentEvidenceRefs, undefined);
	assert.equal(state.e2e.currentReportRef, undefined);
	assert.deepEqual(state.e2e.evidenceRefs, []);
});

test("report protocol interruption pauses for evaluator-only resume at every repair budget", () => {
	for (const budget of [0, 2]) {
		const value = plan({ stages: [] });
		let state = initial(value);
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "interrupted", {
			failure: { code: "e2e_report_protocol", summary: "report unavailable" },
		}, budget);
		assert.equal(state.status, "paused");
		assert.equal(state.e2e.status, "interrupted");
		assert.equal(state.e2e.interruptedFrom, "testing");
		assert.equal(state.e2e.repairCount, 0);
		assert.equal(state.attention, undefined);
		state = resumeInterruptedWorkflow(state, ownerA);
		assert.equal(state.e2e.status, "pending");
		assert.equal(state.e2e.repairCount, 0);
		assert.equal(action(state, value).kind, "e2e");
	}
});

test("missing workspace during E2E fix pauses without repair charge", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "repairable");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e-fix"), "interrupted", { failure: { code: "e2e_workspace_unavailable", summary: "workspace expired" } });
	assert.equal(state.status, "paused");
	assert.equal(state.e2e.status, "interrupted");
	assert.equal(state.e2e.interruptedFrom, "fixing");
	assert.equal(state.e2e.repairCount, 0);
	state = resumeInterruptedWorkflow(state, ownerA);
	assert.equal(state.e2e.status, "fix_pending");
});

test("E2E submission protocol failure preserves last accepted report context", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "repairable", {
		failure: { code: "observed", summary: "observed failure" },
		findings: [{ id: "old", severity: "major", code: "old", summary: "old finding" }],
		evidenceRefs: ["evidence/old.json"], currentEvidenceRefs: ["evidence/old.json"],
	});
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e-fix"));
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "repairable", {
		failure: { code: "worker_failed", summary: "worker failed before metadata" },
	});
	assert.deepEqual(state.e2e.currentFindings, [{ id: "old", severity: "major", code: "old", summary: "old finding" }]);
	assert.deepEqual(state.e2e.currentEvidenceRefs, ["evidence/old.json"]);
	assert.deepEqual(state.e2e.evidenceRefs, ["evidence/old.json"]);
});

test("whole-branch final review advances to whole-field E2E evidence and completion", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
	assert.equal(action(state, value).kind, "e2e");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "passed", {
		evidenceRefs: ["evidence/e2e.png", "evidence/e2e.txt"],
	});
	assert.deepEqual(state.e2e.evidenceRefs, ["evidence/e2e.png", "evidence/e2e.txt"]);
	assert.equal("cases" in state.e2e, false);
	const completion = action(state, value, "completion");
	state = activateWorkflowAction(advanceStageStateMachine(value, state).state, completion, "unused", ownerA, at);
	assert.equal(state.status, "completed");
	assert.equal(state.outcomeStatus, "pending");
});

test("stale callback tokens and owners are inert", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }], checks: [], review: { mode: "skip" } }] });
	const projected = advanceStageStateMachine(value, initial(value));
	const workflowAction = projected.actions[0]!;
	const active = activateWorkflowAction(projected.state, workflowAction, "current-token", ownerA, at);
	const staleToken = settleWorkflowAction(active, { action: workflowAction, token: "stale-token", owner: ownerA, result: "passed" }, 2);
	assert.equal(staleToken.accepted, false);
	assert.equal(staleToken.state, active);
	const staleOwner = settleWorkflowAction(active, { action: workflowAction, token: "current-token", owner: ownerB, result: "passed" }, 2);
	assert.equal(staleOwner.accepted, false);
	assert.equal(staleOwner.state, active);
});

test("crash interruption fences old attempts and explicit resume launches a fresh attempt", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }], checks: [], review: { mode: "skip" } }] });
	const projected = advanceStageStateMachine(value, initial(value));
	const workflowAction = projected.actions[0]!;
	const active = activateWorkflowAction(projected.state, workflowAction, "old-token", ownerA, at);
	const interrupted = interruptOwnedAttempts(active, ownerA);
	assert.equal(interrupted.status, "paused");
	assert.equal(interrupted.stages[0]?.tasks[0]?.status, "interrupted");
	const resumed = resumeInterruptedWorkflow(interrupted, ownerB);
	const staleInterruption = interruptOwnedAttempts(resumed, ownerA);
	assert.equal(staleInterruption, resumed);
	assert.equal(staleInterruption.status, "running");
	assert.deepEqual(staleInterruption.activationOwner, ownerB);
	const freshAction = action(resumed, value, "task-launch");
	const fresh = activateWorkflowAction(advanceStageStateMachine(value, resumed).state, freshAction, "fresh-token", ownerB, at);
	assert.equal(fresh.stages[0]?.tasks[0]?.attempt?.token, "fresh-token");
	const stale = settleWorkflowAction(fresh, { action: workflowAction, token: "old-token", owner: ownerA, result: "passed" }, 2);
	assert.equal(stale.accepted, false);
	const accepted = settleWorkflowAction(fresh, { action: freshAction, token: "fresh-token", owner: ownerB, result: "passed" }, 2);
	assert.equal(accepted.accepted, true);
	assert.equal(accepted.state.stages[0]?.tasks[0]?.status, "completed");
});

test("the current owner can pause a running workflow with no active child", () => {
	const value = plan({ stages: [] });
	const state = initial(value);
	const paused = interruptOwnedAttempts(state, ownerA);
	assert.notEqual(paused, state);
	assert.equal(paused.status, "paused");
	assert.equal(paused.activationOwner, undefined);
});

test("attention request-changes returns only the authoritative slot to bounded repair", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "unsafe", { failure: { code: "unsafe", summary: "manual recovery required" } });
	const resolved = resolveWorkflowAttention(state, { action: "request_changes" }, 2);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.status, "paused");
	assert.equal(resolved.state.stages[0]?.integration.status, "repair_pending");
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes" }, 0).accepted, false);
});

test("exhausted check attention accepts a genuinely changed checks-only correction without resetting history", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a", checks: [{ id: "ios" }] }], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-launch"), "passed", { contributionCommit: "original" }, 0);
	const diagnostic = { checkId: "ios", command: "xcodebuild -destination old", exitCode: 70, stdout: "", stderr: "error: unavailable destination", outputTruncated: false };
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-check"), "repairable", { failure: { code: "check_failed", causeCode: "check_configuration", summary: "destination unavailable", diagnostic }, checks: [{ id: "ios", status: "failed" }] }, 0);
	assert.equal(state.attention?.code, "repair_exhausted");
	assert.equal(state.attention?.causeCode, "check_configuration");
	assert.deepEqual(state.attention?.diagnostic, diagnostic);
	const correction = {
		sequence: 1,
		attentionEpoch: state.attentionEpoch!,
		appliedAt: at,
		target: { kind: "task" as const, stageId: "stage-a", taskId: "task-a" },
		task: { checks: [{ id: "ios", command: "xcodebuild -destination corrected" }] },
		priorFailure: state.stages[0]!.tasks[0]!.failure!,
	};
	const resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 0);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.stages[0]!.tasks[0]!.status, "check_pending");
	assert.equal(resolved.state.stages[0]!.tasks[0]!.repairCount, 0);
	assert.equal(resolved.state.stages[0]!.tasks[0]!.contributionCommit, "original");
	assert.deepEqual(resolved.state.executionCorrections, [correction]);
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", correction: { ...correction, attentionEpoch: correction.attentionEpoch + 1 } }, 0).reason?.code, "stale_attention_epoch");
});

test("checks-only correction is rejected without both contribution and failed-check evidence", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a", checks: [{ id: "unit" }] }], checks: [], review: { mode: "skip" } }] });
	const failure = { code: "repair_exhausted", summary: "launch failed before checks" };
	const state = initial(value);
	state.status = "attention"; state.attention = failure; state.attentionEpoch = 1;
	state.stages[0]!.status = "attention";
	const task = state.stages[0]!.tasks[0]!; task.status = "attention"; task.failure = failure;
	const correction = {
		sequence: 1, attentionEpoch: 1, appliedAt: at,
		target: { kind: "task" as const, stageId: "stage-a", taskId: "task-a" },
		task: { checks: [{ id: "unit", command: "npm test" }] }, priorFailure: failure,
	};
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", correction }, 0).reason?.code, "correction_requires_implementation");
	task.contributionCommit = "unvalidated";
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", correction }, 0).reason?.code, "correction_requires_implementation");
});

test("new integration guidance grants exactly one fresh exhausted repair without resetting history", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "repairable", { failure: { code: "report_too_large", summary: "integration report exceeded transport" } }, 0);
	const correction = {
		sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at,
		target: { kind: "integration" as const, stageId: "stage-a" }, prompt: "Transport now supports the bounded report; retry with the attached compact evidence.",
		priorFailure: state.stages[0]!.integration.failure!, priorRepairCount: 0,
	};
	const resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 0);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.stages[0]!.integration.status, "repair_pending");
	assert.equal(resolved.state.stages[0]!.integration.repairCount, 0);
	let resumed = startWorkflow(resolved.state, ownerA);
	const repair = action(resumed, value, "integration-repair");
	resumed = settle(advanceStageStateMachine(value, resumed).state, value, repair, "repairable", { failure: { code: "still_large", summary: "still too large" } }, 0);
	assert.equal(resumed.stages[0]!.integration.repairCount, 1);
	assert.equal(resumed.status, "attention");
	assert.equal(resolveWorkflowAttention(resumed, { action: "request_changes", correction: { ...correction, sequence: 2, attentionEpoch: resumed.attentionEpoch! } }, 0).reason?.code, "correction_noop");
});

test("concurrent failures require exact epoch targets and present each remaining attention boundary", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "concurrent", tasks: [{ id: "a" }, { id: "b" }], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state.stages[0]!.status = "running";
	for (const task of state.stages[0]!.tasks) {
		task.status = "repair_pending";
		task.contributionCommit = `contribution-${task.id}`;
		task.failure = { code: "prior", summary: `prior-${task.id}` };
	}
	const projected = advanceStageStateMachine(value, state);
	const actionA = projected.actions[0]!; const actionB = projected.actions[1]!;
	state = activateWorkflowAction(projected.state, actionA, "repair-a", ownerA, at);
	state = activateWorkflowAction(state, actionB, "repair-b", ownerA, at);
	state = settleWorkflowAction(state, { action: actionA, token: "repair-a", owner: ownerA, result: "repairable", failure: { code: "failure-a", summary: "actual A failed" } }, 1).state;
	assert.deepEqual(state.attentionTarget, { kind: "task", stageId: "stage-a", taskId: "a" });
	state = settleWorkflowAction(state, { action: actionB, token: "repair-b", owner: ownerA, result: "repairable", failure: { code: "failure-b", summary: "actual B failed" } }, 1).state;
	assert.equal(state.attentionEpoch, 2);
	assert.deepEqual(state.attentionTarget, { kind: "task", stageId: "stage-a", taskId: "b" });
	const beforeStale = structuredClone(state);
	const correctionA = {
		sequence: 1, attentionEpoch: 2, appliedAt: at,
		target: { kind: "task" as const, stageId: "stage-a", taskId: "a" }, prompt: "repair A now", task: { description: "Correct A." },
		priorFailure: state.stages[0]!.tasks[0]!.failure!, priorRepairCount: 1,
	};
	const staleTarget = resolveWorkflowAttention(state, { action: "request_changes", correction: correctionA }, 1);
	assert.equal(staleTarget.accepted, false);
	assert.equal(staleTarget.reason?.code, "correction_boundary_mismatch");
	assert.equal(staleTarget.state, state);
	assert.deepEqual(state, beforeStale, "a stale target cannot mutate either attention slot");
	const taskB = state.stages[0]!.tasks[1]!;
	const correctionB = { ...correctionA, target: { kind: "task" as const, stageId: "stage-a", taskId: "b" }, prompt: "repair B now", task: { description: "Correct B." }, priorFailure: taskB.failure! };
	const first = resolveWorkflowAttention(state, { action: "request_changes", correction: correctionB }, 1);
	assert.equal(first.accepted, true);
	assert.equal(first.state.status, "attention");
	assert.equal(first.state.attentionEpoch, 3);
	assert.deepEqual(first.state.attentionTarget, correctionA.target);
	assert.equal(first.state.stages[0]!.tasks[0]!.failure?.summary, "actual A failed");
	assert.equal(first.state.stages[0]!.tasks[1]!.failure?.summary, "repair B now");
	assert.equal(startWorkflow(first.state, ownerA), first.state, "remaining attention must not resume");
	const second = resolveWorkflowAttention(first.state, { action: "request_changes", correction: { ...correctionA, sequence: 2, attentionEpoch: 3 } }, 1);
	assert.equal(second.accepted, true);
	assert.equal(second.state.status, "paused");
	assert.equal(second.state.attentionTarget, undefined);
	assert.deepEqual(second.state.executionCorrections?.map((entry) => entry.priorFailure.summary), ["actual B failed", "actual A failed"]);
	for (const task of second.state.stages[0]!.tasks) assert.equal(task.repairCount, 1);
	assert.deepEqual(second.state.stages[0]!.tasks.map((task) => task.contributionCommit), ["contribution-a", "contribution-b"]);
	assert.equal(startWorkflow(second.state, ownerA).status, "running", "resume becomes available only after all attention is resolved");
});

test("exhausted stage-review, final-review, and E2E guidance each run one fix and rerun their evaluator", () => {
	const scenarios = ["stage-review", "final-review", "e2e"] as const;
	for (const kind of scenarios) {
		const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: kind === "stage-review" ? "required" : "skip" } }] });
		let state = initial(value);
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "passed", { integratedCommit: "preserved" });
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"));
		if (kind !== "stage-review") state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"));
		const initialKind = kind === "stage-review" ? "review" : kind === "final-review" ? "final-review" : "e2e";
		if (kind === "final-review") {
			// Rewind the passing setup settlement so this scenario exhausts final review itself.
			state.finalReview.status = "pending";
			delete state.finalReview.result;
		}
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, initialKind), "repairable", { failure: { code: `${kind}_failed`, summary: `${kind} failed` } }, 0);
		assert.equal(state.attention?.code, "repair_exhausted");
		assert.deepEqual(state.attentionTarget, kind === "stage-review" ? { kind, stageId: "stage-a" } : { kind });
		const correction = {
			sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at,
			target: kind === "stage-review" ? { kind, stageId: "stage-a" } : { kind }, prompt: `new ${kind} evidence`,
			priorFailure: state.attention!, priorRepairCount: 0,
		};
		let resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 0);
		assert.equal(resolved.accepted, true);
		state = startWorkflow(resolved.state, ownerA);
		const fixKind = kind === "stage-review" ? "review-fix" : kind === "final-review" ? "final-review-fix" : "e2e-fix";
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, fixKind), "passed", {}, 0);
		const slot = kind === "stage-review" ? state.stages[0]!.review : kind === "final-review" ? state.finalReview : state.e2e;
		assert.equal(slot.repairCount, 1);
		assert.equal(slot.status, "pending");
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, initialKind), "passed", {}, 0);
		assert.equal((kind === "stage-review" ? state.stages[0]!.review : kind === "final-review" ? state.finalReview : state.e2e).status, "completed");
	}
});

test("exhausted needs_user E2E guidance is narrowly epoch-bound and preserves retained state", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }], checks: [], review: { mode: "skip" } }] });
	const state = initial(value);
	state.status = "attention";
	state.attentionEpoch = 16;
	state.attentionTarget = { kind: "e2e" };
	state.attention = { code: "needs_user", summary: "fixture approval required" };
	state.stages[0]!.status = "completed";
	state.stages[0]!.tasks[0]!.status = "completed";
	state.stages[0]!.tasks[0]!.contributionCommit = "retained-contribution";
	state.e2e = {
		status: "attention", repairCount: 12, failure: structuredClone(state.attention),
		evidenceRefs: ["evidence/old.json"], currentEvidenceRefs: ["evidence/current.json"],
		currentFindings: [{ id: "prerequisite", severity: "major", code: "fixture", summary: "fixture missing" }],
	};
	const correction: RuntimeExecutionCorrection = {
		sequence: 1, attentionEpoch: 16, appliedAt: at, target: { kind: "e2e" },
		prompt: "Fixture is approved and available at the documented endpoint.", priorFailure: state.e2e.failure!, priorRepairCount: 12,
	};
	const resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 6);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.status, "paused");
	assert.equal(resolved.state.e2e.status, "fix_pending");
	assert.equal(resolved.state.e2e.repairCount, 12);
	assert.deepEqual(resolved.state.e2e.evidenceRefs, state.e2e.evidenceRefs);
	assert.deepEqual(resolved.state.e2e.currentEvidenceRefs, state.e2e.currentEvidenceRefs);
	assert.deepEqual(resolved.state.e2e.currentFindings, state.e2e.currentFindings);
	assert.equal(resolved.state.stages[0]!.tasks[0]!.contributionCommit, "retained-contribution");
	assert.deepEqual(resolved.state.executionCorrections?.[0]?.priorFailure, state.e2e.failure);
	assert.equal(resolved.state.executionCorrections?.[0]?.priorRepairCount, 12);
	const explicitNeedsUserCause = structuredClone(state);
	explicitNeedsUserCause.e2e.failure!.causeCode = "needs_user";
	explicitNeedsUserCause.attention = structuredClone(explicitNeedsUserCause.e2e.failure!);
	assert.equal(resolveWorkflowAttention(explicitNeedsUserCause, { action: "request_changes", correction: { ...correction, priorFailure: explicitNeedsUserCause.e2e.failure! } }, 6).accepted, true);

	const denied = (candidate: StoryRuntimeState, candidateCorrection: RuntimeExecutionCorrection = correction) => {
		const before = structuredClone(candidate);
		const result = resolveWorkflowAttention(candidate, { action: "request_changes", correction: candidateCorrection }, 6);
		assert.equal(result.accepted, false);
		assert.equal(result.state, candidate);
		assert.deepEqual(candidate, before);
	};
	denied(state, { ...correction, attentionEpoch: 15 });
	denied(state, { ...correction, target: { kind: "final-review" as const } });
	denied(state, { ...correction, prompt: "" });
	denied(state, { ...correction, prompt: state.e2e.failure!.summary });
	for (const causeCode of ["critical", "unsafe", "unknown_origin"]) {
		const candidate = structuredClone(state);
		candidate.e2e.failure!.causeCode = causeCode;
		candidate.attention = structuredClone(candidate.e2e.failure!);
		denied(candidate, { ...correction, priorFailure: candidate.e2e.failure! });
	}
	const criticalFailure = structuredClone(state);
	criticalFailure.e2e.failure = { code: "critical", summary: "critical decision required" };
	criticalFailure.attention = structuredClone(criticalFailure.e2e.failure!);
	denied(criticalFailure, { ...correction, priorFailure: criticalFailure.e2e.failure });
	const currentCritical = structuredClone(state);
	currentCritical.e2e.currentFindings = [{ id: "critical", severity: "critical", code: "security", summary: "unsafe fixture" }];
	denied(currentCritical);
	const belowBudget = structuredClone(state);
	belowBudget.e2e.repairCount = 5;
	denied(belowBudget, { ...correction, priorRepairCount: 5 });
	assert.equal(resolveWorkflowAttention(belowBudget, { action: "request_changes", prompt: "ordinary retry" }, 6).accepted, true);
	const beforePlain = structuredClone(state);
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", prompt: "plain exhausted retry" }, 6).accepted, false);
	assert.equal(resolveWorkflowAttention(state, { action: "approve", acceptedRisks: [], acceptedAt: at }, 6).accepted, false);
	assert.deepEqual(state, beforePlain);
	denied(resolved.state, { ...correction, sequence: 2 });
});

test("Critical stage and final findings survive a successful requested fix until fresh review clears them", () => {
	for (const target of ["stage", "final"] as const) {
		const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: target === "stage" ? "required" : "skip" } }] });
		let state = initial(value);
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "passed", { integratedCommit: "integrated" });
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"));
		const reviewKind = target === "stage" ? "review" : "final-review";
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, reviewKind), "critical", {
			findings: [{ id: "critical", severity: "critical", code: "security", summary: "must be independently cleared" }],
		});
		const requested = resolveWorkflowAttention(state, { action: "request_changes", prompt: "Fix the Critical issue." }, 2);
		assert.equal(requested.accepted, true);
		state = startWorkflow(requested.state, ownerA);
		const fixKind = target === "stage" ? "review-fix" : "final-review-fix";
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, fixKind), "passed", { findings: [{ id: "critical", severity: "minor", code: "fixer-claim", summary: "fixer cannot self-clear" }] });
		const afterFix = target === "stage" ? state.stages[0]!.review : state.finalReview;
		assert.equal(afterFix.repairCount, 1);
		assert.equal(afterFix.status, "pending");
		assert.equal(afterFix.currentFindings[0]?.id, "critical");
		state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, reviewKind), "passed", { findings: [] });
		const cleared = target === "stage" ? state.stages[0]!.review : state.finalReview;
		assert.equal(cleared.status, "completed");
		assert.deepEqual(cleared.currentFindings, []);
	}
});

test("runtime-slot guidance rejects normal Critical attention and retained Critical exhaustion", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [], review: { mode: "required" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"));
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"));
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "review"), "critical", { findings: [{ id: "critical", severity: "critical", code: "security", summary: "do not waive" }] }, 0);
	const correction = {
		sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at, target: { kind: "stage-review" as const, stageId: "stage-a" },
		prompt: "try different guidance", priorFailure: state.stages[0]!.review.failure!, priorRepairCount: 0,
	};
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", correction }, 0).reason?.code, "guidance_requires_repair_exhaustion");
	state.stages[0]!.review.failure = { code: "repair_exhausted", causeCode: "security", summary: "wrapper" };
	state.attention = state.stages[0]!.review.failure;
	assert.equal(resolveWorkflowAttention(state, { action: "request_changes", correction: { ...correction, priorFailure: state.attention } }, 0).reason?.code, "critical_findings_require_user_decision");
});

test("a correction fences concurrent sibling attempts for fresh-token resume", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "concurrent", tasks: [{ id: "a" }, { id: "b" }], checks: [], review: { mode: "skip" } }] });
	const projected = advanceStageStateMachine(value, initial(value));
	const actionA = projected.actions[0]!; const actionB = projected.actions[1]!;
	let state = activateWorkflowAction(projected.state, actionA, "old-a", ownerA, at);
	state = activateWorkflowAction(state, actionB, "old-b", ownerA, at);
	state = settleWorkflowAction(state, { action: actionA, token: "old-a", owner: ownerA, result: "unsafe", failure: { code: "unsafe", summary: "correct the capsule" } }, 2).state;
	const correction = {
		sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at,
		target: { kind: "task" as const, stageId: "stage-a", taskId: "a" }, task: { description: "Corrected." },
		priorFailure: state.stages[0]!.tasks[0]!.failure!,
	};
	const corrected = resolveWorkflowAttention(state, { action: "request_changes", correction }, 2).state;
	assert.equal(corrected.stages[0]!.tasks[1]!.status, "interrupted");
	assert.equal(corrected.stages[0]!.tasks[1]!.attempt, undefined);
	const resumed = resumeInterruptedWorkflow(corrected, ownerA);
	const freshB = action(resumed, value, "task-launch");
	const active = activateWorkflowAction(advanceStageStateMachine(value, resumed).state, freshB, "fresh-b", ownerA, at);
	assert.notEqual(active.stages[0]!.tasks.find((task) => task.id === "b")?.attempt?.token, "old-b");
});

test("a stage-check correction preserves integration and reruns verification directly", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [], checks: [{ id: "ios" }], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "integration"), "passed", { integratedCommit: "preserved-integration" }, 0);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification"), "repairable", { failure: { code: "check_failed", summary: "wrong destination" }, checks: [{ id: "ios", status: "failed" }] }, 0);
	const correction = {
		sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at,
		target: { kind: "stage-verification" as const, stageId: "stage-a" },
		stageVerification: { checks: [{ id: "ios", command: "corrected destination" }] },
		priorFailure: state.stages[0]!.verification.failure!,
	};
	const resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 0);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.stages[0]!.verification.status, "pending");
	assert.equal(resolved.state.stages[0]!.integration.integratedCommit, "preserved-integration");
	assert.equal(resolved.state.stages[0]!.verification.repairCount, 0);
});

test("a prose correction schedules one fresh repair after exhaustion without resetting its count", () => {
	const value = plan({ stages: [{ id: "stage-a", mode: "sequential", tasks: [{ id: "task-a" }], checks: [], review: { mode: "skip" } }] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "task-launch"), "repairable", { failure: { code: "worker_failed", summary: "old capsule failed" } }, 0);
	const correction = {
		sequence: 1, attentionEpoch: state.attentionEpoch!, appliedAt: at,
		target: { kind: "task" as const, stageId: "stage-a", taskId: "task-a" },
		prompt: "Use the corrected factual API name.", task: { description: "Use the corrected API." },
		priorFailure: state.stages[0]!.tasks[0]!.failure!,
	};
	const resolved = resolveWorkflowAttention(state, { action: "request_changes", correction }, 0);
	assert.equal(resolved.accepted, true);
	assert.equal(resolved.state.stages[0]!.tasks[0]!.status, "repair_pending");
	assert.equal(resolved.state.stages[0]!.tasks[0]!.repairCount, 0);
});

test("critical review approval requires and persists every explicit risk rationale", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"), "critical", {
		failure: { code: "critical", summary: "critical risk" },
		findings: [{ id: "risk-a", severity: "critical", code: "security", summary: "critical security risk" }],
	});
	assert.equal(resolveWorkflowAttention(state, { action: "approve", acceptedRisks: [], acceptedAt: at }, 2).accepted, false);
	const rationale = `risk-start-${"r".repeat(4_500)}-risk-end`;
	const approved = resolveWorkflowAttention(state, { action: "approve", acceptedRisks: [{ findingId: "risk-a", rationale }], acceptedAt: at }, 2);
	assert.equal(approved.accepted, true);
	assert.equal(approved.state.status, "paused");
	assert.equal(approved.state.finalReview.status, "completed");
	assert.deepEqual(approved.state.finalReview.acceptedRisks, [{ findingId: "risk-a", rationale, acceptedAt: at }]);
});
