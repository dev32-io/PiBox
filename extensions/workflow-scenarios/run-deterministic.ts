import assert from "node:assert/strict";
import { activateWorkflowAction, advanceStageStateMachine, createStoryRuntimeState, interruptOwnedAttempts, resolveWorkflowAttention, resumeInterruptedWorkflow, settleWorkflowAction, startWorkflow, type StageMachinePlan } from "../workflow/stage-state-machine.js";

const owner = { sessionId: "eval", processInstanceId: "eval-process", activationId: "eval-activation" };
const at = "2026-01-01T00:00:00.000Z";
let passed = 0;
function scenario(name: string, run: () => void): void { try { run(); passed++; console.log(`PASS ${name}`); } catch (error) { console.error(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; } }
function state(plan: StageMachinePlan) { return startWorkflow(createStoryRuntimeState(plan, { storyId: "eval-story", contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} }, git: { canonicalBranch: "feature/eval", baseCommit: "abc" } }), owner); }

scenario("ordered-stage-train", () => {
	const plan: StageMachinePlan = { stages: [{ id: "first", mode: "sequential", tasks: [{ id: "a" }, { id: "b" }], checks: [], review: { mode: "skip" } }, { id: "second", mode: "sequential", tasks: [{ id: "c" }], checks: [], review: { mode: "skip" } }] };
	let current = state(plan); let next = advanceStageStateMachine(plan, current); assert.deepEqual(next.actions.map((action) => action.taskId), ["a"]);
	const action = next.actions[0]!; current = activateWorkflowAction(next.state, action, "token-a", owner, at); current = settleWorkflowAction(current, { action, token: "token-a", owner, result: "passed", contributionCommit: "a" }, 2).state;
	next = advanceStageStateMachine(plan, current); assert.deepEqual(next.actions.map((candidate) => candidate.taskId), ["b"]); assert.equal(next.state.stages[1]?.status, "pending");
});

scenario("concurrent-stage-batch", () => {
	const plan: StageMachinePlan = { stages: [{ id: "parallel", mode: "concurrent", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }], checks: [], review: { mode: "skip" } }] };
	assert.deepEqual(advanceStageStateMachine(plan, state(plan)).actions.map((action) => action.taskId), ["a", "b", "c"]);
});

scenario("bounded-check-repair", () => {
	const plan: StageMachinePlan = { stages: [{ id: "delivery", mode: "sequential", tasks: [{ id: "a", checks: [{ id: "unit" }] }], checks: [], review: { mode: "skip" } }] };
	let current = state(plan); let next = advanceStageStateMachine(plan, current); let action = next.actions[0]!;
	current = settleWorkflowAction(activateWorkflowAction(next.state, action, "implement", owner, at), { action, token: "implement", owner, result: "passed", contributionCommit: "commit" }, 2).state;
	next = advanceStageStateMachine(plan, current); action = next.actions[0]!; current = settleWorkflowAction(activateWorkflowAction(next.state, action, "check", owner, at), { action, token: "check", owner, result: "repairable", failure: { code: "failed", summary: "unit failed" }, checks: [{ id: "unit", status: "failed" }] }, 2).state;
	assert.equal(advanceStageStateMachine(plan, current).actions[0]?.kind, "task-repair");
});

scenario("owner-loss-fencing-and-fresh-resume", () => {
	const plan: StageMachinePlan = { stages: [{ id: "delivery", mode: "sequential", tasks: [{ id: "a" }], checks: [], review: { mode: "skip" } }] };
	const action = advanceStageStateMachine(plan, state(plan)).actions[0]!;
	const active = activateWorkflowAction(state(plan), action, "old-token", owner, at);
	const interrupted = interruptOwnedAttempts(active, owner);
	assert.equal(interrupted.status, "paused");
	const replacement = { sessionId: "eval", processInstanceId: "new-process", activationId: "new-activation" };
	const resumed = resumeInterruptedWorkflow(interrupted, replacement);
	const freshAction = advanceStageStateMachine(plan, resumed).actions[0]!;
	const fresh = activateWorkflowAction(resumed, freshAction, "fresh-token", replacement, at);
	assert.equal(settleWorkflowAction(fresh, { action, token: "old-token", owner, result: "passed" }, 2).accepted, false);
	assert.equal(settleWorkflowAction(fresh, { action: freshAction, token: "fresh-token", owner: replacement, result: "passed", contributionCommit: "fresh" }, 2).accepted, true);
});

scenario("critical-review-user-authority", () => {
	const plan: StageMachinePlan = { stages: [] };
	let current = state(plan);
	const action = advanceStageStateMachine(plan, current).actions[0]!;
	current = settleWorkflowAction(activateWorkflowAction(current, action, "review", owner, at), { action, token: "review", owner, result: "passed", findings: [{ id: "risk", severity: "critical", code: "security", summary: "critical risk" }] }, 2).state;
	assert.equal(current.status, "attention");
	assert.equal(resolveWorkflowAttention(current, { action: "approve", acceptedRisks: [], acceptedAt: at }, 2).accepted, false);
	const accepted = resolveWorkflowAttention(current, { action: "approve", acceptedRisks: [{ findingId: "risk", rationale: "explicitly accepted for this deployment" }], acceptedAt: at }, 2);
	assert.equal(accepted.accepted, true);
	assert.equal(accepted.state.finalReview.acceptedRisks?.[0]?.findingId, "risk");
});

console.log(`Workflow target evaluation: ${passed}/5 passed`);
