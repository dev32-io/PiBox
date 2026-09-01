import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { SessionAgentRegistry } from "../../workflow-runtime/agent-registry.js";
import { WorkflowControlStore } from "../../workflow-runtime/control-store.js";
import { createHarnessWorkflowAdapter } from "../workflow-adapter.js";
import { RepositoryEventStore } from "../event-store.js";
import { discoverRepository } from "../repository.js";
import { WorkflowEventJournal } from "../workflow-events.js";
import { RepairRecoveryStore } from "../repair-recovery.js";
import { HarnessRunStore } from "../run-store.js";

const exec = promisify(execFile);

function task(id: string, status: string, dependsOn: string[] = [], stageId = "delivery") {
	return { id, title: id, status, dependsOn, execution: { resourceClaims: [id] }, assembly: { stageId } };
}

async function evaluationStep(evaluation: any, agents: any[]) {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: evaluation.id }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return agents; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), launchRepair: async () => ({ content: [] }) });
	return (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
}

test("lifecycle subscription wakes across registry instances after session replacement", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-lifecycle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const observed = new SessionAgentRegistry(root, "session-1");
	await observed.initialize();
	const writer = new SessionAgentRegistry(root, "session-1");
	const runtime: any = { agents: observed };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let wake!: () => void;
	const awakened = new Promise<void>((resolve) => { wake = resolve; });
	const dispose = await adapter.subscribeLifecycle?.("work-item:example", {} as any, wake);
	await writer.reserve({ operationId: "cross-instance", parentAgentId: "main:session-1", parentDepth: 0, role: "repair-implementer", provider: "test", model: "fake", effort: "low", assignment: {}, workItemId: "example" });
	await Promise.race([awakened, new Promise((_, reject) => setTimeout(() => reject(new Error("adapter lifecycle wake-up timed out")), 1_000))]);
	if (typeof dispose === "function") dispose();
});

test("replays durable verification events into lifecycle notices", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-verification-events-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const agents = new SessionAgentRegistry(root, "session-1");
	await agents.initialize();
	const identity: any = { id: "repo", root, privateRoot: root };
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	const runtime: any = { identity, agents, events };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let resolveNotice!: (value: any) => void;
	const notice = new Promise<any>((resolve) => { resolveNotice = resolve; });
	const dispose = await adapter.subscribeLifecycle?.("work-item:example", {} as any, (update) => { if (update) resolveNotice(update); });
	await events.append("verification.attempt.started", { workItemId: "example", stageId: "delivery", checkId: "ios", attemptId: "004", candidateCommit: "a".repeat(40) });
	const projected = await Promise.race([notice, new Promise((_, reject) => setTimeout(() => reject(new Error("verification event notice timed out")), 1_000))]);
	assert.match(projected.title, /Verifying · delivery · ios/);
	assert.match(projected.detail, /attempt 004 · candidate a{12}/);
	if (typeof dispose === "function") dispose();
});

test("reload lists only controls owned by the live activation and explicit resume claims stale controls", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-activation-control-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let owner = { sessionId: "session", processInstanceId: "process-a", activationId: "activation-a" };
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: root },
		coordinator: { service: { get owner() { return owner; } } },
		workItems: {},
	};
	const ctx: any = { sessionManager: { getSessionId: () => "session" } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	await adapter.controlExecution!("work-item:example", "start", "start", ctx);
	assert.equal((await adapter.listExecutionControls!(ctx)).length, 1);
	owner = { sessionId: "session", processInstanceId: "process-b", activationId: "activation-b" };
	assert.deepEqual(await adapter.listExecutionControls!(ctx), [], "a replacement process never auto-adopts the persisted session control");
	const resumed = await adapter.controlExecution!("work-item:example", "resume", "explicit-resume", ctx);
	assert.equal(resumed.ownerActivationId, "activation-b");
	assert.equal((await adapter.listExecutionControls!(ctx)).length, 1);
});

test("workflow preparation serializes branch setup, execution state, and task activation", async () => {
	const calls: string[] = [];
	let insideMutex = false;
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async submitPlanning() { calls.push(`submit:${insideMutex}`); },
			async beginExecution(id: string) { calls.push(`begin:${insideMutex}`); return { id, phase: "execution", planning: { revision: 1 } }; },
			async ensureFinalEvaluations() { calls.push(`final:${insideMutex}`); return []; },
			async activateDraftTasks() { calls.push(`activate:${insideMutex}`); return []; },
		},
		mutex: { async run(_owner: string, operation: () => Promise<unknown>) { insideMutex = true; try { return await operation(); } finally { insideMutex = false; } } },
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), validateWorkingBranch: async () => { calls.push(`branch:${insideMutex}`); } });
	await adapter.prepareWorkflow?.("work-item:example", {} as any);
	assert.deepEqual(calls, ["submit:true", "branch:true", "begin:true", "final:true", "activate:true"]);
});

test("runStep forwards the runner abort signal to managed task and evaluation launches", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-run-signal-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const controller = new AbortController();
	const seen: AbortSignal[] = [];
	const item: any = { id: "example", planning: { revision: 1 }, tasks: [{ id: "task" }], evaluations: [{ id: "review" }] };
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: root },
		workItems: {
			async read() { return item; },
			async readTask() { return { ...task("task", "ready"), status: "ready" }; },
			async readEvaluation() { return { id: "review", status: "ready", scope: "stage" }; },
		},
	};
	const adapter = createHarnessWorkflowAdapter({
		runtimeFor: async () => runtime,
		launchTask: async (_ctx, _workItemId, _taskId, signal) => { seen.push(signal!); return { content: [] }; },
		launchEvaluation: async (_ctx, _workItemId, _evaluationId, signal) => { seen.push(signal!); return { content: [] }; },
	});
	await adapter.runStep("work-item:example/task:task", {} as any, controller.signal);
	await adapter.runStep("work-item:example/evaluation:review", {} as any, controller.signal);
	assert.equal(seen.length, 2);
	assert.ok(seen.every((signal) => !signal.aborted));
	controller.abort(new DOMException("runner stopped", "AbortError"));
	assert.ok(seen.every((signal) => signal.aborted), "the operation-registry signal preserves runner abort propagation");
});

