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

test("publishes each durable lifecycle transition once and replay does not duplicate workers", async (t) => {
	const { registry } = await fixture(t);
	const events: string[] = [];
	const unsubscribe = registry.subscribe((event) => events.push(event.type));
	registry.subscribe(() => { throw new Error("observer failure"); });
	const agent = await registry.reserve(input(1));
	await registry.reserve(input(1));
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, 1234);
	await registry.recordExit(agent.id, attempt.id, 0);
	await registry.transition(agent.id, "reported");
	unsubscribe();
	assert.deepEqual(events, ["agent.reserved", "agent.attempt_started", "agent.running", "agent.process_exited", "agent.reported"]);
	assert.equal((await registry.list()).length, 1);
});

test("same-instance watch publishes a durable transition immediately and exactly once", async (t) => {
	const { registry } = await fixture(t);
	const events: string[] = [];
	let wake!: () => void;
	const seen = new Promise<void>((resolve) => { wake = resolve; });
	const dispose = await registry.watch((event) => {
		events.push(event.type);
		wake();
	});
	await registry.reserve(input(1));
	await seen;
	await new Promise((resolve) => setImmediate(resolve));
	dispose();
	assert.deepEqual(events, ["agent.reserved"]);
});

test("persists progress and wakes another registry instance from the durable event log", async (t) => {
	const { root, registry } = await fixture(t);
	const observer = new SessionAgentRegistry(root, "session-1", 16, 1);
	const agent = await registry.reserve(input(1));
	const { attempt } = await registry.startAttempt(agent.id);
	await registry.markRunning(agent.id, attempt.id, 1234);
	let wake: (() => void) | undefined;
	const seen = new Promise<void>((resolve) => { wake = resolve; });
	const dispose = await observer.watch((event) => { if (event.type === "agent.progress") wake?.(); });
	await registry.updateProgress(agent.id, attempt.id, { startedAt: attempt.startedAt, lastEventAt: "2026-01-01T00:00:01.000Z", turns: 1, toolCalls: 2, toolErrors: 0, outputTokens: 345, reasoningTokens: 12 });
	await Promise.race([seen, new Promise((_, reject) => setTimeout(() => reject(new Error("durable progress wake-up timed out")), 1_000))]);
	dispose();
	const persisted = (await observer.get(agent.id)).attempts[0]!.progress;
	assert.equal(persisted?.turns, 1);
	assert.equal(persisted?.outputTokens, 345);
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
	const message = await registry.recordMessage(agent.id, { operationId: "message-1", type: "change_request", blocking: true, summary: "Contract must change", rationale: "Schema cannot represent the state", evidence: [{ source: "src/schema.ts", observation: "Field is required" }], options: ["Change schema"], recommendation: "Change schema" });
	assert.equal((await registry.get(agent.id)).state, "waiting_decision");
	assert.equal(await registry.activeCount(), 1);
	assert.equal((await registry.listMessages(agent.id))[0]?.id, message.id);
	await assert.rejects(registry.recordMessage(agent.id, { operationId: "message-1", type: "change_request", blocking: true, summary: "Different", rationale: "Different", evidence: [] }), /different payload/);
	const replay = await registry.recordMessage(agent.id, { operationId: "message-1", type: "change_request", blocking: true, summary: "Contract must change", rationale: "Schema cannot represent the state", evidence: [{ source: "src/schema.ts", observation: "Field is required" }], options: ["Change schema"], recommendation: "Change schema" });
	assert.equal(replay.id, message.id);
	assert.equal((await registry.listMessages(agent.id)).length, 1);
	const answered = await registry.respondMessage(agent.id, message.id, "Use a nullable field");
	assert.equal(answered.status, "answered");
	assert.equal(answered.response, "Use a nullable field");
	assert.equal((await registry.respondMessage(agent.id, message.id, "Use a nullable field")).id, message.id);
	await assert.rejects(registry.respondMessage(agent.id, message.id, "Again"), /already answered/);
});

test("explicitly prepares one failed logical agent for a fresh process attempt", async (t) => {
	const { registry } = await fixture(t);
	const agent = await registry.reserve(input(1));
	const first = await registry.startAttempt(agent.id, { provider: "test", model: "fake", effort: "low" });
	await registry.markRunning(agent.id, first.attempt.id, 1234);
	await registry.recordExit(agent.id, first.attempt.id, 1);
	await registry.transition(agent.id, "failed", { error: "provider rejected the turn" });
	await assert.rejects(registry.startAttempt(agent.id), /Invalid agent transition/);
	const prepared = await registry.prepareRetry(agent.id);
	assert.equal(prepared.state, "reserved");
	assert.equal(prepared.id, agent.id);
	const second = await registry.startAttempt(agent.id, { provider: "test", model: "fake", effort: "low" });
	assert.equal(second.agent.id, agent.id);
	assert.equal(second.attempt.sequence, 2);
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
