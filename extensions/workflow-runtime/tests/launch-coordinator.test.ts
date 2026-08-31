import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";
import { FakeSubagentService, fakeOwner } from "./fixtures/fake-subagent-service.js";

test("fails closed without a SubagentService", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-coordinator-required-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	assert.throws(() => new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, undefined as never), /requires the standalone SubagentService/);
});

test("launches only through the service and keeps attempt-specific prompts out of the stable configuration", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-coordinator-service-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new FakeSubagentService();
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, service, ["/workflow.ts"]);
	const common = {
		role: "reviewer", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: ["read"],
		agentPrompt: "Stable agent.", additionalPrompt: "Stable protocol.", persistentContext: "Stable contract.", deferCompletion: true,
	};
	const first = await coordinator.launch({ ...common, operationId: "one", task: "Reviewed commit one" });
	const second = await coordinator.launch({ ...common, operationId: "two", existingAgentId: first.agent.id, task: "Reviewed commit two" });
	assert.equal(first.agent.state, "reported");
	assert.equal(second.agent.state, "reported");
	assert.deepEqual(service.requests.map((request) => request.kind), ["launch", "continue"]);
	assert.equal(new Set(service.requests.map((request) => request.agentId)).size, 1);
	const launch = service.requests[0]!;
	const continuation = service.requests[1]!;
	assert.equal(launch.kind, "launch");
	assert.equal(launch.spec.stableSystemContext, "Stable agent.\n\nStable protocol.\n\nStable contract.");
	assert.equal(launch.spec.attemptUserPrompt, "Reviewed commit one");
	assert.equal(continuation.kind, "continue");
	assert.equal(continuation.spec.attemptUserPrompt, "Reviewed commit two");
});

test("two reload coordinators settle one active service attempt exactly once", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-coordinator-cas-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const service = new FakeSubagentService(async () => { await gate; return { status: "completed", reason: "completed", exitCode: 0, text: "shared success" }; });
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	const firstCoordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, service);
	let logicalId = "";
	let startedCount = 0;
	const input = { operationId: "shared", role: "reviewer", task: "review", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], agentPrompt: "stable", deferCompletion: true, onStarted: (agent: { id: string }) => { logicalId = agent.id; startedCount++; } };
	const first = firstCoordinator.launch(input);
	while (!logicalId) await new Promise((resolve) => setImmediate(resolve));
	const secondCoordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, service);
	let reboundCount = 0;
	const second = secondCoordinator.launch({ ...input, existingAgentId: logicalId, onRebind: () => { reboundCount++; } });
	while (startedCount < 2) await new Promise((resolve) => setImmediate(resolve));
	release();
	const [left, right] = await Promise.all([first, second]);
	assert.equal(left.agent.state, "reported");
	assert.equal(right.agent.state, "reported");
	assert.equal((await registry.get(logicalId)).attempts.length, 1);
	assert.equal(service.requests.length, 1, "reload rebinds instead of spawning or continuing");
	assert.equal(reboundCount, 1, "replacement ownership observes the existing active child without a prelaunch callback");
});

test("owner loss becomes durable interrupted and stale success cannot overwrite it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-coordinator-owner-loss-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new FakeSubagentService(() => ({ status: "cancelled", reason: "owner_lost", exitCode: null, text: "" }));
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, service);
	const settled = await coordinator.launch({ operationId: "lost", role: "worker", task: "work", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], agentPrompt: "stable" });
	assert.equal(settled.agent.state, "interrupted");
	const attempt = settled.agent.attempts[0]!;
	const stale = await registry.settleAttempt(settled.agent.id, attempt.id, { exitCode: 0, reason: "completed", targetState: "completed" });
	assert.equal(stale.claimed, false);
	assert.equal(stale.agent.state, "interrupted");
});

test("managed stop is service-backed and returns after cancellation is durable", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-coordinator-stop-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new FakeSubagentService(() => new Promise(() => {}));
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	const coordinator = new LaunchCoordinator(registry, `main:${fakeOwner.sessionId}`, service);
	let logicalId = "";
	const launch = coordinator.launch({ operationId: "stop", role: "worker", task: "work", assignment: {}, cwd: root, provider: "test", model: "fake", effort: "low", tools: [], agentPrompt: "stable", onStarted: (agent) => { logicalId = agent.id; } });
	while (!logicalId || service.requests.length === 0) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(await coordinator.stop(logicalId), true);
	const settled = await launch;
	assert.equal(settled.result.terminalReason, "explicit_stop");
	assert.equal(settled.agent.state, "cancelled");
});