test("reload then stop fences a repair before spawn and canonical mutation", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-reload-stop-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "--quiet"], { cwd: root });
	await exec("git", ["config", "user.name", "Harness Test"], { cwd: root });
	await exec("git", ["config", "user.email", "harness@example.test"], { cwd: root });
	await writeFile(join(root, "README.md"), "# Canonical baseline\n");
	await writeFile(join(root, ".gitignore"), "/workflow-control/\n/work-items/\n");
	await exec("git", ["add", "README.md", ".gitignore"], { cwd: root });
	await exec("git", ["commit", "--quiet", "-m", "baseline"], { cwd: root });
	const canonicalHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim();
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const controls = new WorkflowControlStore(root);
	const started = await controls.apply({ workflowRef: "work-item:reload-stop", command: "start", ...owner, operationId: "start" });
	const expected = { workflowRef: started.workflowRef, mode: started.mode, generation: started.generation, executionFence: started.executionFence, ownerProcessInstanceId: owner.processInstanceId, ownerActivationId: owner.activationId };
	const item: any = { id: "reload-stop", planning: { revision: 1 }, tasks: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", status: "failed", loop: { state: "fixing", iteration: 0, managerPrompt: "Repair accepted finding" } };
	let childLaunches = 0;
	let canonicalCommits = 0;
	let enterRepair!: () => void;
	let releasePrelaunch!: () => void;
	const entered = new Promise<void>((resolve) => { enterRepair = resolve; });
	const prelaunch = new Promise<void>((resolve) => { releasePrelaunch = resolve; });
	const runtime: any = {
		identity: { id: "repo", root, privateRoot: root },
		workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return []; } },
		coordinator: { async stop() { return false; } },
	};
	const options: any = {
		runtimeFor: async () => runtime,
		launchTask: async () => ({ content: [] }),
		launchEvaluation: async () => ({ content: [] }),
		launchRepair: async (_ctx: unknown, _workItemId: string, _evaluationId: string, signal: AbortSignal, execution: typeof expected) => {
			enterRepair();
			await prelaunch;
			if (signal.aborted) throw signal.reason;
			await controls.assertFence({ workflowRef: execution.workflowRef, generation: execution.generation, executionFence: execution.executionFence, ownerProcessInstanceId: execution.ownerProcessInstanceId, ownerActivationId: execution.ownerActivationId });
			childLaunches += 1;
			await controls.runIfCurrent({ workflowRef: execution.workflowRef, generation: execution.generation, executionFence: execution.executionFence, ownerProcessInstanceId: execution.ownerProcessInstanceId, ownerActivationId: execution.ownerActivationId }, async () => {
				await writeFile(join(root, "repair-commit.txt"), "stale repair mutation\n");
				await exec("git", ["add", "repair-commit.txt"], { cwd: root });
				await exec("git", ["commit", "--quiet", "-m", "stale repair"], { cwd: root });
				canonicalCommits += 1;
			});
			return { content: [] };
		},
	};
	const beforeReload = createHarnessWorkflowAdapter(options);
	const staleRepair = beforeReload.runStep("work-item:reload-stop/evaluation:review", {} as any, undefined, expected).then(() => undefined, (error) => error);
	await entered;
	await controls.apply({ workflowRef: "work-item:reload-stop", command: "attach", ...owner, operationId: "reload" });
	await controls.apply({ workflowRef: "work-item:reload-stop", command: "stop", ...owner, operationId: "stop" });
	const replacement = createHarnessWorkflowAdapter(options);
	const stopping = replacement.controlWorkflow!("work-item:reload-stop", "stop", {} as any);
	await new Promise((resolve) => setImmediate(resolve));
	releasePrelaunch();
	await stopping;
	const failure = await staleRepair;
	assert.match(failure instanceof Error ? failure.name : String(failure), /AbortError/);
	assert.equal(childLaunches, 0, "the stale prelaunch repair never reaches the child service");
	assert.equal(canonicalCommits, 0, "the stale prelaunch repair never reaches canonical mutation");
	assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim(), canonicalHead, "canonical HEAD remains byte-for-byte at the pre-reload commit");
	await assert.rejects(readFile(join(root, "repair-commit.txt")), /ENOENT/);
});

test("resume prepares stopped tasks from current dependency state", async () => {
	const tasks: any[] = [task("first", "integrated"), task("second", "cancelled", ["first"]), task("third", "failed", ["second"])];
	const item: any = { id: "example", planning: { revision: 1 }, delivery: { workingBranch: "feature/example", createdFromCommit: "a".repeat(40) }, tasks: tasks.map(({ id }) => ({ id })), integrationUnits: [], evaluations: [] };
	const updates: Array<[string, string]> = [];
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async submitPlanning() {},
			async beginExecution() { return item; },
			async ensureFinalEvaluations() { return []; },
			async activateDraftTasks() { return []; },
			async read() { return item; },
			async readTask(_workItemId: string, id: string) { return tasks.find((entry) => entry.id === id); },
			async updateTask(_workItemId: string, id: string, update: any) { updates.push([id, update.status]); tasks.find((entry) => entry.id === id).status = update.status; },
		},
		mutex: { async run(_owner: string, operation: () => Promise<unknown>) { return operation(); } },
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), validateWorkingBranch: async () => {} });
	await adapter.controlWorkflow("work-item:example", "resume", {} as any);
	assert.deepEqual(updates, [["second", "ready"], ["third", "blocked"]]);
});

test("resume preserves and reopens the same failed fixer on its unchanged dirty workspace", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-repair-resume-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "source.txt"), "base\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-qm", "fixture"], { cwd: root });
	const identity = await discoverRepository(root);
	await writeFile(join(root, "source.txt"), "partial repair\n");
	const recovery = new RepairRecoveryStore(identity);
	await recovery.record({ workItemId: "example", evaluationId: "review", agentId: "fixer", operationId: "repair:example:review:1", iteration: 1 });
	const item: any = { id: "example", tasks: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", loop: { state: "fixing", iteration: 0, fixerAgentId: "fixer" } };
	let prepared = ""; let allowDirty: boolean | undefined;
	const runtime: any = {
		identity,
		workItems: { async read() { return item; }, async readEvaluation() { return evaluation; }, async readTask() { throw new Error("none"); } },
		agents: { async get() { return { id: "fixer", state: "failed" }; }, async prepareRetry(id: string) { prepared = id; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), validateWorkingBranch: async (_runtime, _id, options) => { allowDirty = options?.allowDirty; } });
	await adapter.controlWorkflow("work-item:example", "resume", {} as any);
	assert.equal(prepared, "fixer");
	assert.equal(allowDirty, true);
	assert.equal(await readFile(join(root, "source.txt"), "utf8"), "partial repair\n");
});

test("explicit resume reconstructs missing recovery for a clean successful reported fixer", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-reported-repair-resume-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "source.txt"), "completed repair\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-qm", "completed repair"], { cwd: root });
	const identity = await discoverRepository(root);
	const item: any = { id: "example", tasks: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", loop: { state: "fixing", iteration: 1, fixerAgentId: "fixer" } };
	const fixer: any = { id: "fixer", operationId: "repair:example:review:1", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited", exitCode: 0, activity: { kind: "repair", generation: 2 } }] };
	let prepared = "";
	const runtime: any = {
		identity,
		workItems: { async read() { return item; }, async readEvaluation() { return evaluation; }, async readTask() { throw new Error("none"); } },
		agents: { async get() { return fixer; }, async prepareRetry(id: string) { prepared = id; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), validateWorkingBranch: async () => {} });
	await adapter.controlWorkflow("work-item:example", "resume", {} as any);
	const recovery = await new RepairRecoveryStore(identity).read("example", "review");
	assert.equal(recovery?.agentId, "fixer");
	assert.equal(recovery?.head, (await exec("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })).stdout.trim());
	assert.equal(recovery?.dirty, false);
	assert.equal(prepared, "fixer");
});

test("resume refuses to reconstruct missing reported-fixer recovery from a dirty workspace", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-dirty-reported-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "source.txt"), "base\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-qm", "base"], { cwd: root });
	await writeFile(join(root, "source.txt"), "unfenced work\n");
	const identity = await discoverRepository(root);
	const item: any = { id: "example", tasks: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", loop: { state: "fixing", iteration: 1, fixerAgentId: "fixer" } };
	const fixer: any = { id: "fixer", operationId: "repair:example:review:1", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited", exitCode: 0 }] };
	const runtime: any = {
		identity,
		workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } },
		agents: { async get() { return fixer; }, async prepareRetry() { throw new Error("must not prepare"); } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	await assert.rejects(adapter.controlWorkflow("work-item:example", "resume", {} as any), /working branch has uncommitted changes/i);
	assert.equal(await new RepairRecoveryStore(identity).read("example", "review"), undefined);
});

test("renders the final E2E fix loop with journey-specific queued and active phases", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "final-e2e" }] };
	const evaluation: any = { id: "final-e2e", type: "e2e", checkpoint: "final-e2e", scope: { workItem: "example" }, status: "planned", required: true, attempt: 1, methods: [], loop: { state: "rereviewing", iteration: 2, maxIterations: 3 } };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.length, 1);
	assert.match(snapshot.steps[0]!.title, /E2E journey\/fix loop · Journey re-run queued/);
	assert.doesNotMatch(snapshot.steps[0]!.title, /Review requested|Reviewing/);
	assert.equal(snapshot.steps[0]!.checkpoint, "final-e2e");
	assert.equal(snapshot.steps[0]!.status, "ready");
});

