import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatAgentProgress, initialAgentProgress, markAgentProcessExited, markAgentProcessStarted, projectAgentProgress } from "../agent-progress.js";
import { observeJsonl } from "../direct-agent.js";

test("projects only concise semantic progress from child events", () => {
	let progress = initialAgentProgress("2026-01-01T00:00:00.000Z");
	const apply = (event: unknown, at: string) => { progress = projectAgentProgress(progress, event, at); };
	apply({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private" } }, "2026-01-01T00:00:01.000Z");
	apply({ type: "tool_execution_start", toolName: "bash", args: { command: "secret" } }, "2026-01-01T00:00:02.000Z");
	apply({ type: "tool_execution_end", toolName: "bash", isError: false, result: { content: "private" } }, "2026-01-01T00:00:03.000Z");
	apply({ type: "turn_end", message: { usage: { input: 70_704, output: 7804, reasoning: 1978, totalTokens: 78508 } } }, "2026-01-01T00:00:04.000Z");
	apply({ type: "agent_settled" }, "2026-01-01T00:03:08.000Z");
	assert.deepEqual(progress, {
		startedAt: "2026-01-01T00:00:00.000Z", lastEventAt: "2026-01-01T00:03:08.000Z",
		turns: 1, toolCalls: 1, toolErrors: 0, inputTokens: 70_704, outputTokens: 7804, reasoningTokens: 1978,
		contextTokens: 78508, settledAt: "2026-01-01T00:03:08.000Z",
	});
	const rendered = formatAgentProgress(progress, Date.parse("2026-01-01T00:04:00.000Z"));
	assert.equal(rendered, "3m 08s · 1 turn · 1 tool · ↓ 7.8k");
	assert.doesNotMatch(rendered, /out|private|secret/i);
	assert.match(formatAgentProgress({ ...progress, outputTokens: 152_000 }), /↓ 152k/);
});

test("accumulates input tokens from historical progress records that predate the field", () => {
	const historical: any = { startedAt: "2026-01-01T00:00:00.000Z", lastEventAt: "2026-01-01T00:00:00.000Z", turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 };
	const first = projectAgentProgress(historical, { type: "turn_end", message: { usage: { input: 125 } } }, "2026-01-01T00:00:01.000Z");
	const second = projectAgentProgress(first, { type: "turn_end", message: { usage: { input: 75 } } }, "2026-01-01T00:00:02.000Z");
	assert.equal(second.inputTokens, 200);
	assert.equal(historical.inputTokens, undefined);
});

test("tracks startup and activity from the child Pi process instead of event recency", () => {
	const startedAt = "2026-01-01T00:00:00.000Z";
	const starting = initialAgentProgress(startedAt);
	assert.equal(formatAgentProgress(starting, Date.parse("2026-01-01T00:00:08.000Z")), "8s · starting");
	const spawned = markAgentProcessStarted(starting, "2026-01-01T00:00:09.000Z");
	assert.equal(formatAgentProgress(spawned, Date.parse("2026-01-01T00:00:11.000Z")), "11s · active");
	assert.equal(formatAgentProgress(spawned, Date.parse("2026-01-01T00:00:11.000Z"), { showActive: false }), "11s");
	assert.equal(formatAgentProgress(starting, Date.parse("2026-01-01T00:00:08.000Z"), { showActive: false }), "8s · starting");
	const active = { ...spawned, turns: 1, outputTokens: 120, lastEventAt: "2026-01-01T00:00:10.000Z" };
	assert.match(formatAgentProgress(active, Date.parse("2026-01-01T00:00:29.000Z")), /↓ 120 · active$/);
	assert.match(formatAgentProgress(active, Date.parse("2026-01-01T00:10:00.000Z")), /↓ 120 · active$/);
	assert.doesNotMatch(formatAgentProgress(active, Date.parse("2026-01-01T00:10:00.000Z")), /idle/);
	const agentSettled = projectAgentProgress(active, { type: "agent_settled" }, "2026-01-01T00:10:00.000Z");
	assert.match(formatAgentProgress(agentSettled, Date.parse("2026-01-01T00:10:01.000Z")), /active$/, "agent events do not replace process status");
	const exited = markAgentProcessExited(agentSettled, "2026-01-01T00:10:01.000Z");
	assert.doesNotMatch(formatAgentProgress(exited, Date.parse("2026-01-01T00:11:00.000Z")), /starting|active|idle/);
});

test("incremental JSONL observation handles partial lines and duplicate drains exactly once", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pibox-jsonl-observer-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "stdout.jsonl");
	await writeFile(path, "");
	const events: unknown[] = [];
	const malformed: string[] = [];
	const observer = await observeJsonl(path, (event) => events.push(event), (line) => malformed.push(line));
	await appendFile(path, '{"type":"turn_');
	await observer.drain();
	assert.equal(events.length, 0);
	await appendFile(path, 'start"}\n{"type":"agent_settled"}\n');
	await Promise.all([observer.drain(), observer.drain()]);
	await observer.close();
	assert.deepEqual(events, [{ type: "turn_start" }, { type: "agent_settled" }]);
	assert.deepEqual(malformed, []);
});
