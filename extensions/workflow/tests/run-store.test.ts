import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../errors.js";
import { HarnessRunStore } from "../run-store.js";
import { WorkflowControlStore, workflowControlFence } from "../../workflow-runtime/control-store.js";

test("authorizes immutable run scope with an unguessable credential", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-runs-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const created = await store.create({
		repositoryId: "repository",
		workItemId: "work-item",
		taskId: "task-one",
		role: "implementer",
		attempt: 1,
		state: "launching",
		workspace: "/workspace",
		baseCommit: "abc",
	});
	assert.equal((await store.authorize(created.record.id, created.credential)).taskId, "task-one");
	await assert.rejects(
		store.authorize(created.record.id, "wrong"),
		(error: unknown) => error instanceof HarnessError && error.code === "CAPABILITY_DENIED",
	);
	const updated = await store.update(created.record.id, { state: "running" }, "run.started");
	assert.equal(updated.state, "running");
	assert.equal("pid" in await store.read(created.record.id), false, "process identity belongs only to the live service");
	await assert.rejects(access(join(store.runRoot(created.record.id), "transcript.jsonl")), /ENOENT/, "Pi session and structured handoff replace the duplicate run transcript");
	await assert.rejects(access(join(store.runRoot(created.record.id), "events.jsonl")), /ENOENT/, "run events are consolidated into the repository stream");
	const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
	assert.deepEqual(events.filter((event) => event.data?.runId === created.record.id).map((event) => event.type), ["run.created", "run.started"]);
});

test("an interrupted workflow run revokes the crashed attempt and rejects a fresh bind", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-interruption-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const store = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const created = await store.create({ repositoryId: "repository", workItemId: "work-item", taskId: "task", role: "implementer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc" });
	await store.bindAgentAttempt(created.record.id, "crashed-attempt", 1);
	await store.update(created.record.id, { state: "running" }, "run.started");
	const [interrupted] = await store.recoverInterrupted();
	assert.equal(interrupted?.state, "interrupted");
	await assert.rejects(store.authorizeMutation(created.record.id, created.credential, "crashed-attempt", 1), /stale|revoked/);
	await assert.rejects(store.bindAgentAttempt(created.record.id, "fresh-attempt", 2), /interrupted|revoked/);
	assert.equal((await store.read(created.record.id)).state, "interrupted");
});

test("paused task and evaluator attempts can hand off and release without reopening launch authority", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-paused-handoff-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const control = new WorkflowControlStore(root);
	const started = await control.apply({ workflowRef: "work-item:work-item", command: "start", ...owner, operationId: "start" });
	const fence = workflowControlFence(started);
	const store = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const scope = { repositoryId: "repository", workItemId: "work-item", attempt: 1, state: "launching" as const, workspace: "/workspace", baseCommit: "abc", workflowGeneration: started.generation, workflowExecutionFence: started.executionFence, workflowOwnerProcessInstanceId: owner.processInstanceId, workflowOwnerActivationId: owner.activationId };
	const task = await store.create({ ...scope, taskId: "task", role: "implementer" });
	const evaluation = await store.create({ ...scope, evaluationId: "review", role: "reviewer" });
	await store.bindAgentAttempt(task.record.id, "task-attempt", 1, fence);
	await store.bindAgentAttempt(evaluation.record.id, "evaluation-attempt", 1, fence);
	await store.update(task.record.id, { state: "running" }, "run.started");
	await store.update(evaluation.record.id, { state: "running" }, "run.started");
	await control.apply({ workflowRef: "work-item:work-item", command: "pause", ...owner, operationId: "pause" });
	await assert.rejects(store.assertCanonicalMutationAllowed(task.record.id), /Stale workflow execution fence/);
	await assert.rejects(store.assertCanonicalMutationAllowed(evaluation.record.id), /Stale workflow execution fence/);
	await assert.rejects(store.updateForAgentAttempt(task.record.id, "task-attempt", 1, { state: "running" }, "run.spawned_late", fence), /Stale workflow execution fence/);

	await store.writeAuthorizedHandoff(task.record.id, task.credential, "task-attempt", 1, {
		schemaVersion: 1, type: "task_complete", runId: task.record.id, taskId: "task", summary: "done while paused", commits: ["a".repeat(40)], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
	});
	await store.releaseAgentAttempt(task.record.id, "task-attempt", 1, fence, { allowGenerationAdvance: true });
	await store.writeAuthorizedEvaluationHandoff(evaluation.record.id, evaluation.credential, "evaluation-attempt", 1, {
		schemaVersion: 1, type: "evaluation_complete", runId: evaluation.record.id, evaluationId: "review", verdict: "pass", report: "paused report", evidence: [], findings: [], completedAt: new Date().toISOString(),
	});
	await store.updateAuthorized(evaluation.record.id, evaluation.credential, "evaluation-attempt", 1, { state: "submitted" }, "run.submitted");
	await store.releaseAgentAttempt(evaluation.record.id, "evaluation-attempt", 1, fence, { allowGenerationAdvance: true });

	assert.ok(await store.readHandoff(task.record.id));
	assert.ok(await store.readEvaluationHandoff(evaluation.record.id));
	assert.equal((await store.read(task.record.id)).currentAgentAttemptId, undefined);
	assert.equal((await store.read(evaluation.record.id)).currentAgentAttemptId, undefined);
	await assert.rejects(store.bindAgentAttempt(task.record.id, "new-attempt", 2, fence), /Stale workflow execution fence/);
	await assert.rejects(store.assertAgentAttemptLaunchable(task.record.id, "task-attempt", 1, fence), /Stale workflow execution fence/);
});