test("renders the whole-branch review-fix loop with branch-specific active phases", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "final-branch-review" }] };
	const evaluation: any = { id: "final-branch-review", type: "combined-review", checkpoint: "final-review", scope: { workItem: "example" }, status: "planned", required: true, attempt: 1, methods: [], loop: { state: "reviewing", iteration: 0, maxIterations: 3, reviewerAgentId: "reviewer" } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "final-branch-review", state: "running", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "running", activity: { kind: "review", generation: 0 } }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [reviewer]; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
	assert.equal(step.status, "running");
	assert.equal(step.checkpoint, "final-review");
	assert.match(step.title, /Whole-branch review\/fix loop · Reviewing whole branch/);
	assert.doesNotMatch(step.title, /Review requested/);
});

test("an active reviewer is the only source of Re-reviewing wording", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "planned", scope: { workItem: "example" }, loop: { state: "rereviewing", iteration: 2, maxIterations: 3, reviewerAgentId: "reviewer" } };
	const reviewer = { id: "reviewer", role: "code-reviewer", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", evaluationId: "review", state: "running", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "running", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", tier: "high", fast: true, startedAt: "2026-01-01T00:00:00.000Z", activity: { kind: "review", generation: 2 }, progress: { startedAt: "2026-01-01T00:00:00.000Z", lastEventAt: "2026-01-01T00:00:05.000Z", turns: 2, toolCalls: 3, toolErrors: 0, outputTokens: 1450, reasoningTokens: 20 } }] };
	const liveProgress = { startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z", lastEventAt: "2026-01-01T00:00:06.000Z", turns: 4, toolCalls: 5, toolErrors: 0, outputTokens: 1800, reasoningTokens: 25, activeTool: "read" };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [reviewer]; } }, coordinator: { inspect() { return { state: "running", provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", fast: true, startedAt: "2026-01-01T00:00:00.000Z", progress: liveProgress }; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
	assert.equal(step.status, "running");
	assert.match(step.title, /Re-reviewing #2/);
	assert.equal(step.progress?.turns, 4, "the in-memory service snapshot supplies live progress without durable sampling");
	assert.equal(step.progress?.outputTokens, 1800);
	assert.equal(step.fast, true);
	assert.deepEqual(step.liveAgent, {
		agent: "code-reviewer", tier: "high", resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" }, fast: true,
		progress: liveProgress, startedAt: "2026-01-01T00:00:00.000Z", processStatus: "active", lifecycle: "running",
	});
});

test("a settled re-review report uses report wording, not active wording", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "rereviewing", iteration: 2, maxIterations: 3, reviewerAgentId: "reviewer" } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "reported", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited", activity: { kind: "review", generation: 2 } }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [reviewer]; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
	assert.match(step.title, /Review report ready/);
	assert.doesNotMatch(step.title, /Re-reviewing/);
});

test("settled awaiting_manager with a persistent reported reviewer uses explicit manager checkpoint wording", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "awaiting_manager", iteration: 1, maxIterations: 3 } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "reported", updatedAt: new Date().toISOString(), attempts: [{ id: "attempt", state: "exited" }], currentAttemptId: "attempt" };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [reviewer]; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
	assert.match(step.title, /Needs attention · Approve or Request changes/);
	assert.match(step.detail ?? "", /Needs attention · Approve or Request changes/);
	assert.doesNotMatch(`${step.title} ${step.detail ?? ""}`, /result pending reconciliation|Review report ready/);
});

test("passed status overrides a stale awaiting-manager loop during recovery", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "passed", scope: { workItem: "example" }, loop: { state: "awaiting_manager", iteration: 3, maxIterations: 3 } };
	const step = await evaluationStep(evaluation, []);
	assert.equal(step.status, "done");
	assert.match(step.title, /Approved/);
});

test("awaiting manager presents an explicit review checkpoint", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "awaiting_manager", iteration: 1, maxIterations: 3 } };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps[0]!;
	assert.match(step.title, /Needs attention · Approve or Request changes/);
});

test("a reported prior reviewer does not shadow a queued fixer", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "fixing", iteration: 1, maxIterations: 3, managerPrompt: "Fix F1" } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "reported", updatedAt: new Date().toISOString(), attempts: [{ id: "attempt", state: "exited" }], currentAttemptId: "attempt" };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [reviewer]; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) , launchRepair: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:example", {} as any);
	const step = snapshot.steps[0]!;
	assert.equal(step.status, "ready");
	assert.match(step.title, /Fix requested/);
});

test("stale original report does not shadow queued rereview", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "rereviewing", iteration: 2, maxIterations: 3 } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "launching", currentAttemptId: "new", attempts: [
		{ id: "old", state: "exited", activity: { kind: "review", generation: 0 } },
		{ id: "new", state: "launching", activity: { kind: "review", generation: 2 } },
	] };
	const step = await evaluationStep(evaluation, [reviewer]);
	assert.equal(step.status, "running");
	assert.match(step.title, /Re-reviewing #2/);
});

test("provider fallback attempts within one generation remain active", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "planned", scope: { workItem: "example" }, loop: { state: "reviewing", iteration: 0, maxIterations: 3 } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "running", currentAttemptId: "fallback", attempts: [
		{ id: "primary", state: "failed", activity: { kind: "review", generation: 0 } },
		{ id: "fallback", state: "running", activity: { kind: "review", generation: 0 } },
	] };
	const step = await evaluationStep(evaluation, [reviewer]);
	assert.equal(step.status, "running");
	assert.match(step.title, /Reviewing/);
});

test("current-generation report is report-ready", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "rereviewing", iteration: 2, maxIterations: 3 } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited", activity: { kind: "review", generation: 2 } }] };
	const step = await evaluationStep(evaluation, [reviewer]);
	assert.equal(step.status, "attention");
	assert.match(step.title, /Review report ready/);
});

test("awaiting manager overrides reported agents", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "awaiting_manager", iteration: 2, maxIterations: 3 } };
	const reviewer = { id: "reviewer", role: "code-reviewer", evaluationId: "review", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited", activity: { kind: "review", generation: 2 } }] };
	const step = await evaluationStep(evaluation, [reviewer]);
	assert.equal(step.status, "attention");
	assert.match(step.title, /Needs attention · Approve or Request changes/);
	assert.doesNotMatch(step.title, /Review report ready/);
});

test("repeated fixer generation uses repair iteration plus one", async () => {
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "fixing", iteration: 3, maxIterations: 4 } };
	const fixer = { id: "fixer", role: "repair-implementer", evaluationId: "review", state: "running", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "running", activity: { kind: "repair", generation: 4 } }] };
	const step = await evaluationStep(evaluation, [fixer]);
	assert.equal(step.status, "running");
	assert.match(step.title, /Fixing #4/);
});

test("downstream blocked re-review keeps requested wording in its detail", async () => {
	const tasks: any[] = [task("blocked-task", "failed")];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [{ id: "blocked-task" }], executionStages: [{ id: "delivery", tasks: ["blocked-task"] }], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", stageId: "delivery", status: "planned", scope: { workItem: "example" }, loop: { state: "rereviewing", iteration: 2, maxIterations: 3 } };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readTask(_workItemId: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation() { return evaluation; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const step = (await adapter.snapshot("work-item:example", {} as any)).steps.find((candidate) => candidate.kind === "evaluation")!;
	assert.match(step.title, /Re-review requested/);
	assert.match(step.detail ?? "", /blocked by blocked-task/);
	assert.doesNotMatch(`${step.title} ${step.detail ?? ""}`, /Re-reviewing/);
});

