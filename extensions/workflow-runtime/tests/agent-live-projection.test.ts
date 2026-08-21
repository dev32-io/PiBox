import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialAgentProgress, markAgentProcessStarted } from "../agent-progress.js";
import { agentLiveProcessStatus, AgentLiveProjectionManager, projectAgentLive } from "../agent-live-projection.js";
import { SessionAgentRegistry } from "../agent-registry.js";

async function registry(t: test.TestContext): Promise<SessionAgentRegistry> {
	const root = await mkdtemp(join(tmpdir(), "pibox-live-agent-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const value = new SessionAgentRegistry(root, "session");
	await value.initialize();
	return value;
}

async function reserve(value: SessionAgentRegistry, operationId = "spawn"): Promise<string> {
	return (await value.reserve({
		operationId, parentAgentId: "main:session", parentDepth: 0, role: "plan-critic", presentation: "foreground",
		provider: "openai-codex", model: "gpt-5.6-sol", effort: "high", assignment: { task: "review" },
	})).id;
}

test("current-attempt projection switches reused logical agents back through starting and active", async (t) => {
	const value = await registry(t);
	const agentId = await reserve(value);
	const first = await value.startAttempt(agentId, { provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" }, { kind: "review", generation: 0 });
	await value.markRunning(agentId, first.attempt.id, 101);
	await value.updateProgress(agentId, first.attempt.id, markAgentProcessStarted(initialAgentProgress(first.attempt.startedAt)));
	await value.recordExit(agentId, first.attempt.id, 0);
	await value.transition(agentId, "reported");
	await value.prepareRetry(agentId);

	const second = await value.startAttempt(agentId, { provider: "openai-codex", model: "gpt-5.6-luna", effort: "max" }, { kind: "review", generation: 1 }, true);
	let projection = projectAgentLive(await value.get(agentId));
	assert.equal(projection.agentId, agentId, "logical identity is reused");
	assert.equal(projection.presentation, "foreground");
	assert.equal(projection.attemptId, second.attempt.id);
	assert.equal(projection.attemptSequence, 2);
	assert.equal(projection.activity?.generation, 1);
	assert.equal(projection.progress, undefined, "historical attempt progress cannot leak into the reused attempt");
	assert.equal(agentLiveProcessStatus(projection), "starting");

	await value.markRunning(agentId, second.attempt.id, 202);
	projection = projectAgentLive(await value.get(agentId));
	assert.equal(agentLiveProcessStatus(projection), "active", "the process lifecycle, not child event timing, owns the active label");
	assert.equal(projection.model, "gpt-5.6-luna");
	assert.equal(projection.fast, true);
});

test("manager publishes semantic lifecycle changes while progress checkpoints stay snapshot-only", async (t) => {
	const value = await registry(t);
	const manager = new AgentLiveProjectionManager(value);
	const seen: string[] = [];
	const controller = new AbortController();
	const unsubscribe = await manager.watch((projection) => {
		if (projection.operationId === "managed") seen.push(`${projection.attemptSequence ?? 0}:${agentLiveProcessStatus(projection) ?? "settled"}:${projection.progress?.turns ?? 0}`);
	}, controller.signal);
	t.after(() => { controller.abort(); unsubscribe(); });

	const agentId = await reserve(value, "managed");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "repair", generation: 2 });
	await value.markRunning(agentId, attempt.id, 303);
	const progress = markAgentProcessStarted({ ...initialAgentProgress(attempt.startedAt), turns: 4 });
	await value.updateProgress(agentId, attempt.id, progress);

	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(seen.some((entry) => entry === "1:starting:0"));
	assert.ok(seen.some((entry) => entry.startsWith("1:active:")));
	assert.equal(seen.includes("1:active:4"), false, "tool/turn progress does not create a cross-process journal wake-up");
	assert.equal(projectAgentLive(await value.get(agentId)).progress?.turns, 4);
});
