import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionAgentRegistry } from "../agent-registry.js";

async function fixture(t: test.TestContext, limit = 16) {
	const root = await mkdtemp(join(tmpdir(), "pibox-agent-registry-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const registry = new SessionAgentRegistry(root, "session-1", limit, 1);
	await registry.initialize("main:session-1");
	return { root, registry };
}

function input(index: number, overrides: Partial<Parameters<SessionAgentRegistry["reserve"]>[0]> = {}) {
	return {
		operationId: `launch-${index}`,
		parentAgentId: "main:session-1",
		parentDepth: 0,
		role: "explorer",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		effort: "low",
		assignment: { question: `Question ${index}` },
		...overrides,
	};
}

test("reserves a logical agent and retains its slot across process attempts and waits", async (t) => {
	const { registry } = await fixture(t, 1);
	const reserved = await registry.reserve(input(1));
	const replay = await registry.reserve(input(1));
	assert.equal(replay.id, reserved.id);
	await assert.rejects(registry.reserve(input(1, { assignment: { question: "Different" } })), /different assignment/);
	assert.equal(await registry.activeCount(), 1);

	const { attempt } = await registry.startAttempt(reserved.id);
	await registry.markRunning(reserved.id, attempt.id, 1234);
	await registry.recordExit(reserved.id, attempt.id, 0);
	await registry.transition(reserved.id, "waiting_decision");
	assert.equal(await registry.activeCount(), 1);
	await assert.rejects(registry.reserve(input(2)), /SUBAGENT_LIMIT_REACHED/);

	const resumed = await registry.startAttempt(reserved.id);
	assert.equal(resumed.attempt.sequence, 2);
	assert.equal(await registry.activeCount(), 1);
});

test("releases a slot only after a terminal logical transition", async (t) => {
	const { registry } = await fixture(t, 1);
	const agent = await registry.reserve(input(1));
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, 1234);
	await registry.transition(agent.id, "reported");
	assert.equal(await registry.activeCount(), 1);
	await registry.transition(agent.id, "completed");
	assert.equal(await registry.activeCount(), 0);
	assert.equal((await registry.reserve(input(2))).state, "reserved");
});

test("rejects recursive launches before creating an assignment", async (t) => {
	const { root, registry } = await fixture(t);
	await assert.rejects(registry.reserve(input(1, { parentAgentId: "child", parentDepth: 1 })), /SUBAGENT_DEPTH_EXCEEDED/);
	assert.equal((await registry.list()).length, 0);
	const events = await readFile(join(root, "sessions", "session-1", "agent-events.jsonl"), "utf8").catch(() => "");
	assert.equal(events, "");
});

test("serializes concurrent reservations across registry instances", async (t) => {
	const { root } = await fixture(t, 16);
	const registries = Array.from({ length: 17 }, () => new SessionAgentRegistry(root, "session-1", 16, 1));
	const outcomes = await Promise.allSettled(registries.map((registry, index) => registry.reserve(input(index))));
	assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 16);
	assert.equal(outcomes.filter((outcome) => outcome.status === "rejected" && /SUBAGENT_LIMIT_REACHED/.test(String(outcome.reason))).length, 1);
	assert.equal((await registries[0]!.list()).length, 16);
});

test("persists blocking requests and responses without releasing the logical slot", async (t) => {
	const { registry } = await fixture(t, 1);
	const agent = await registry.reserve(input(1));
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, 1234);
	const message = await registry.recordMessage(agent.id, { type: "change_request", blocking: true, summary: "Contract must change", rationale: "Schema cannot represent the state", evidence: [{ source: "src/schema.ts", observation: "Field is required" }], options: ["Change schema"], recommendation: "Change schema" });
	assert.equal((await registry.get(agent.id)).state, "waiting_decision");
	assert.equal(await registry.activeCount(), 1);
	assert.equal((await registry.listMessages(agent.id))[0]?.id, message.id);
	const answered = await registry.respondMessage(agent.id, message.id, "Use a nullable field");
	assert.equal(answered.status, "answered");
	assert.equal(answered.response, "Use a nullable field");
	await assert.rejects(registry.respondMessage(agent.id, message.id, "Again"), /already answered/);
});

test("rejects invalid transitions and preserves ordered lifecycle events", async (t) => {
	const { root, registry } = await fixture(t);
	const agent = await registry.reserve(input(1));
	await assert.rejects(registry.transition(agent.id, "completed"), /Invalid agent transition/);
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, 1234);
	await registry.transition(agent.id, "cancelled");
	const events = (await readFile(join(root, "sessions", "session-1", "agent-events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
	assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
});