test("a failed fixer remains actionable during fixing", async () => {
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", type: "combined-review", checkpoint: "stage-review", status: "failed", scope: { workItem: "example" }, loop: { state: "fixing", iteration: 1, maxIterations: 3, managerPrompt: "Fix F1", fixerAgentId: "fixer" } };
	const fixer = { id: "fixer", role: "repair-implementer", evaluationId: "review", state: "failed", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "failed", activity: { kind: "repair", generation: 2 } }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return [fixer]; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), launchRepair: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]!.status, "attention");
	assert.match(snapshot.steps[0]!.title, /Fix failed · Resume/);
	assert.match(snapshot.steps[0]!.detail ?? "", /failed/);
	fixer.state = "reserved";
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]!.status, "ready", "an explicitly prepared persistent fixer becomes runnable without a duplicate logical agent");
	fixer.attempts[0]!.state = "exited";
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]!.status, "ready", "a reserved fixer remains runnable while its prior successful process attempt is exited");
	assert.doesNotMatch(snapshot.steps[0]!.detail ?? "", /stale process state/);
});

test("request_changes records a fixing step without synchronously launching repair or re-review", async () => {
	let evaluation: any = { id: "stage-delivery-review", checkpoint: "stage-review", status: "failed", attempt: 1, findings: [{ id: "F1", status: "open", blocking: true }], loop: { state: "awaiting_manager", iteration: 1, maxIterations: 3, reviewerAgentId: "reviewer" } };
	const runtime: any = {
		config: { limits: { repairRounds: 6 } },
		workItems: { async readEvaluation() { return evaluation; }, async updateEvaluationLoop(_w: string, _e: string, update: any, status?: string) { evaluation = { ...evaluation, ...(status ? { status } : {}), loop: { ...evaluation.loop, ...update } }; return evaluation; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	let repairs = 0; let reviews = 0;
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => { reviews++; return { content: [] }; }, launchRepair: async () => { repairs++; return { content: [] }; } });
	const decision = await adapter.controlCheckpoint?.("work-item:example/evaluation:stage-delivery-review", "request_changes", { prompt: "Fix F1" }, {} as any) as any;
	assert.equal(decision.loop.state, "fixing");
	assert.equal(decision.loop.iteration, 1, "iteration advances only after repair settlement");
	assert.equal(decision.loop.managerPrompt, "Fix F1");
	assert.equal(decision.loop.maxIterations, 6, "current repository policy replaces the stale budget persisted when the gate was created");
	assert.equal(repairs, 0, "the workflow runner owns background repair launch");
	assert.equal(reviews, 0, "the workflow runner owns automatic re-review launch");

	// Recovery may replay the same authorization while the fixer is queued or in
	// flight, but must not replace its identity or prompt.
	evaluation.loop = { ...evaluation.loop, fixerAgentId: "fixer", managerPrompt: "Fix F1" };
	const replay = await adapter.controlCheckpoint?.("work-item:example/evaluation:stage-delivery-review", "request_changes", { prompt: "Fix F1" }, {} as any) as any;
	assert.equal(replay.loop.fixerAgentId, "fixer");
	assert.equal(replay.loop.iteration, 1);
	assert.equal(replay.loop.managerPrompt, "Fix F1");
	assert.equal(repairs, 0, "replaying fixing must not launch a duplicate repair");
});

test("an exact legacy change-request replay adopts preserved failed-fixer work without creating a new identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-legacy-repair-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.email", "test@example.com"], { cwd: root });
	await exec("git", ["config", "user.name", "Test"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".pibox/\n");
	await writeFile(join(root, "source.txt"), "base\n");
	await exec("git", ["add", "."], { cwd: root });
	await exec("git", ["commit", "-qm", "fixture"], { cwd: root });
	await writeFile(join(root, "source.txt"), "partial legacy repair\n");
	const identity = await discoverRepository(root);
	let evaluation: any = { id: "review", checkpoint: "stage-review", status: "failed", findings: [{ id: "F1", status: "open", blocking: true }], loop: { state: "awaiting_manager", iteration: 0, maxIterations: 3, managerPrompt: "Fix F1" } };
	const failedFixer: any = { id: "fixer", role: "repair-implementer", state: "failed", evaluationId: "review", operationId: "repair:example:review:1", updatedAt: new Date().toISOString(), currentAttemptId: "a1", attempts: [{ id: "a1", state: "failed", activity: { kind: "repair", generation: 1 } }] };
	let prepared = "";
	const runtime: any = {
		identity, config: { limits: { repairRounds: 3 } },
		workItems: { async readEvaluation() { return evaluation; }, async updateEvaluationLoop(_w: string, _e: string, update: any) { evaluation = { ...evaluation, loop: { ...evaluation.loop, ...update } }; return evaluation; } },
		agents: { async list() { return [failedFixer]; }, async prepareRetry(id: string) { prepared = id; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), launchRepair: async () => ({ content: [] }) });
	const result: any = await adapter.controlCheckpoint?.("work-item:example/evaluation:review", "request_changes", { prompt: "Fix F1" }, {} as any);
	assert.equal(result.loop.fixerAgentId, "fixer");
	assert.equal(prepared, "fixer");
	assert.equal((await new RepairRecoveryStore(identity).read("example", "review"))?.agentId, "fixer");
});

test("request_changes cannot rewind a re-review or exceed the repair limit", async () => {
	let evaluation: any = { id: "review", checkpoint: "stage-review", status: "planned", findings: [{ id: "F1", status: "open", blocking: true }], loop: { state: "rereviewing", iteration: 1, maxIterations: 1, managerPrompt: "Fix F1" } };
	const runtime: any = {
		config: { limits: { repairRounds: 1 } },
		workItems: { async readEvaluation() { return evaluation; }, async updateEvaluationLoop(_w: string, _e: string, update: any) { evaluation = { ...evaluation, loop: { ...evaluation.loop, ...update } }; return evaluation; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), launchRepair: async () => ({ content: [] }) });
	await assert.rejects(() => adapter.controlCheckpoint!("work-item:example/evaluation:review", "request_changes", { prompt: "Fix F2" }, {} as any), /while loop is rereviewing/);
	evaluation.loop = { state: "awaiting_manager", iteration: 1, maxIterations: 1, managerPrompt: "Fix F1" };
	await assert.rejects(() => adapter.controlCheckpoint!("work-item:example/evaluation:review", "request_changes", { prompt: "Fix F2" }, {} as any), /iteration limit/);
	assert.equal(evaluation.loop.state, "awaiting_manager");
});

test("stop cancels an unfinished reported evaluator run left by a replaced supervisor", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-stop-reported-run-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity: any = { id: "repo", root, privateRoot: root };
	const runs = new HarnessRunStore(identity, "example");
	const created = await runs.create({ repositoryId: "repo", workItemId: "example", evaluationId: "review", role: "reviewer", attempt: 1, state: "launching", workspace: root, baseCommit: "a".repeat(40) });
	const reported = { id: "reviewer", workItemId: "example", runId: created.record.id, state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited" }] };
	const runtime: any = { identity, agents: { async list() { return [reported]; } }, coordinator: { async stop() { throw new Error("reported agents must not be signalled"); } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	await adapter.controlWorkflow("work-item:example", "stop", {} as any);
	assert.equal((await runs.read(created.record.id)).state, "cancelled");
});

test("stop ignores reported agents whose process already exited", async () => {
	const reported = { id: "reviewer", workItemId: "example", state: "reported", currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "exited" }] };
	let reads = 0;
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return { id: "example", planning: { revision: 1 }, tasks: [], evaluations: [] }; } },
		agents: { async list() { return [reported]; }, async get() { reads++; return reported; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	await adapter.controlWorkflow("work-item:example", "stop", {} as any);
	assert.equal(reads, 0, "settled agents are not sent through process signaling");
});