test("stop after pause revokes task and evaluator attempts before late handoff", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-pause-stop-fence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const control = new WorkflowControlStore(root);
	const started = await control.apply({ workflowRef: "work-item:work-item", command: "start", ...owner, operationId: "start" });
	const fence = workflowControlFence(started);
	const store = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const scope = { repositoryId: "repository", workItemId: "work-item", attempt: 1, state: "launching" as const, workspace: "/workspace", baseCommit: "abc", workflowGeneration: started.generation, workflowExecutionFence: started.executionFence, workflowOwnerProcessInstanceId: owner.processInstanceId, workflowOwnerActivationId: owner.activationId };
	const task = await store.create({ ...scope, taskId: "task", role: "implementer" });
	const evaluation = await store.create({ ...scope, evaluationId: "review", role: "reviewer" });
	await store.bindAgentAttempt(task.record.id, "task-attempt", 1, fence);
	await store.bindAgentAttempt(evaluation.record.id, "evaluation-attempt", 1, fence);
	await store.update(task.record.id, { state: "running" }, "run.started");
	await store.update(evaluation.record.id, { state: "running" }, "run.started");
	await control.apply({ workflowRef: "work-item:work-item", command: "pause", ...owner, operationId: "pause" });
	await control.apply({ workflowRef: "work-item:work-item", command: "stop", ...owner, operationId: "stop" });
	await store.cancelUnfinished();

	for (const runId of [task.record.id, evaluation.record.id]) {
		const run = await store.read(runId);
		assert.equal(run.state, "cancelled");
		assert.equal(run.currentAgentAttemptId, undefined);
		assert.ok(run.credentialRevokedAt);
	}
	await assert.rejects(store.writeAuthorizedHandoff(task.record.id, task.credential, "task-attempt", 1, {
		schemaVersion: 1, type: "task_complete", runId: task.record.id, taskId: "task", summary: "late", commits: [], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
	}), /stale workflow execution fence|stopped or replaced workflow activation/i);
	await assert.rejects(store.writeAuthorizedEvaluationHandoff(evaluation.record.id, evaluation.credential, "evaluation-attempt", 1, {
		schemaVersion: 1, type: "evaluation_complete", runId: evaluation.record.id, evaluationId: "review", verdict: "pass", report: "late", evidence: [], findings: [], completedAt: new Date().toISOString(),
	}), /stale workflow execution fence|stopped or replaced workflow activation/i);
	assert.equal(await store.readHandoff(task.record.id), undefined);
	assert.equal(await store.readEvaluationHandoff(evaluation.record.id), undefined);
	await control.apply({ workflowRef: "work-item:work-item", command: "resume", ...owner, operationId: "resume" });
	await assert.rejects(store.authorizeMutation(evaluation.record.id, evaluation.credential, "evaluation-attempt", 1), /stopped or replaced workflow activation/, "resume cannot revive a credential fenced by stop");
});

test("bind is fenced across reload, takeover, and distinct run-store instances", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-bind-fence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const control = new WorkflowControlStore(root);
	const started = await control.apply({ workflowRef: "work-item:work-item", command: "start", ...owner, operationId: "start" });
	const first = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const second = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const active = await first.create({ repositoryId: "repository", workItemId: "work-item", taskId: "active", role: "implementer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc", workflowGeneration: started.generation, workflowExecutionFence: started.executionFence, workflowOwnerProcessInstanceId: owner.processInstanceId, workflowOwnerActivationId: owner.activationId });
	const prelaunch = await first.create({ repositoryId: "repository", workItemId: "work-item", taskId: "prelaunch", role: "implementer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc", workflowGeneration: started.generation, workflowExecutionFence: started.executionFence, workflowOwnerProcessInstanceId: owner.processInstanceId, workflowOwnerActivationId: owner.activationId });
	const startedFence = workflowControlFence(started);
	await first.bindAgentAttempt(active.record.id, "active-attempt", 1, startedFence);
	const reloaded = await control.apply({ workflowRef: "work-item:work-item", command: "attach", ...owner, operationId: "reload" });
	assert.ok(reloaded.generation > started.generation);
	assert.equal((await second.bindAgentAttempt(active.record.id, "active-attempt", 1, startedFence)).currentAgentAttemptId, "active-attempt", "an exact active-child rebind survives generation-only reload");
	await assert.rejects(second.bindAgentAttempt(prelaunch.record.id, "late-attempt", 1, startedFence), /stale prelaunch workflow generation/);
	assert.equal((await first.read(prelaunch.record.id)).currentAgentAttemptId, undefined);
	await assert.rejects(second.bindAgentAttempt(active.record.id, "replacement-attempt", 2, startedFence), /stale prelaunch|already has/);

	const takeover = { sessionId: "replacement", processInstanceId: "other-process", activationId: "other-activation" };
	await control.apply({ workflowRef: "work-item:work-item", command: "resume", ...takeover, operationId: "takeover" });
	await assert.rejects(first.bindAgentAttempt(active.record.id, "active-attempt", 1, startedFence), /[Ss]tale workflow execution fence/);
});

