import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initialAgentProgress, markAgentProcessStarted } from "../agent-progress.js";
import { agentLiveProcessStatus, AgentLiveProjectionManager, projectAgentLive, publishAgentLiveProgress } from "../agent-live-projection.js";
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
	let resolveActive!: () => void;
	const active = new Promise<void>((resolve) => { resolveActive = resolve; });
	const controller = new AbortController();
	const unsubscribe = await manager.watch((projection) => {
		if (projection.operationId !== "managed") return;
		const entry = `${projection.attemptSequence ?? 0}:${agentLiveProcessStatus(projection) ?? "settled"}:${projection.progress?.turns ?? 0}`;
		seen.push(entry);
		if (entry.startsWith("1:active:")) resolveActive();
	}, controller.signal);
	t.after(() => { controller.abort(); unsubscribe(); });

	const agentId = await reserve(value, "managed");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "repair", generation: 2 });
	await value.markRunning(agentId, attempt.id, 303);
	await Promise.race([active, new Promise((_, reject) => setTimeout(() => reject(new Error("active lifecycle was not published")), 1_000))]);
	assert.ok(seen.some((entry) => entry === "1:starting:0"));
	seen.length = 0;
	const lifecycle: string[] = [];
	const unsubscribeLifecycle = value.subscribe((event) => lifecycle.push(event.type));
	const progress = markAgentProcessStarted({ ...initialAgentProgress(attempt.startedAt), turns: 4 });
	await value.updateProgress(agentId, attempt.id, progress);
	unsubscribeLifecycle();

	assert.deepEqual(lifecycle, [], "durable compatibility checkpoints do not create a lifecycle event");
	assert.equal(projectAgentLive(await value.get(agentId)).progress?.turns, 4);
});

test("process-local progress reaches live projections without durable registry writes", async (t) => {
	const value = await registry(t);
	const manager = new AgentLiveProjectionManager(value);
	const seen: number[] = [];
	let resolveLive!: () => void;
	const live = new Promise<void>((resolve) => { resolveLive = resolve; });
	const controller = new AbortController();
	const unsubscribe = await manager.watch((projection) => {
		if (projection.operationId !== "volatile") return;
		seen.push(projection.progress?.turns ?? 0);
		if (projection.progress?.turns === 3) resolveLive();
	}, controller.signal);
	t.after(() => { controller.abort(); unsubscribe(); });

	const agentId = await reserve(value, "volatile");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "review", generation: 2 });
	await value.markRunning(agentId, attempt.id, 404);
	publishAgentLiveProgress(value.root, agentId, attempt.id, markAgentProcessStarted({ ...initialAgentProgress(attempt.startedAt), turns: 3 }));

	await Promise.race([live, new Promise((_, reject) => setTimeout(() => reject(new Error("live progress was not published")), 1_000))]);
	assert.ok(seen.includes(3));
	assert.equal((await value.get(agentId)).attempts[0]!.progress, undefined, "live progress remains memory-only");
});