test("the default loop permits iteration eight and rejects a ninth repair", async () => {
	let evaluation: any = { id: "review", checkpoint: "stage-review", status: "failed", findings: [{ id: "F1", status: "open", blocking: true }], loop: { state: "awaiting_manager", iteration: 7, maxIterations: 8 } };
	const runtime: any = {
		config: { limits: { repairRounds: 8 } },
		workItems: { async readEvaluation() { return evaluation; }, async updateEvaluationLoop(_w: string, _e: string, update: any) { evaluation = { ...evaluation, loop: { ...evaluation.loop, ...update } }; return evaluation; } },
		mutex: { async run(_key: string, operation: () => Promise<unknown>) { return operation(); } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }), launchRepair: async () => ({ content: [] }) });
	await adapter.controlCheckpoint!("work-item:example/evaluation:review", "request_changes", { prompt: "Repair iteration eight" }, {} as any);
	assert.equal(evaluation.loop.state, "fixing");
	evaluation.loop = { ...evaluation.loop, state: "awaiting_manager", iteration: 8 };
	await assert.rejects(() => adapter.controlCheckpoint!("work-item:example/evaluation:review", "request_changes", { prompt: "Attempt iteration nine" }, {} as any), /iteration limit/);
	assert.equal(evaluation.loop.state, "awaiting_manager");
});

test("records E2E step intervals as their own durable metric category", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-step-metrics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity: any = { id: "repo", root, privateRoot: join(root, ".pibox") };
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	await new WorkflowControlStore(identity.privateRoot).apply({ workflowRef: "work-item:example", command: "start", sessionId: "session", operationId: "start" });
	const evaluation = { id: "final-e2e", type: "e2e", checkpoint: "final-e2e", status: "planned" };
	const runtime: any = {
		identity,
		events,
		workItems: { async readEvaluation() { return evaluation; } },
	};
	const adapter = createHarnessWorkflowAdapter({
		runtimeFor: async () => runtime,
		launchTask: async () => ({ content: [] }),
		launchEvaluation: async () => ({ content: [{ type: "text", text: "E2E passed" }], details: { handoff: { verdict: "pass" } } }),
	});
	const result = await adapter.runStep("work-item:example/evaluation:final-e2e", {} as any);
	assert.equal(result.state, "completed");
	const recorded = await new WorkflowEventJournal(events).readSince(0, "example");
	const stepEvents = recorded.filter((event) => event.type === "step.started" || event.type === "step.settled");
	assert.deepEqual(stepEvents.map((event) => [event.type, event.metricCategory]), [["step.started", "e2e"], ["step.settled", "e2e"]]);
	assert.equal(stepEvents[0]?.correlationId, stepEvents[1]?.correlationId);
});

test("snapshot reloads detailed metrics from durable records without mutating them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-metrics-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity: any = { id: "repo", root, privateRoot: join(root, ".pibox") };
	const events = new RepositoryEventStore(identity);
	await events.initialize();
	const journal = new WorkflowEventJournal(events);
	await journal.append({ type: "workflow.started", workItemId: "example", ownerGeneration: 1, correlationId: "start" });
	await journal.append({ type: "workflow.completed", workItemId: "example", ownerGeneration: 1, correlationId: "complete" });
	const verificationRoot = join(identity.privateRoot, "work-items", "example", "verification", "delivery", "unit", "attempts");
	for (const [id, start, complete] of [["001", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:05.000Z"], ["002", "2026-01-01T00:00:10.000Z", "2026-01-01T00:00:17.000Z"]] as const) {
		const attemptRoot = join(verificationRoot, id);
		await mkdir(attemptRoot, { recursive: true });
		await writeFile(join(attemptRoot, "attempt.yaml"), `schemaVersion: 1\nid: "${id}"\nworkItemId: example\nstageId: delivery\ncheckId: unit\nstate: passed\nstartedAt: ${start}\ncompletedAt: ${complete}\n`);
	}
	const agents: any[] = [{
		id: "fixer", workItemId: "example", evaluationId: "review", attempts: [
			{ id: "a1", sequence: 1, state: "exited", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:10.000Z", exitedAt: "2026-01-01T00:00:10.000Z", activity: { kind: "repair", generation: 1 }, progress: { inputTokens: 100, outputTokens: 50, toolErrors: 1 } },
			{ id: "a2", sequence: 2, state: "exited", startedAt: "2026-01-01T00:00:20.000Z", updatedAt: "2026-01-01T00:00:30.000Z", exitedAt: "2026-01-01T00:00:30.000Z", activity: { kind: "repair", generation: 1 }, progress: { inputTokens: 200, outputTokens: 75, toolErrors: 0 } },
		],
	}];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [] };
	const runtime = (store: RepositoryEventStore): any => ({ identity, events: store, workItems: { async read() { return item; } }, agents: { async list() { return agents; } } });
	const create = (store: RepositoryEventStore) => createHarnessWorkflowAdapter({ runtimeFor: async () => runtime(store), launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const before = await readFile(events.eventsPath, "utf8");
	const first = await create(events).snapshot("work-item:example", {} as any);
	const reloaded = await create(new RepositoryEventStore(identity)).snapshot("work-item:example", {} as any);
	assert.deepEqual({ ...first.metrics, live: { ...first.metrics?.live, sampledAtMs: 0 } }, { ...reloaded.metrics, live: { ...reloaded.metrics?.live, sampledAtMs: 0 } });
	assert.deepEqual(first.metrics, {
		elapsedMs: first.metrics?.elapsedMs,
		runningMs: first.metrics?.runningMs,
		agentActiveMs: 20_000,
		implementerMs: 0,
		reviewerMs: 0,
		fixerMs: 20_000,
		e2eAgentMs: 0,
		deterministicMs: 12_000,
		harnessSchedulingMs: 0,
		implementationMs: 0,
		integrationMs: 0,
		verificationMs: 0,
		reviewMs: 0,
		e2eMs: 0,
		orchestrationMs: first.metrics?.runningMs,
		fixes: 1,
		retries: 2,
		agentCount: 1,
		verificationAttempts: 2,
		inputTokens: 300,
		outputTokens: 125,
		toolErrors: 1,
		live: { sampledAtMs: first.metrics?.live?.sampledAtMs, elapsed: false, running: false, activeAgents: 0, activeVerifications: 0, activeImplementers: 0, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: false },
	});
	assert.equal(await readFile(events.eventsPath, "utf8"), before, "snapshot projection does not append workflow events");
});

test("snapshot is a pure projection and reported-agent reconciliation is explicit", async () => {
	let reconciliations = 0;
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [], executionStages: [], integrationUnits: [], evaluations: [] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; } }, agents: { async list() { return [{ id: "agent", state: "reported", attempts: [] }]; } } };
	const adapter = createHarnessWorkflowAdapter({
		runtimeFor: async () => runtime,
		launchTask: async () => ({ content: [] }),
		launchEvaluation: async () => ({ content: [] }),
		async reconcileReported() { reconciliations++; },
	});
	await adapter.snapshot("work-item:example", {} as any);
	assert.equal(reconciliations, 0, "projection reads never settle canonical state");
	await adapter.reconcileWorkflow!("work-item:example", {} as any);
	assert.equal(reconciliations, 1, "the supervisor owns explicit reconciliation");
});