test("a stopped workflow wins atomically against a concurrent bind and cannot be revived", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-bind-stop-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const control = new WorkflowControlStore(root);
	const started = await control.apply({ workflowRef: "work-item:work-item", command: "start", ...owner, operationId: "start" });
	const first = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const second = new HarnessRunStore({ id: "repository", root: "/workspace", privateRoot: root }, "work-item");
	const created = await first.create({ repositoryId: "repository", workItemId: "work-item", taskId: "task", role: "implementer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc", workflowGeneration: started.generation, workflowExecutionFence: started.executionFence, workflowOwnerProcessInstanceId: owner.processInstanceId, workflowOwnerActivationId: owner.activationId });
	const [binding] = await Promise.allSettled([
		first.bindAgentAttempt(created.record.id, "attempt", 1, workflowControlFence(started)),
		control.apply({ workflowRef: "work-item:work-item", command: "stop", ...owner, operationId: "stop" }),
	]);
	await assert.rejects(second.bindAgentAttempt(created.record.id, "attempt", 1, workflowControlFence(started)), /[Ss]tale workflow execution fence/);
	if (binding.status === "fulfilled") await assert.rejects(first.authorizeMutation(created.record.id, created.credential, "attempt", 1), /stopped or replaced workflow activation/);
	else assert.match(binding.reason instanceof Error ? binding.reason.message : String(binding.reason), /[Ss]tale workflow execution fence/);
});

test("late task and evaluation handoffs are fenced by the current agent attempt", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-run-attempt-fence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repository = { id: "repository", root: "/workspace", privateRoot: root };
	const store = new HarnessRunStore(repository, "work-item");
	const task = await store.create({ repositoryId: "repository", workItemId: "work-item", taskId: "task-one", role: "implementer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc" });
	await store.bindAgentAttempt(task.record.id, "attempt-one", 1);
	await store.update(task.record.id, { state: "running" }, "run.started");
	await assert.rejects(store.bindAgentAttempt(task.record.id, "attempt-two", 2), /already has a current workflow agent attempt/);
	await store.releaseAgentAttempt(task.record.id, "attempt-one", 1);
	await store.bindAgentAttempt(task.record.id, "attempt-two", 2);
	await assert.rejects(store.writeAuthorizedHandoff(task.record.id, task.credential, "attempt-one", 1, {
		schemaVersion: 1, type: "task_complete", runId: task.record.id, taskId: "task-one", summary: "late", commits: [], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
	}), /stale workflow agent attempt/);
	await store.revokeAgentAttempt(task.record.id, "attempt-two", { state: "cancelled" }, "run.stop_requested");
	await assert.rejects(store.bindAgentAttempt(task.record.id, "attempt-three", 3), /cancelled|revoked/);
	await assert.rejects(store.writeAuthorizedHandoff(task.record.id, task.credential, "attempt-two", 2, {
		schemaVersion: 1, type: "task_complete", runId: task.record.id, taskId: "task-one", summary: "after stop", commits: [], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
	}), /stale workflow agent attempt|revoked/);
	assert.equal(await store.readHandoff(task.record.id), undefined);

	const evaluation = await store.create({ repositoryId: "repository", workItemId: "work-item", evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "abc" });
	await store.bindAgentAttempt(evaluation.record.id, "review-attempt", 1);
	await store.revokeAgentAttempt(evaluation.record.id, "review-attempt", { state: "interrupted" }, "run.owner_lost");
	await assert.rejects(store.writeAuthorizedEvaluationHandoff(evaluation.record.id, evaluation.credential, "review-attempt", 1, {
		schemaVersion: 1, type: "evaluation_complete", runId: evaluation.record.id, evaluationId: "review", verdict: "pass", report: "late report", evidence: [], findings: [], completedAt: new Date().toISOString(),
	}), /stale workflow agent attempt|revoked/);
	assert.equal(await store.readEvaluationHandoff(evaluation.record.id), undefined);
});
