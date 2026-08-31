import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { LaunchSpec } from "../../subagent/api.js";
import { SessionAgentRegistry, type AgentState } from "../../workflow-runtime/agent-registry.js";
import { LaunchCoordinator } from "../../workflow-runtime/launch-coordinator.js";
import { FakeSubagentService, fakeOwner, type FakeRequest } from "../../workflow-runtime/tests/fixtures/fake-subagent-service.js";
import { reconcileReportedAgents } from "../agent-reconciliation.js";
import { discoverRepository } from "../repository.js";
import { RepositoryMutex } from "../idempotency.js";
import { HarnessRunStore } from "../run-store.js";
import { SubagentSupervisor } from "../supervisor.js";
import type { TaskManifest } from "../types.js";
import { WorkItemStore } from "../work-items.js";
import { WorktreeManager } from "../worktrees.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}

function manifest(checks: string[] = []): TaskManifest {
	return {
		schemaVersion: 1, id: "supervised-task", title: "Supervised task", status: "ready", dependsOn: [],
		references: { specs: [], designs: [], decisions: [] },
		execution: { resourceClaims: [], assignment: { agent: "implementer", tier: "medium", rationale: "test" } },
		assembly: { integrationUnit: "supervised-unit", intermediateState: "complete" },
		verification: { timing: "integration-unit", methods: [], taskChecks: checks, rationale: "fake service" },
	};
}

async function setup(t: test.TestContext, id: string, checks: string[] = []) {
	const parent = await mkdtemp(join(tmpdir(), `pibox-supervisor-${id}-`));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, "repo");
	await git(parent, "init", "--quiet", root);
	await git(root, "config", "user.name", "Harness Test");
	await git(root, "config", "user.email", "harness@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await writeFile(join(root, ".gitignore"), "/.worktree/\n/.pibox/\n");
	await git(root, "add", "README.md", ".gitignore");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "branch", "-M", "develop");
	const identity = await discoverRepository(root, join(parent, "home"));
	const store = new WorkItemStore(root);
	await store.create({ id, title: id, kind: "change", branchKind: "feature", intent: "Exercise service supervision" });
	await store.defineTask({ workItemId: id, manifest: manifest(checks), brief: "Create the requested file", acceptance: "The requested file is committed" });
	await store.submitPlanning(id);
	const task = await store.readTask(id, "supervised-task");
	const manager = new WorktreeManager(identity);
	const allocation = await manager.allocate(id, task);
	const registry = new SessionAgentRegistry(identity.privateRoot, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	return { parent, root, identity, store, task, allocation, registry };
}