test("explicit reconciliation appends and publishes one durable semantic stage completion", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-stage-lifecycle-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const identity: any = { id: "repo", root, privateRoot: root };
	const events = new RepositoryEventStore(identity); await events.initialize();
	await new WorkflowControlStore(root).apply({ workflowRef: "work-item:example", command: "start", sessionId: "session", operationId: "start" });
	const agents = new SessionAgentRegistry(root, "session"); await agents.initialize();
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [{ id: "task" }], executionStages: [{ id: "delivery", tasks: ["task"] }], integrationUnits: [{ id: "delivery", tasks: ["task"] }], evaluations: [{ id: "review" }] };
	const taskManifest: any = { id: "task", status: "merged" };
	const evaluation: any = { id: "review", checkpoint: "stage-review", stageId: "delivery", status: "passed", scope: { workItem: "example" } };
	const runtime: any = {
		identity, events, agents,
		mutex: { async run(_owner: string, operation: () => Promise<unknown>) { return operation(); } },
		workItems: { async read() { return item; }, async readTask() { return taskManifest; }, async readEvaluation() { return evaluation; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let resolveLifecycle!: (value: any) => void;
	const lifecycle = new Promise<any>((resolve) => { resolveLifecycle = resolve; });
	const dispose = await adapter.subscribeLifecycle!("work-item:example", {} as any, (update) => { if (update?.lifecycle) resolveLifecycle(update.lifecycle); });
	await adapter.reconcileWorkflow!("work-item:example", {} as any);
	assert.deepEqual(await Promise.race([lifecycle, new Promise((_, reject) => setTimeout(() => reject(new Error("semantic lifecycle timed out")), 1_000))]), {
		type: "stage-completed", workflowRef: "work-item:example", stepRef: "work-item:example/evaluation:review", kind: "evaluation", stageId: "delivery", stageIndex: 0, title: "Stage 1 · delivery", toStatus: "done", cause: "stage-settled", correlationId: "work-item:example:delivery",
	});
	await adapter.reconcileWorkflow!("work-item:example", {} as any);
	assert.equal((await new WorkflowEventJournal(events).readSince(0, "example")).filter((event) => event.type === "stage.completed").length, 1);
	if (typeof dispose === "function") dispose();
});

test("derives task, integration, and evaluation steps without mutating canonical state", async () => {
	let tasks: any[] = [task("first", "ready"), task("second", "blocked", ["first"])];
	let evaluation: any = { id: "stage-delivery-review", checkpoint: "stage-review", stageId: "delivery", status: "planned", scope: { workItem: "example" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } };
	let agents: any[] = [];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, delivery: { workingBranch: "feature/example", createdFromCommit: "a".repeat(40) }, tasks: [{ id: "first" }, { id: "second" }], executionStages: [{ id: "delivery", tasks: ["first", "second"] }], integrationUnits: [{ id: "delivery", tasks: ["first", "second"] }], evaluations: [{ id: "review" }] };
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return item; }, async activateDraftTasks() { throw new Error("snapshot must be read-only"); }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return agents; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.deepEqual(snapshot.steps.map((step) => [step.kind, step.status]), [["task", "ready"], ["task", "pending"], ["evaluation", "pending"]]);

	tasks = [task("first", "integrated"), task("second", "ready", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:second"))?.status, "ready");

	tasks = [task("first", "contribution_complete"), task("second", "contribution_complete", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:first"))?.status, "ready");

	tasks = [task("first", "merged"), task("second", "merged", ["first"])];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "ready");
	evaluation = { ...evaluation, status: "passed" };
	agents = [{ id: "old-review", state: "reported", evaluationId: "review", updatedAt: new Date(0).toISOString(), attempts: [{ id: "attempt", state: "exited" }], currentAttemptId: "attempt" }];
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.status, "done", "canonical completion wins over a stale reported agent");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "done");
});

test("projects durable candidate verification activity without changing scheduler readiness", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-adapter-verification-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const attemptRoot = join(root, ".pibox", "work-items", "example", "verification", "delivery", "ios", "attempts", "001");
	await mkdir(attemptRoot, { recursive: true });
	const writeAttempt = (state: string) => writeFile(join(attemptRoot, "attempt.yaml"), `state: ${state}\nid: "001"\ncheckId: ios\ncandidateCommit: ${"b".repeat(40)}\nstartedAt: 2026-08-18T20:00:00.000Z\n`);
	await writeAttempt("failed");
	const tasks: any[] = [task("left", "contribution_complete"), task("right", "contribution_complete")];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })), executionStages: [{ id: "delivery", tasks: ["left", "right"], mode: "concurrent" }], integrationUnits: [], evaluations: [] };
	const runtime: any = { identity: { id: "repo", root, privateRoot: join(root, ".pibox") }, workItems: { async read() { return item; }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]?.status, "ready", "visual verification failure must not rewrite scheduler readiness");
	assert.equal(snapshot.steps[0]?.phase, "verification-failed");
	assert.equal(snapshot.steps[1]?.phase, "contribution-ready");
	await writeAttempt("running");
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]?.phase, "verifying-candidate");
});

test("places the harness review after its stage tasks", async () => {
	const tasks: any[] = [task("implement", "merged", [], "build")];
	const evaluation: any = { id: "stage-build-review", type: "combined-review", checkpoint: "stage-review", status: "planned", scope: { workItem: "mixed" }, stageId: "build", loop: { state: "planned", iteration: 0, maxIterations: 2 } };
	const item: any = { id: "mixed", title: "Mixed", planning: { revision: 1 }, tasks: [{ id: "implement" }], executionStages: [{ id: "build", tasks: ["implement"] }], integrationUnits: [], evaluations: [{ id: evaluation.id }] };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async readTask() { return tasks[0]; }, async readEvaluation() { return evaluation; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:mixed", {} as any);
	const review = snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-build-review"))!;
	assert.deepEqual(review.dependsOn, ["work-item:mixed/task:implement"]);
	assert.equal(review.status, "ready");
	assert.deepEqual(snapshot.stages?.[0]?.nodes, ["task:implement", "evaluation:stage-build-review"]);
});

test("gates each stage on its harness review while preserving parallel merge barriers", async () => {
	const tasks: any[] = [task("first", "ready", [], "serial"), task("left", "ready", ["first"], "parallel"), task("right", "ready", ["first"], "parallel")];
	const reviews: any[] = [
		{ id: "stage-serial-review", checkpoint: "stage-review", stageId: "serial", status: "planned", scope: { workItem: "topology" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } },
		{ id: "stage-parallel-review", checkpoint: "stage-review", stageId: "parallel", status: "planned", scope: { workItem: "topology" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } },
	];
	const item: any = { id: "topology", title: "Topology", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })), executionStages: [{ id: "serial", tasks: ["first"] }, { id: "parallel", tasks: ["left", "right"] }], integrationUnits: [], evaluations: reviews.map(({ id }) => ({ id })) };
	const runtime: any = { identity: { root: "/repo" }, workItems: { async read() { return item; }, async activateDraftTasks() { return []; }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation(_w: string, id: string) { return reviews.find((entry) => entry.id === id); } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:topology", {} as any);
	const first = snapshot.steps.find((step) => step.ref.endsWith("task:first"))!;
	assert.equal(first.parallelism, "serial"); assert.deepEqual(first.resourceClaims, ["working-branch"]);
	tasks[0].status = "merged";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.status, "pending", "next stage waits for review");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-serial-review"))?.status, "ready");
	reviews[0].status = "passed"; reviews[0].loop.state = "passed";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	for (const id of ["left", "right"]) { const step = snapshot.steps.find((candidate) => candidate.ref.endsWith(`task:${id}`))!; assert.equal(step.status, "ready"); assert.equal(step.parallelism, "allowed"); assert.deepEqual(step.resourceClaims, [id]); }
	tasks[1].status = "contribution_complete";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.status, "pending");
	tasks[2].status = "contribution_complete";
	snapshot = await adapter.snapshot("work-item:topology", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:left"))?.kind, "merge");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:right"))?.status, "pending");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:right"))?.detail, "waiting for stage merge barrier");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-parallel-review"))?.status, "pending", "the concurrent stage review remains gated by the listed merge barrier");
});

