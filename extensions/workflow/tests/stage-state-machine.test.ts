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
import type { RuntimeOwner, StoryRuntimeState } from "../story-runtime-store.js";

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
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "verification-repair"));
	assert.equal(state.stages[0]?.verification.repairCount, 1);
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
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "review-fix"));
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
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "repairable", { failure: { code: "e2e_failed", summary: "whole E2E contract failed" }, evidenceRefs: ["evidence/failed-run.txt"] });
	assert.equal(action(state, value).kind, "e2e-fix");
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e-fix"));
	assert.equal(action(state, value).kind, "e2e");
	assert.deepEqual(state.e2e.evidenceRefs, ["evidence/failed-run.txt"]);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "e2e"), "passed", { evidenceRefs: ["evidence/rerun.txt"] });
	assert.equal(state.e2e.status, "completed");
	assert.deepEqual(state.e2e.evidenceRefs, ["evidence/rerun.txt"]);
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

test("critical review approval requires and persists every explicit risk rationale", () => {
	const value = plan({ stages: [] });
	let state = initial(value);
	state = settle(advanceStageStateMachine(value, state).state, value, action(state, value, "final-review"), "critical", {
		failure: { code: "critical", summary: "critical risk" },
		findings: [{ id: "risk-a", severity: "critical", code: "security", summary: "critical security risk" }],
	});
	assert.equal(resolveWorkflowAttention(state, { action: "approve", acceptedRisks: [], acceptedAt: at }, 2).accepted, false);
	const approved = resolveWorkflowAttention(state, { action: "approve", acceptedRisks: [{ findingId: "risk-a", rationale: "User accepts this bounded deployment risk." }], acceptedAt: at }, 2);
	assert.equal(approved.accepted, true);
	assert.equal(approved.state.status, "paused");
	assert.equal(approved.state.finalReview.status, "completed");
	assert.deepEqual(approved.state.finalReview.acceptedRisks, [{ findingId: "risk-a", rationale: "User accepts this bounded deployment risk.", acceptedAt: at }]);
});
