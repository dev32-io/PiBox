import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAgentRegistry, type ProcessAttempt, type SessionAgentRecord } from "../../workflow-runtime/agent-registry.js";
import { LaunchCoordinator } from "../../workflow-runtime/launch-coordinator.js";
import { FakeSubagentService, fakeOwner } from "../../workflow-runtime/tests/fixtures/fake-subagent-service.js";
import { EvaluationSupervisor } from "../evaluation-supervisor.js";
import { HarnessRunStore } from "../run-store.js";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-evaluation-supervisor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity = { id: "repo", root: "/workspace", privateRoot: root };
	const runs = new HarnessRunStore(identity, "work-item");
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, new FakeSubagentService());
	return { root, runs, coordinator };
}

function attempt(): ProcessAttempt {
	const at = new Date().toISOString();
	return { id: "attempt-1", sequence: 1, state: "launching", startedAt: at, updatedAt: at };
}

function agent(): SessionAgentRecord {
	return { id: "agent-1" } as SessionAgentRecord;
}

test("evaluation stop waits through a late attempt bind and leaves its credential revoked", async (t) => {
	const f = await fixture(t);
	const created = await f.runs.create({ repositoryId: "repo", workItemId: "work-item", evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "a".repeat(40) });
	const supervisor = new EvaluationSupervisor();
	const managed = supervisor.begin("work-item", f.coordinator);
	await managed.attachRun(f.runs, created.record.id);
	let stopped = false;
	const stopping = supervisor.stopWorkItem("work-item").then((count) => { stopped = true; return count; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopped, false, "stop remains pending until the launch owner settles");
	await assert.rejects(managed.bindAttempt(agent(), attempt()), /cancelled|revoked/);
	const fenced = await f.runs.read(created.record.id);
	assert.equal(fenced.state, "cancelled");
	assert.equal(fenced.currentAgentAttemptId, undefined);
	assert.ok(fenced.credentialRevokedAt);
	managed.finish();
	assert.equal(await stopping, 1);
	await assert.rejects(f.runs.authorizeMutation(created.record.id, created.credential, "attempt-1", 1), /stale|revoked/);
});

test("a handoff written before stop cannot be claimed by late evaluator settlement", async (t) => {
	const f = await fixture(t);
	const created = await f.runs.create({ repositoryId: "repo", workItemId: "work-item", evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "a".repeat(40) });
	const supervisor = new EvaluationSupervisor();
	const managed = supervisor.begin("work-item", f.coordinator);
	await managed.attachRun(f.runs, created.record.id);
	await managed.bindAttempt(agent(), attempt());
	await f.runs.writeAuthorizedEvaluationHandoff(created.record.id, created.credential, "attempt-1", 1, {
		schemaVersion: 1, type: "evaluation_complete", runId: created.record.id, evaluationId: "review", verdict: "pass", report: "Report before stop", evidence: [], findings: [], completedAt: new Date().toISOString(),
	});
	const stopping = supervisor.stopWorkItem("work-item");
	managed.finish();
	await stopping;
	assert.throws(() => managed.assertActive(), /stopped workflow attempt/);
	assert.equal((await f.runs.read(created.record.id)).state, "cancelled");
	assert.ok(await f.runs.readEvaluationHandoff(created.record.id), "durable evidence remains for inspection but is not consumed");
});

test("activation shutdown stops and awaits every managed evaluator", async (t) => {
	const f = await fixture(t);
	const supervisor = new EvaluationSupervisor();
	const handles = [];
	for (const workItemId of ["first", "second"]) {
		const runs = new HarnessRunStore({ id: "repo", root: "/workspace", privateRoot: f.root }, workItemId);
		const created = await runs.create({ repositoryId: "repo", workItemId, evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "a".repeat(40) });
		const managed = supervisor.begin(workItemId, f.coordinator);
		await managed.attachRun(runs, created.record.id);
		handles.push({ managed, runs, runId: created.record.id });
	}
	let stopped = false;
	const stopping = supervisor.stopAll().then((count) => { stopped = true; return count; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopped, false);
	for (const { managed } of handles) managed.finish();
	assert.equal(await stopping, 2);
	for (const { runs, runId } of handles) assert.equal((await runs.read(runId)).state, "cancelled");
});

test("owner loss revokes an evaluator attempt before any handoff can arrive", async (t) => {
	const f = await fixture(t);
	const created = await f.runs.create({ repositoryId: "repo", workItemId: "work-item", evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: "/workspace", baseCommit: "a".repeat(40) });
	const managed = new EvaluationSupervisor().begin("work-item", f.coordinator);
	await managed.attachRun(f.runs, created.record.id);
	await managed.bindAttempt(agent(), attempt());
	await managed.revokeAttempt({ state: "interrupted", error: "owner lost" }, "run.owner_lost");
	await assert.rejects(f.runs.writeAuthorizedEvaluationHandoff(created.record.id, created.credential, "attempt-1", 1, {
		schemaVersion: 1, type: "evaluation_complete", runId: created.record.id, evaluationId: "review", verdict: "pass", report: "late", evidence: [], findings: [], completedAt: new Date().toISOString(),
	}), /stale|revoked/);
	managed.finish();
});