test("live manager coalesces four concurrent progress bursts per agent", async (t) => {
	const value = await registry(t);
	const agents: Array<{ agentId: string; attemptId: string; startedAt: string }> = [];
	for (let index = 1; index <= 4; index += 1) {
		const agentId = await reserve(value, `burst-${index}`);
		const { attempt } = await value.startAttempt(agentId, undefined, { kind: "review", generation: 3 });
		await value.markRunning(agentId, attempt.id, 405 + index);
		publishAgentLiveProgress(value.root, agentId, attempt.id, markAgentProcessStarted(initialAgentProgress(attempt.startedAt)));
		agents.push({ agentId, attemptId: attempt.id, startedAt: attempt.startedAt });
	}

	const latestAgents = new Set<string>();
	let resolveLatest!: () => void;
	const latest = new Promise<void>((resolve) => { resolveLatest = resolve; });
	const manager = new AgentLiveProjectionManager(value);
	const unsubscribe = await manager.watch((projection) => {
		if (projection.operationId.startsWith("burst-") && projection.progress?.turns === 40) {
			latestAgents.add(projection.agentId);
			if (latestAgents.size === agents.length) resolveLatest();
		}
	});
	t.after(unsubscribe);

	const originalGet = value.get.bind(value);
	const reads = new Map<string, number>();
	const blockedAgents = new Set<string>();
	let releaseFirstReads!: () => void;
	let resolveFirstReads!: () => void;
	const firstReadsBlocked = new Promise<void>((resolve) => { releaseFirstReads = resolve; });
	const firstReadsStarted = new Promise<void>((resolve) => { resolveFirstReads = resolve; });
	value.get = async (requestedAgentId: string) => {
		const count = (reads.get(requestedAgentId) ?? 0) + 1;
		reads.set(requestedAgentId, count);
		if (count === 1) {
			blockedAgents.add(requestedAgentId);
			if (blockedAgents.size === agents.length) resolveFirstReads();
			await firstReadsBlocked;
		}
		return originalGet(requestedAgentId);
	};

	for (const agent of agents) {
		publishAgentLiveProgress(value.root, agent.agentId, agent.attemptId, markAgentProcessStarted({ ...initialAgentProgress(agent.startedAt), turns: 1 }));
	}
	await firstReadsStarted;
	for (let turns = 2; turns <= 40; turns += 1) for (const agent of agents) {
		publishAgentLiveProgress(value.root, agent.agentId, agent.attemptId, markAgentProcessStarted({ ...initialAgentProgress(agent.startedAt), turns }));
	}
	releaseFirstReads();
	await Promise.race([latest, new Promise((_, reject) => setTimeout(() => reject(new Error("latest concurrent burst progress was not published")), 1_000))]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual([...reads.values()], [2, 2, 2, 2], "each agent is bounded to one active read plus one latest-wins catch-up");
});

test("initial watch catch-up cannot overwrite a newer lifecycle projection", async (t) => {
	const value = await registry(t);
	const agentId = await reserve(value, "initial-race");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "review", generation: 4 });
	await value.markRunning(agentId, attempt.id, 406);
	publishAgentLiveProgress(value.root, agentId, attempt.id, markAgentProcessStarted(initialAgentProgress(attempt.startedAt)));

	const originalGet = value.get.bind(value);
	let releaseCapturedRead!: () => void;
	let resolveCapturedRead!: () => void;
	const capturedReadBlocked = new Promise<void>((resolve) => { releaseCapturedRead = resolve; });
	const capturedReadReady = new Promise<void>((resolve) => { resolveCapturedRead = resolve; });
	let firstRead = true;
	value.get = async (requestedAgentId: string) => {
		const captured = await originalGet(requestedAgentId);
		if (firstRead) {
			firstRead = false;
			resolveCapturedRead();
			await capturedReadBlocked;
		}
		return captured;
	};

	const seen: boolean[] = [];
	const manager = new AgentLiveProjectionManager(value);
	const watching = manager.watch((projection) => {
		if (projection.operationId === "initial-race") seen.push(projection.active);
	});
	await capturedReadReady;
	await value.transition(agentId, "cancelled");
	releaseCapturedRead();
	const unsubscribe = await watching;
	t.after(unsubscribe);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(seen.at(-1), false, "the queued lifecycle read must supersede the stale initial record");
});

