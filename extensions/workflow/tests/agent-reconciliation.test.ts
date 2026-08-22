import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SessionAgentRegistry } from "../../workflow-runtime/agent-registry.js";
import { reconcileReportedAgents } from "../agent-reconciliation.js";
import { finalizeReviewerAfterSettlement, reusableReviewerAgentId, settleManagedEvaluation } from "../evaluation-settlement.js";
import { RepositoryMutex } from "../idempotency.js";
import { HarnessRunStore } from "../run-store.js";
import { discoverRepository } from "../repository.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> { return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim(); }

 test("two concurrent reconcileReportedAgents calls settle one evaluation attempt and one run.reconciled_completed event", async (t) => {
	const parent = await mkdtemp(join(tmpdir(), "pibox-reconcile-")); t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo"); await git(parent, "init", "--quiet", root); await git(root, "config", "user.name", "Harness Test"); await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n"); await writeFile(join(root, ".gitignore"), "/.pibox/\n"); await git(root, "add", "README.md", ".gitignore"); await git(root, "commit", "--quiet", "-m", "initial"); await git(root, "branch", "-M", "develop");
	const identity = await discoverRepository(root, join(parent, "home")); const store = new WorkItemStore(root);
	await store.create({ id: "review", title: "Review", kind: "change", branchKind: "feature", intent: "reconcile" });
	await store.defineEvaluation("review", { schemaVersion: 1, id: "evaluation", type: "deterministic", scope: { workItem: "review" }, status: "planned", required: true, attempt: 0, methods: ["test"] });
	assert.equal(await git(root, "status", "--porcelain"), "", "fixture must be clean before reconciliation");
	const runs = new HarnessRunStore(identity, "review");
	const created = await runs.create({ repositoryId: identity.id, workItemId: "review", evaluationId: "evaluation", role: "reviewer", attempt: 1, state: "running", workspace: root, baseCommit: await git(root, "rev-parse", "HEAD"), planningRevision: (await store.read("review")).planning.revision });
	await runs.writeEvaluationHandoff(created.record.id, { schemaVersion: 1, type: "evaluation_complete", runId: created.record.id, evaluationId: "evaluation", verdict: "fail", report: "finding", evidence: [], findings: [{ id: "F1", severity: "high", status: "open", summary: "finding", blocking: true }], completedAt: new Date().toISOString() });
	const agent: any = { id: "reviewer-agent", sessionId: "session", parentAgentId: "main", depth: 1, role: "code-reviewer", state: "reported", provider: "test", model: "test", effort: "low", operationId: "review-op", assignmentDigest: "digest", assignmentPath: "assignment", attempts: [], workItemId: "review", evaluationId: "evaluation", runId: created.record.id, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
	const registry: any = { async list() { return [agent]; }, async get() { return agent; }, async transition(_id: string, state: string) { agent.state = state; return agent; } };
	const input = { identity, registry, workItems: store, mutex: new RepositoryMutex(identity.commonDir ?? identity.root) };
	const [first, second] = await Promise.all([reconcileReportedAgents(input), reconcileReportedAgents(input)]);
	assert.deepEqual([...first.errors, ...second.errors], [], JSON.stringify({ first, second }));
	const evaluation = await store.readEvaluation("review", "evaluation");
	assert.equal(evaluation.attempt, 1);
	assert.equal(evaluation.loop?.state, "awaiting_manager");
	assert.equal(evaluation.loop?.reviewerAgentId, agent.id);
	assert.equal(agent.state, "reported", "a failed reviewer must remain reusable for re-review");
	assert.equal((await runs.read(created.record.id)).state, "completed");
	const events = (await readFile(join(identity.privateRoot, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
	assert.equal(events.filter((event) => event.data?.runId === created.record.id && event.type === "run.reconciled_completed").length, 1);
	assert.equal(await git(root, "status", "--porcelain"), "");
});

test("failed canonical evaluation settlement stops projecting the exited run as active", async () => {
	let run = { workItemId: "review", evaluationId: "evaluation", attempt: 1, state: "running" };
	const runs = {
		async read() { return run; },
		async update(_runId: string, patch: Record<string, unknown>) { run = { ...run, ...patch } as typeof run; return run; },
	};
	const workItems = {
		coordinator: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
		async readEvaluation() { throw new Error("invalid directory evidence"); },
	};
	await assert.rejects(settleManagedEvaluation({
		workItems: workItems as any,
		runs: runs as any,
		workItemId: "review",
		evaluationId: "evaluation",
		runId: "run-id",
		handoff: { schemaVersion: 1, type: "evaluation_complete", runId: "run-id", evaluationId: "evaluation", verdict: "fail", report: "failed", evidence: [], findings: [], completedAt: new Date().toISOString() },
		reviewerAgentId: "reviewer",
		reviewedCommit: "a".repeat(40),
		exitCode: 0,
		completionEvent: "run.completed",
	}), /invalid directory evidence/);
	assert.equal(run.state, "failed");
	assert.match(String((run as any).error), /Evaluation settlement failed/);
});

test("reviewer lifecycle follows verdict and replaces terminal legacy identities", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-reviewer-lifecycle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "reviewer-lifecycle");
	await registry.initialize("main:reviewer-lifecycle");
	const reportedReviewer = async (operationId: string) => {
		const agent = await registry.reserve({ operationId, parentAgentId: "main:reviewer-lifecycle", parentDepth: 0, role: "code-reviewer", provider: "test", model: "fake", effort: "low", assignment: {} });
		const { attempt } = await registry.startAttempt(agent.id);
		await registry.markRunning(agent.id, attempt.id, process.pid);
		await registry.recordExit(agent.id, attempt.id, 0);
		await registry.transition(agent.id, "reported");
		return agent.id;
	};
	const failed = await reportedReviewer("failed-reviewer");
	assert.equal(await finalizeReviewerAfterSettlement(registry, failed, "fail"), "reusable");
	assert.equal((await registry.get(failed)).state, "reported");
	assert.equal(await reusableReviewerAgentId(registry, failed), failed);

	const passed = await reportedReviewer("passed-reviewer");
	assert.equal(await finalizeReviewerAfterSettlement(registry, passed, "pass"), "completed");
	assert.equal((await registry.get(passed)).state, "completed");
	assert.equal(await reusableReviewerAgentId(registry, passed), undefined, "a corrupted persisted terminal reviewer must be replaced");
	assert.equal(await reusableReviewerAgentId(registry, "missing-reviewer"), undefined);
});

test("live settlement and reconciliation remain idempotent across every review/fix loop", async (t) => {
	const cases = [
		{ id: "stage-review", type: "combined-review" as const, checkpoint: "stage-review" as const, reconciliationFirst: false },
		{ id: "final-e2e", type: "e2e" as const, checkpoint: "final-e2e" as const, reconciliationFirst: true },
		{ id: "final-review", type: "combined-review" as const, checkpoint: "final-review" as const, reconciliationFirst: false },
	];
	for (const scenario of cases) await t.test(scenario.id, async (t) => {
		const parent = await mkdtemp(join(tmpdir(), `pibox-${scenario.id}-race-`));
		t.after(() => rm(parent, { recursive: true, force: true }));
		const root = join(parent, "repo");
		await git(parent, "init", "--quiet", root);
		await git(root, "config", "user.name", "Harness Test");
		await git(root, "config", "user.email", "harness@example.test");
		await writeFile(join(root, "README.md"), "fixture\n");
		await writeFile(join(root, ".gitignore"), "/.pibox/\n");
		await git(root, "add", "README.md", ".gitignore");
		await git(root, "commit", "--quiet", "-m", "initial");
		await git(root, "branch", "-M", "develop");
		const identity = await discoverRepository(root, join(parent, "home"));
		const store = new WorkItemStore(root);
		await store.create({ id: scenario.id, title: scenario.id, kind: "change", branchKind: "feature", intent: "exercise managed evaluation settlement" });
		await store.defineEvaluation(scenario.id, {
			schemaVersion: 1,
			id: "evaluation",
			type: scenario.type,
			checkpoint: scenario.checkpoint,
			...(scenario.checkpoint === "stage-review" ? { stageId: "delivery" } : {}),
			scope: { workItem: scenario.id },
			status: "planned",
			required: true,
			attempt: 0,
			methods: ["test"],
			loop: { state: "planned", iteration: 0, maxIterations: 3 },
		});
		const runs = new HarnessRunStore(identity, scenario.id);
		const baseCommit = await git(root, "rev-parse", "HEAD");
		const created = await runs.create({ repositoryId: identity.id, workItemId: scenario.id, evaluationId: "evaluation", role: scenario.type === "e2e" ? "e2e-tester" : "code-reviewer", attempt: 1, state: "running", workspace: root, baseCommit, planningRevision: (await store.read(scenario.id)).planning.revision });
		const handoff = { schemaVersion: 1 as const, type: "evaluation_complete" as const, runId: created.record.id, evaluationId: "evaluation", verdict: "fail" as const, report: "bounded finding", evidence: [{ path: "README.md:1-1", result: "source inspected" }], findings: [{ id: "F1", severity: "high" as const, status: "open" as const, summary: "repair this", blocking: true }], completedAt: new Date().toISOString() };
		await runs.writeEvaluationHandoff(created.record.id, handoff);
		const registry = new SessionAgentRegistry(identity.privateRoot, `session-${scenario.id}`);
		await registry.initialize(`main:${scenario.id}`);
		const reserved = await registry.reserve({ operationId: created.record.id, parentAgentId: `main:${scenario.id}`, parentDepth: 0, role: created.record.role, provider: "test", model: "fake", effort: "low", assignment: {}, workItemId: scenario.id, evaluationId: "evaluation", runId: created.record.id, workspace: root });
		const firstAttempt = await registry.startAttempt(reserved.id, { provider: "test", model: "fake", effort: "low" }, { kind: "review", generation: 0 });
		await registry.markRunning(reserved.id, firstAttempt.attempt.id, process.pid);
		await registry.recordExit(reserved.id, firstAttempt.attempt.id, 0);
		await registry.transition(reserved.id, "reported", { summary: "review failed" });
		const reconciliation = () => reconcileReportedAgents({ identity, registry, workItems: store, mutex: new RepositoryMutex(identity.commonDir ?? identity.root) });
		const liveSettlement = () => settleManagedEvaluation({ workItems: store, runs, workItemId: scenario.id, evaluationId: "evaluation", runId: created.record.id, handoff, reviewerAgentId: reserved.id, reviewedCommit: baseCommit, exitCode: 0, completionEvent: "run.completed" });
		if (scenario.reconciliationFirst) await Promise.all([reconciliation(), liveSettlement()]);
		else await Promise.all([liveSettlement(), reconciliation()]);
		await reconciliation();

		const evaluation = await store.readEvaluation(scenario.id, "evaluation");
		assert.equal(evaluation.attempt, 1);
		assert.equal(evaluation.loop?.state, "awaiting_manager");
		assert.equal(evaluation.loop?.reviewerAgentId, reserved.id);
		assert.equal(evaluation.loop?.reviewedCommit, baseCommit);
		assert.equal((await registry.get(reserved.id)).state, "reported");
		const evaluationLog = await git(root, "log", "--format=%s", "--", `agent-artifacts/${scenario.id}/evaluations/evaluation/evaluation.yaml`);
		assert.equal(evaluationLog.split("\n").filter((line) => line.includes("record evaluation")).length, 1);
		const runEvents = (await readFile(join(identity.privateRoot, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
		assert.equal(runEvents.filter((event) => event.data?.runId === created.record.id && (event.type === "run.completed" || event.type === "run.reconciled_completed")).length, 1);
		await assert.rejects(readFile(join(root, "agent-artifacts", scenario.id, "evaluations", "evaluation", "attempts", "002-report.md")), /ENOENT/);

		await store.updateEvaluationLoop(scenario.id, "evaluation", { state: "rereviewing", iteration: 1 });
		const secondRun = await runs.create({ repositoryId: identity.id, workItemId: scenario.id, evaluationId: "evaluation", role: created.record.role, attempt: 2, state: "running", workspace: root, baseCommit: await git(root, "rev-parse", "HEAD"), planningRevision: (await store.read(scenario.id)).planning.revision });
		await registry.bindScope(reserved.id, { runId: secondRun.record.id });
		const secondAttempt = await registry.startAttempt(reserved.id, { provider: "test", model: "fake", effort: "low" }, { kind: "review", generation: 1 });
		assert.equal(secondAttempt.attempt.sequence, 2, "the same logical reviewer must remain reusable after repair");
		assert.equal(await git(root, "status", "--porcelain"), "");
	});
});