function requestEnvironment(request: FakeRequest): Record<string, string> {
	return request.kind === "launch"
		? { ...request.spec.env, ...request.spec.workflowCredentials, ...request.spec.attemptMetadata }
		: { ...request.spec.env, ...request.spec.workflowCredentials, ...request.spec.attemptMetadata };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("supervises a service contribution through a reconciler race without duplicate completion", async (t) => {
	const f = await setup(t, "supervised");
	const service = new FakeSubagentService(async (request) => {
		await writeFile(join(f.allocation.path, "child.txt"), "from child\n");
		await git(f.allocation.path, "add", "child.txt");
		await git(f.allocation.path, "commit", "-m", "child contribution");
		const head = await git(f.allocation.path, "rev-parse", "HEAD");
		const env = requestEnvironment(request);
		await new HarnessRunStore(f.identity, "supervised").writeHandoff(env.PIBOX_HARNESS_RUN_ID!, {
			schemaVersion: 1, type: "task_complete", runId: env.PIBOX_HARNESS_RUN_ID!, taskId: "supervised-task",
			summary: "fake complete", commits: [head], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
		});
		return { status: "completed", reason: "completed", exitCode: 0, text: "done" };
	});
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, service);
	const supervisor = new SubagentSupervisor();
	const transition = f.registry.transition.bind(f.registry);
	f.registry.transition = async (agentId: string, state: AgentState, update = {}) => {
		const transitioned = await transition(agentId, state, update);
		if (state === "reported") {
			assert.equal(supervisor.activeRunIds().length, 1);
			assert.deepEqual(await reconcileReportedAgents({ identity: f.identity, registry: f.registry, workItems: f.store, mutex: new RepositoryMutex(f.identity.commonDir ?? f.identity.root), excludedRunIds: new Set(supervisor.activeRunIds()) }), { completed: [], pending: [], errors: [] });
		}
		return transitioned;
	};
	const result = await supervisor.launchTask({
		identity: f.identity, workItemId: "supervised", task: f.task, workspace: f.allocation.path, branch: f.allocation.branch,
		baseCommit: f.allocation.baseCommit, executionMode: f.allocation.isolation, planningRevision: (await f.store.read("supervised")).planning.revision,
		persistentContext: "Stable task contract.", model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});
	assert.equal(result.run.state, "completed");
	assert.equal(result.handoff?.summary, "fake complete");
	assert.equal((await f.store.readTask("supervised", "supervised-task")).status, "contribution_complete");
	const events = (await readFile(join(f.identity.privateRoot, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data?: { runId?: string } });
	assert.equal(events.filter((event) => event.data?.runId === result.run.id && (event.type === "run.completed" || event.type === "run.reconciled_completed")).length, 1);
	assert.equal(service.released.length, 1, "terminal workflow completion explicitly deletes the child transcript");
});

test("task CI repair continues the same service transcript because deterministic failure is attempt-local", async (t) => {
	const f = await setup(t, "ci-loop", ["test -f green.txt"]);
	let turn = 0;
	const stableContexts: string[] = [];
	const service = new FakeSubagentService(async (request) => {
		turn++;
		if (request.kind === "launch") stableContexts.push(request.spec.stableSystemContext);
		const file = turn === 1 ? "first.txt" : "green.txt";
		await writeFile(join(f.allocation.path, file), `${file}\n`);
		await git(f.allocation.path, "add", file);
		await git(f.allocation.path, "commit", "-m", turn === 1 ? "submit red candidate" : "repair CI");
		const head = await git(f.allocation.path, "rev-parse", "HEAD");
		const env = requestEnvironment(request);
		await new HarnessRunStore(f.identity, "ci-loop").writeHandoff(env.PIBOX_HARNESS_RUN_ID!, {
			schemaVersion: 1, type: "task_complete", runId: env.PIBOX_HARNESS_RUN_ID!, taskId: "supervised-task",
			summary: turn === 1 ? "candidate submitted" : "CI repaired", commits: [head], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
		});
		return { status: "completed", reason: "completed", exitCode: 0, text: "submitted" };
	});
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, service);
	const supervisor = new SubagentSupervisor();
	const launchCurrent = async () => supervisor.launchTask({
		identity: f.identity, workItemId: "ci-loop", task: await f.store.readTask("ci-loop", "supervised-task"), workspace: f.allocation.path,
		branch: f.allocation.branch, baseCommit: f.allocation.baseCommit, executionMode: f.allocation.isolation,
		planningRevision: (await f.store.read("ci-loop")).planning.revision, persistentContext: "Stable task contract.",
		model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});
	const first = await launchCurrent();
	assert.equal(first.run.state, "changes_requested");
	assert.equal(service.released.length, 0, "the transcript survives while the same-activation CI repair loop is unfinished");
	const second = await launchCurrent();
	assert.equal(second.run.state, "completed");
	assert.deepEqual(service.requests.map((request) => request.kind), ["launch", "continue"]);
	assert.equal(new Set(service.requests.map((request) => request.agentId)).size, 1);
	assert.equal(stableContexts.length, 1);
	const continuation = service.requests[1]!;
	assert.equal(continuation.kind, "continue");
	assert.match(continuation.spec.attemptUserPrompt, /Changes Requested by Deterministic CI/);
	const attempts = (await f.registry.list())[0]!.attempts;
	assert.equal(attempts.length, 2);
	assert.equal(attempts[0]?.contextHashes?.stableSystemContextHash, attempts[1]?.contextHashes?.stableSystemContextHash);
	assert.notEqual(attempts[0]?.contextHashes?.attemptUserTurnHash, attempts[1]?.contextHashes?.attemptUserTurnHash);
	assert.equal(attempts[1]?.progress?.cacheReadTokens, undefined, "cache telemetry remains provider-reported rather than inferred");
	assert.equal(service.released.length, 1, "the transcript is released only after the repair loop completes");
});