test("advances past a completed stage with an explicit skipped review", async () => {
	const tasks: any[] = [task("mechanical", "merged", [], "mechanical"), task("next", "ready", [], "next")];
	const reviews: any[] = [{ id: "stage-next-review", checkpoint: "stage-review", stageId: "next", status: "planned", scope: { workItem: "selective" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } }];
	const item: any = { id: "selective", title: "Selective", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })), executionStages: [{ id: "mechanical", tasks: ["mechanical"], review: { mode: "skip", rationale: "Deterministic proof covers this local mechanical stage completely." } }, { id: "next", tasks: ["next"] }], integrationUnits: [], evaluations: reviews.map(({ id }) => ({ id })) };
	const runtime: any = { workItems: { async read() { return item; }, async readTask(_w: string, id: string) { return tasks.find((entry) => entry.id === id); }, async readEvaluation() { return reviews[0]; } }, agents: { async list() { return []; } } };
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:selective", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:next"))?.status, "ready");
});

test("orders a three-task sequential stage and gates the next stage on review", async () => {
	const tasks: any[] = [task("first", "contribution_complete"), task("second", "contribution_complete"), task("third", "contribution_complete"), task("next", "ready", [], "next-stage")];
	const reviews: any[] = [
		{ id: "stage-delivery-review", checkpoint: "stage-review", stageId: "delivery", status: "planned", scope: { workItem: "ordered" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } },
		{ id: "stage-next-stage-review", checkpoint: "stage-review", stageId: "next-stage", status: "planned", scope: { workItem: "ordered" }, loop: { state: "planned", iteration: 0, maxIterations: 2 } },
	];
	const item: any = { id: "ordered", title: "Ordered", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })), executionStages: [{ id: "delivery", mode: "sequential", tasks: ["first", "second", "third"] }, { id: "next-stage", tasks: ["next"] }], integrationUnits: [], evaluations: reviews.map(({ id }) => ({ id })) };
	const runtime: any = {
		workItems: {
			async read() { return item; },
			async readTask(_workItemId: string, id: string) { return tasks.find((entry) => entry.id === id); },
			async readEvaluation(_workItemId: string, id: string) { return reviews.find((entry) => entry.id === id); },
		},
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const assertSequential = (snapshot: any, ids: string[]) => ids.forEach((id) => {
		const step = snapshot.steps.find((candidate: any) => candidate.ref.endsWith(`task:${id}`));
		assert.equal(step.parallelism, "serial");
		assert.deepEqual(step.resourceClaims, ["working-branch"]);
	});
	let snapshot = await adapter.snapshot("work-item:ordered", {} as any);
	assert.equal(snapshot.stages?.[0]?.parallel, false);
	assertSequential(snapshot, ["first", "second", "third"]);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:first"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:second"))?.status, "pending");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:third"))?.status, "pending");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:next"))?.status, "pending");

	for (const [done, ready] of [["first", "second"], ["second", "third"]]) {
		tasks.find((entry) => entry.id === done)!.status = "integrated";
		snapshot = await adapter.snapshot("work-item:ordered", {} as any);
		assert.equal(snapshot.steps.find((step) => step.ref.endsWith(`task:${ready}`))?.status, "ready");
		assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-delivery-review"))?.status, "pending");
	}
	tasks.find((entry) => entry.id === "third")!.status = "integrated";
	snapshot = await adapter.snapshot("work-item:ordered", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-delivery-review"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:next"))?.status, "pending");

	reviews[0].status = "passed"; reviews[0].loop.state = "passed";
	snapshot = await adapter.snapshot("work-item:ordered", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("task:next"))?.status, "ready");
});

test("an upstream review checkpoint keeps final validation queued instead of duplicating attention", async () => {
	const tasks: any[] = [task("implementation", "merged")];
	const evaluations: any[] = [
		{ id: "stage-delivery-review", type: "combined-review", checkpoint: "stage-review", stageId: "delivery", status: "failed", scope: { workItem: "checkpoint" }, loop: { state: "awaiting_manager", iteration: 0, maxIterations: 3 } },
		{ id: "final-e2e", type: "e2e", checkpoint: "final-e2e", status: "planned", scope: { workItem: "checkpoint" }, loop: { state: "planned", iteration: 0, maxIterations: 3 } },
		{ id: "final-review", type: "combined-review", checkpoint: "final-review", status: "planned", scope: { workItem: "checkpoint" }, loop: { state: "planned", iteration: 0, maxIterations: 3 } },
	];
	const item: any = {
		id: "checkpoint", title: "Checkpoint", planning: { revision: 1 }, tasks: [{ id: "implementation" }],
		executionStages: [{ id: "delivery", tasks: ["implementation"] }], integrationUnits: [], evaluations: evaluations.map(({ id }) => ({ id })),
	};
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async read() { return item; },
			async readTask() { return tasks[0]; },
			async readEvaluation(_workItemId: string, id: string) { return evaluations.find((evaluation) => evaluation.id === id); },
		},
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	const snapshot = await adapter.snapshot("work-item:checkpoint", {} as any);
	const stageReview = snapshot.steps.find((step) => step.ref.endsWith("evaluation:stage-delivery-review"))!;
	const finalE2e = snapshot.steps.find((step) => step.ref.endsWith("evaluation:final-e2e"))!;
	const finalReview = snapshot.steps.find((step) => step.ref.endsWith("evaluation:final-review"))!;

	assert.equal(stageReview.status, "attention");
	assert.match(stageReview.title, /Approve or Request changes/);
	for (const downstream of [finalE2e, finalReview]) {
		assert.equal(downstream.status, "pending");
		assert.doesNotMatch(`${downstream.title} ${downstream.detail ?? ""}`, /Approve or Request changes/);
	}
	assert.match(finalE2e.title, /Journey run queued/);
	assert.match(finalReview.detail ?? "", /waiting for/i);
	assert.match(finalReview.title, /Whole-branch review queued/);
	assert.equal(snapshot.status, "attention", "only the upstream checkpoint owns workflow attention");
});

