import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderCooldowns } from "../../provider-fallback/index.js";
import { SessionAgentRegistry } from "../agent-registry.js";
import { LaunchCoordinator } from "../launch-coordinator.js";
import { FakeSubagentService, fakeOwner } from "./fixtures/fake-subagent-service.js";

async function fixture(t: test.TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pibox-provider-fallback-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const service = new FakeSubagentService((request) => {
		const provider = request.kind === "launch" ? request.spec.provider : "continued";
		return provider === "limited"
			? { status: "failed", reason: "failure", exitCode: 1, text: "", stderr: "HTTP 429 Retry-After: 1" }
			: provider === "context"
				? { status: "failed", reason: "failure", exitCode: 1, text: "", stderr: "context_length_exceeded" }
				: { status: "completed", reason: "completed", exitCode: 0, text: "fallback completed" };
	});
	const registry = new SessionAgentRegistry(root, fakeOwner.sessionId);
	await registry.initialize(`main:${fakeOwner.sessionId}`);
	return { root, service, registry };
}

test("provider fallback keeps the workflow identity but uses a fresh incompatible service agent", async (t) => {
	const f = await fixture(t);
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, f.service, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "fallback", role: "reviewer", task: "inspect", assignment: {}, cwd: f.root,
		provider: "limited", model: "one", effort: "medium",
		providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "high" }],
		tools: [], agentPrompt: "stable",
	});
	assert.equal(launched.result.provider, "healthy");
	assert.equal(launched.agent.state, "completed");
	assert.equal(launched.agent.attempts.length, 2);
	assert.equal(new Set(f.service.requests.map((request) => request.agentId)).size, 2);
	await coordinator.release(launched.agent.id);
	assert.equal(f.service.released.length, 2, "terminal cleanup removes every route transcript for the logical workflow agent");
});

test("non-provider failures do not fallback", async (t) => {
	const f = await fixture(t);
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, f.service, [], new ProviderCooldowns());
	const launched = await coordinator.launch({
		operationId: "context", role: "reviewer", task: "inspect", assignment: {}, cwd: f.root,
		provider: "context", model: "one", effort: "medium",
		providerCandidates: [{ provider: "context", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "high" }],
		tools: [], agentPrompt: "stable",
	});
	assert.equal(launched.result.provider, "context");
	assert.equal(launched.agent.state, "failed");
	assert.equal(f.service.requests.length, 1);
});

test("cooling routes are skipped before service launch", async (t) => {
	const f = await fixture(t);
	const cooldowns = new ProviderCooldowns();
	cooldowns.mark("limited", 60_000);
	const coordinator = new LaunchCoordinator(f.registry, `main:${fakeOwner.sessionId}`, f.service, [], cooldowns);
	const launched = await coordinator.launch({
		operationId: "cooldown", role: "reviewer", task: "inspect", assignment: {}, cwd: f.root,
		provider: "limited", model: "one", effort: "medium",
		providerCandidates: [{ provider: "limited", model: "one", effort: "medium" }, { provider: "healthy", model: "two", effort: "high" }],
		tools: [], agentPrompt: "stable",
	});
	assert.equal(launched.result.provider, "healthy");
	assert.equal(f.service.requests.length, 1);
});