test("stop waits through onAttemptReady and prevents service startup after the attempt fence", async (t) => {
	const f = await setup(t, "stop-startup-race");
	const readyEntered = deferred();
	const allowBind = deferred();
	const bindFinished = deferred();
	const allowServiceLaunch = deferred();
	const service = new FakeSubagentService();
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, service);
	const coordinatedLaunch = coordinator.launch.bind(coordinator);
	coordinator.launch = (input) => coordinatedLaunch({
		...input,
		onAttemptReady: async (agent, attempt) => {
			readyEntered.resolve();
			await allowBind.promise;
			await input.onAttemptReady?.(agent, attempt);
			bindFinished.resolve();
			await allowServiceLaunch.promise;
		},
	});
	const supervisor = new SubagentSupervisor();
	const launching = supervisor.launchTask({
		identity: f.identity, workItemId: "stop-startup-race", task: f.task, workspace: f.allocation.path, branch: f.allocation.branch,
		baseCommit: f.allocation.baseCommit, executionMode: f.allocation.isolation, planningRevision: (await f.store.read("stop-startup-race")).planning.revision,
		persistentContext: "Stable task contract.", model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});
	await readyEntered.promise;
	const [runId] = supervisor.activeRunIds();
	assert.ok(runId);
	let stopSettled = false;
	const stopping = supervisor.stop(runId).finally(() => { stopSettled = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopSettled, false, "stop must wait while onAttemptReady has not bound the fence");

	allowBind.resolve();
	await bindFinished.promise;
	const fenced = await new HarnessRunStore(f.identity, "stop-startup-race").read(runId);
	assert.equal(fenced.currentAgentAttemptId, undefined);
	assert.ok(fenced.credentialRevokedAt, "the post-bind stop check must revoke a fence created after stop began");
	assert.equal(stopSettled, false, "fence revocation alone is not terminal settlement");

	allowServiceLaunch.resolve();
	assert.equal(await stopping, true);
	const stopped = await launching;
	assert.equal(service.requests.length, 0, "an aborted durable attempt never starts a child process");
	assert.equal(stopped.run.state, "cancelled");
	assert.equal(supervisor.activeRunIds().length, 0);
	assert.equal((await f.store.readTask("stop-startup-race", "supervised-task")).status, "cancelled");
});

test("stop waits while service startup has not returned its handle", async (t) => {
	const f = await setup(t, "stop-service-startup");
	const serviceLaunchEntered = deferred();
	const allowServiceHandle = deferred();
	class GatedLaunchService extends FakeSubagentService {
		override async launch(spec: LaunchSpec): ReturnType<FakeSubagentService["launch"]> {
			serviceLaunchEntered.resolve();
			await allowServiceHandle.promise;
			return super.launch(spec);
		}
	}
	const service = new GatedLaunchService(() => new Promise(() => undefined));
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, service);
	const supervisor = new SubagentSupervisor();
	const launching = supervisor.launchTask({
		identity: f.identity, workItemId: "stop-service-startup", task: f.task, workspace: f.allocation.path, branch: f.allocation.branch,
		baseCommit: f.allocation.baseCommit, executionMode: f.allocation.isolation, planningRevision: (await f.store.read("stop-service-startup")).planning.revision,
		persistentContext: "Stable task contract.", model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});
	await serviceLaunchEntered.promise;
	const [runId] = supervisor.activeRunIds();
	let stopSettled = false;
	const stopping = supervisor.stop(runId!).finally(() => { stopSettled = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stopSettled, false);
	allowServiceHandle.resolve();
	assert.equal(await stopping, true);
	assert.equal((await launching).run.state, "cancelled");
});

test("a late task handoff after confirmed stop is never consumed", async (t) => {
	const f = await setup(t, "stop-race");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const service = new FakeSubagentService(async (request) => {
		await gate;
		const env = requestEnvironment(request);
		await new HarnessRunStore(f.identity, "stop-race").writeHandoff(env.PIBOX_HARNESS_RUN_ID!, {
			schemaVersion: 1, type: "task_complete", runId: env.PIBOX_HARNESS_RUN_ID!, taskId: "supervised-task", summary: "late", commits: [], checks: [], expectedFailures: [], risks: [], completedAt: new Date().toISOString(),
		});
		return { status: "completed", reason: "completed", exitCode: 0, text: "late" };
	});
	const supervisor = new SubagentSupervisor();
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, service);
	const launching = supervisor.launchTask({
		identity: f.identity, workItemId: "stop-race", task: f.task, workspace: f.allocation.path, branch: f.allocation.branch,
		baseCommit: f.allocation.baseCommit, executionMode: f.allocation.isolation, planningRevision: (await f.store.read("stop-race")).planning.revision,
		persistentContext: "Stable task contract.", model: { provider: "fake", model: "fake", effort: "medium", requested: "medium" }, coordinator,
	});
	while (service.requests.length === 0 || supervisor.activeRunIds().length === 0) await new Promise((resolve) => setImmediate(resolve));
	const [runId] = supervisor.activeRunIds();
	assert.equal(await supervisor.stop(runId!), true);
	const stopped = await launching;
	assert.equal(stopped.run.state, "cancelled");
	release();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal((await new HarnessRunStore(f.identity, "stop-race").read(runId!)).state, "cancelled");
	assert.equal((await f.store.readTask("stop-race", "supervised-task")).status, "cancelled");
});