test("projects the independent fix budget at the current review boundary", async () => {
	const tasks: any[] = [task("first", "merged", [], "first"), task("second", "merged", [], "second")];
	const evaluations: any[] = [
		{ id: "stage-first-review", type: "combined-review", checkpoint: "stage-review", stageId: "first", status: "passed", scope: { workItem: "budgets" }, loop: { state: "passed", iteration: 2, maxIterations: 3 } },
		{ id: "stage-second-review", type: "combined-review", checkpoint: "stage-review", stageId: "second", status: "planned", scope: { workItem: "budgets" }, loop: { state: "planned", iteration: 0, maxIterations: 3 } },
		{ id: "final-e2e", type: "e2e", checkpoint: "final-e2e", status: "planned", scope: { workItem: "budgets" }, loop: { state: "planned", iteration: 0, maxIterations: 3 } },
		{ id: "final-review", type: "combined-review", checkpoint: "final-review", status: "planned", scope: { workItem: "budgets" }, loop: { state: "planned", iteration: 0, maxIterations: 3 } },
	];
	const item: any = {
		id: "budgets", title: "Budgets", planning: { revision: 1 }, tasks: tasks.map(({ id }) => ({ id })),
		executionStages: [{ id: "first", tasks: ["first"] }, { id: "second", tasks: ["second"] }], integrationUnits: [], evaluations: evaluations.map(({ id }) => ({ id })),
	};
	const runtime: any = {
		identity: { root: "/repo" }, config: { limits: { repairRounds: 6 } },
		workItems: {
			async read() { return item; },
			async readTask(_workItemId: string, id: string) { return tasks.find((entry) => entry.id === id); },
			async readEvaluation(_workItemId: string, id: string) { return evaluations.find((evaluation) => evaluation.id === id); },
		},
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:budgets", {} as any);
	assert.deepEqual(snapshot.repairLoop, { label: "Stage 2 fix loop", iteration: 0, maxIterations: 6, evaluationRef: "work-item:budgets/evaluation:stage-second-review" });
	assert.match(snapshot.steps.find((step) => step.ref.endsWith("stage-second-review"))?.detail ?? "", /iteration 0\/6/, "step guidance uses current repository policy after reload");
	evaluations[1].status = "failed"; evaluations[1].loop = { state: "fixing", iteration: 0, maxIterations: 3 };
	snapshot = await adapter.snapshot("work-item:budgets", {} as any);
	assert.deepEqual(snapshot.repairLoop, { label: "Stage 2 fix loop", iteration: 1, maxIterations: 6, evaluationRef: "work-item:budgets/evaluation:stage-second-review" }, "the authorized in-flight repair round counts against the visible budget");

	evaluations[1].status = "passed"; evaluations[1].loop = { state: "passed", iteration: 1, maxIterations: 3 };
	evaluations[3].status = "failed"; evaluations[3].loop = { state: "awaiting_manager", iteration: 1, maxIterations: 3 };
	snapshot = await adapter.snapshot("work-item:budgets", {} as any);
	assert.deepEqual(snapshot.repairLoop, { label: "Whole-branch fix loop", iteration: 1, maxIterations: 6, evaluationRef: "work-item:budgets/evaluation:final-review" });

	evaluations[3].status = "passed"; evaluations[3].loop = { state: "passed", iteration: 1, maxIterations: 3 };
	evaluations[2].status = "failed"; evaluations[2].loop = { state: "awaiting_manager", iteration: 0, maxIterations: 3 };
	snapshot = await adapter.snapshot("work-item:budgets", {} as any);
	assert.deepEqual(snapshot.repairLoop, { label: "E2E fix loop", iteration: 0, maxIterations: 6, evaluationRef: "work-item:budgets/evaluation:final-e2e" });
});

test("an adopted semantic journey gate follows whole-branch review instead of a fixed evaluation id", async () => {
	const tasks: any[] = [task("implementation", "merged")];
	const item: any = {
		id: "legacy", title: "Legacy", planning: { revision: 1 }, tasks: [{ id: "implementation" }],
		executionStages: [{ id: "delivery", tasks: ["implementation"] }], integrationUnits: [],
		evaluations: [{ id: "planned-journey" }, { id: "final-branch-review" }],
	};
	let reviewStatus = "planned";
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: {
			async read() { return item; },
			async readTask() { return tasks[0]; },
			async readEvaluation(_workItemId: string, id: string) {
				return id === "planned-journey"
					? { id, type: "e2e", scope: { workItem: "legacy" }, status: "planned", loop: { state: "planned", iteration: 1, maxIterations: 3 } }
					: { id, type: "combined-review", checkpoint: "final-review", scope: { workItem: "legacy" }, status: reviewStatus, loop: { state: reviewStatus === "passed" ? "passed" : "planned", iteration: 0, maxIterations: 3 } };
			},
		},
		agents: { async list() { return []; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:legacy", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:final-branch-review"))?.status, "ready");
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:planned-journey"))?.status, "pending");
	assert.deepEqual(snapshot.repairLoop, { label: "Whole-branch fix loop", iteration: 0, maxIterations: 3, evaluationRef: "work-item:legacy/evaluation:final-branch-review" });
	reviewStatus = "passed";
	snapshot = await adapter.snapshot("work-item:legacy", {} as any);
	assert.equal(snapshot.steps.find((step) => step.ref.endsWith("evaluation:planned-journey"))?.status, "ready");
	assert.deepEqual(snapshot.repairLoop, { label: "E2E fix loop", iteration: 1, maxIterations: 3, evaluationRef: "work-item:legacy/evaluation:planned-journey" });
});

test("does not render exited or reported evaluation agents as running", async () => {
	const tasks: any[] = [task("first", "merged")];
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [{ id: "first" }], executionStages: [{ id: "delivery", tasks: ["first"] }], integrationUnits: [], evaluations: [{ id: "review" }] };
	const evaluation: any = { id: "review", status: "planned", scope: { workItem: "example" } };
	let agent: any = { id: "reviewer", state: "running", evaluationId: "review", updatedAt: new Date().toISOString(), currentAttemptId: "attempt", attempts: [{ id: "attempt", state: "running", activity: { kind: "review", generation: 0 } }] };
	const runtime: any = {
		identity: { root: "/repo" },
		workItems: { async read() { return item; }, async activateDraftTasks() { return []; }, async readTask() { return tasks[0]; }, async readEvaluation() { return evaluation; } },
		agents: { async list() { return [agent]; } },
	};
	const adapter = createHarnessWorkflowAdapter({ runtimeFor: async () => runtime, launchTask: async () => ({ content: [] }), launchEvaluation: async () => ({ content: [] }) });
	let snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "running");

	agent = { ...agent, state: "reported", attempts: [{ id: "attempt", state: "exited", activity: { kind: "review", generation: 0 } }] };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "attention");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.detail, "result pending reconciliation");

	agent = { ...agent, state: "running" };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "attention");
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.detail, "stale process state");

	evaluation.loop = { state: "fixing", iteration: 1, maxIterations: 2 };
	agent = { ...agent, role: "repair-implementer", state: "running", attempts: [{ id: "attempt", state: "running", activity: { kind: "repair", generation: 2 } }] };
	snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps.find((step) => step.kind === "evaluation")?.status, "running", "active fixer wins over the ready loop label");
});

test("deterministic task CI rejection settles silently and immediately requeues the same task", async () => {
	const planned = task("worker-owned", "changes_requested");
	const item: any = { id: "example", title: "Example", planning: { revision: 1 }, tasks: [{ id: planned.id }], executionStages: [{ id: "delivery", tasks: [planned.id], mode: "sequential" }], integrationUnits: [], evaluations: [] };
	const runtime: any = {
		identity: { id: "repo", root: "/missing", privateRoot: "/missing/.pibox" },
		workItems: { async read() { return item; }, async readTask() { return planned; }, async readEvaluation() { throw new Error("unused"); } },
		agents: { async list() { return [{ id: "owner", taskId: planned.id, state: "reported", operationId: "run-1" }]; } },
	};
	const adapter = createHarnessWorkflowAdapter({
		runtimeFor: async () => runtime,
		launchTask: async () => ({ content: [{ type: "text", text: "CI changes requested" }], details: { run: { state: "changes_requested" }, agentId: "owner" } }),
		launchEvaluation: async () => ({ content: [] }),
	});
	const snapshot = await adapter.snapshot("work-item:example", {} as any);
	assert.equal(snapshot.steps[0]?.status, "ready");
	assert.equal(snapshot.steps[0]?.detail, "CI changes requested");
	const result = await adapter.runStep("work-item:example/task:worker-owned", {} as any);
	assert.equal(result.state, "completed", "scheduler attempt settles without main-session attention");
	assert.equal(result.attention, false);
	assert.equal(result.agentId, "owner");
});
