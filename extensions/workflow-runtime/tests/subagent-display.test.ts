import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentProgress, type AgentProgress } from "../agent-progress.js";
import { formatBackgroundSubagentStatus, formatInlineSubagentStatus } from "../subagent-display.js";

const now = Date.parse("2026-01-01T00:01:05.000Z");
const progress: AgentProgress = {
	startedAt: "2026-01-01T00:00:00.000Z",
	processStartedAt: "2026-01-01T00:00:01.000Z",
	lastEventAt: "2026-01-01T00:01:04.000Z",
	turns: 2,
	toolCalls: 3,
	toolErrors: 0,
	outputTokens: 1234,
	reasoningTokens: 50,
	activeTool: "bash",
};
const route = {
	tier: "medium",
	resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
	progress,
};

test("inline, footer, and workflow surfaces share one semantic live-progress projection", () => {
	const shared = formatAgentProgress(progress, now);
	assert.equal(shared, "1m 05s · 2 turns · 3 tools · bash · ↓ 1.2k · active");
	assert.equal(
		formatInlineSubagentStatus(route, now),
		"1m 05s · 2 turns · 3 tools · bash · ↓ 1.2k · Medium (openai-codex/gpt-5.6-sol#medium)",
	);
	assert.doesNotMatch(formatInlineSubagentStatus(route, now), / · active(?: ·|$)/);
	assert.equal(
		formatBackgroundSubagentStatus(route, now),
		`Medium (openai-codex/gpt-5.6-sol#medium) · ${shared}`,
	);
});

test("surface composition differs without duplicating startup and elapsed logic", () => {
	const pending = { tier: "low", startedAt: "2026-01-01T00:01:00.000Z" };
	assert.equal(formatAgentProgress(undefined, now, { fallbackStartedAt: pending.startedAt }), "5s · starting");
	assert.equal(formatInlineSubagentStatus(pending, now), "5s · starting · Low");
	assert.equal(formatBackgroundSubagentStatus(pending, now), "Low · 5s · starting");
});