test("a replacement live manager reconstructs an active attempt from its transport", async (t) => {
	const value = await registry(t);
	const agentId = await reserve(value, "reattach");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "review", generation: 2 });
	const attemptRoot = join(value.root, "agents", agentId, "attempts", attempt.id);
	await mkdir(attemptRoot, { recursive: true });
	await writeFile(join(attemptRoot, "stdout.jsonl"), `${JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false })}\n${JSON.stringify({ type: "turn_end", message: { usage: { input: 10, output: 7, reasoning: 2, totalTokens: 19 } } })}\n`);
	await value.markRunning(agentId, attempt.id, 505);

	const seen: Array<{ turns: number; tools: number }> = [];
	let resolveRecovered!: () => void;
	const recovered = new Promise<void>((resolve) => { resolveRecovered = resolve; });
	const manager = new AgentLiveProjectionManager(value);
	const unsubscribe = await manager.watch((projection) => {
		if (projection.operationId !== "reattach") return;
		const progress = { turns: projection.progress?.turns ?? 0, tools: projection.progress?.toolCalls ?? 0 };
		seen.push(progress);
		if (progress.turns === 1 && progress.tools === 1) resolveRecovered();
	});
	await Promise.race([recovered, new Promise((_, reject) => setTimeout(() => reject(new Error("transport progress was not recovered")), 1_000))]);
	assert.ok(seen.some((progress) => progress.turns === 1 && progress.tools === 1));

	let resolveReloaded!: () => void;
	let resolveAfterOldDispose!: () => void;
	const reloaded = new Promise<void>((resolve) => { resolveReloaded = resolve; });
	const afterOldDispose = new Promise<void>((resolve) => { resolveAfterOldDispose = resolve; });
	const replacement = new AgentLiveProjectionManager(value);
	const unsubscribeReplacement = await replacement.watch((projection) => {
		if (projection.operationId !== "reattach") return;
		if (projection.progress?.turns === 2 && projection.progress.toolCalls === 2) resolveReloaded();
		if (projection.progress?.turns === 3 && projection.progress.toolCalls === 3) resolveAfterOldDispose();
	});
	t.after(unsubscribeReplacement);

	await appendFile(join(attemptRoot, "stdout.jsonl"), `${JSON.stringify({ type: "tool_execution_end", toolName: "grep", isError: false })}\n${JSON.stringify({ type: "turn_end", message: { usage: { input: 5, output: 3, reasoning: 1, totalTokens: 28 } } })}\n`);
	await Promise.race([reloaded, new Promise((_, reject) => setTimeout(() => reject(new Error("overlapping replacement manager inherited stale fallback progress")), 1_000))]);
	unsubscribe();
	await appendFile(join(attemptRoot, "stdout.jsonl"), `${JSON.stringify({ type: "tool_execution_end", toolName: "read", isError: false })}\n${JSON.stringify({ type: "turn_end", message: { usage: { input: 4, output: 2, reasoning: 1, totalTokens: 35 } } })}\n`);
	await Promise.race([afterOldDispose, new Promise((_, reject) => setTimeout(() => reject(new Error("replacement progress froze after the old manager disposed")), 1_000))]);
	assert.equal((await value.get(agentId)).attempts[0]!.progress, undefined, "transport recovery does not restore per-event writes");
});

test("launcher progress supersedes reload fallback observers", async (t) => {
	const value = await registry(t);
	const agentId = await reserve(value, "takeover");
	const { attempt } = await value.startAttempt(agentId, undefined, { kind: "review", generation: 1 });
	const attemptRoot = join(value.root, "agents", agentId, "attempts", attempt.id);
	await mkdir(attemptRoot, { recursive: true });
	await writeFile(join(attemptRoot, "stdout.jsonl"), `${JSON.stringify({ type: "turn_end", message: { usage: { output: 1, totalTokens: 1 } } })}\n`);
	await value.markRunning(agentId, attempt.id, 606);
	const manager = new AgentLiveProjectionManager(value);
	const unsubscribe = await manager.watch(() => undefined);
	publishAgentLiveProgress(value.root, agentId, attempt.id, markAgentProcessStarted({ ...initialAgentProgress(attempt.startedAt), turns: 9 }));
	await appendFile(join(attemptRoot, "stdout.jsonl"), `${JSON.stringify({ type: "turn_end", message: { usage: { output: 1, totalTokens: 2 } } })}\n`);
	await new Promise((resolve) => setTimeout(resolve, 30));
	unsubscribe();
	const projection = (await new AgentLiveProjectionManager(value).list()).find((candidate) => candidate.agentId === agentId)!;
	assert.equal(projection.progress?.turns, 9, "an older fallback cannot overwrite or clear the launcher-owned stream");
});
