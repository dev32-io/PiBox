import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatAgentProgress, type AgentProgress } from "../agent-progress.js";
import {
	formatBackgroundSubagentStatus,
	formatInlineSubagentStatus,
	renderSubagentLiveStatus,
	subagentIndicatorFrame,
	subagentStatusSegments,
} from "../display.js";

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
	agent: "general-purpose",
	tier: "medium",
	resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
	progress,
};

test("inline, footer, and workflow surfaces share stable-to-volatile status ordering", () => {
	const shared = formatAgentProgress(progress, now);
	assert.equal(shared, "2 turns · 3 tools · ↓ 1.2k · 1m 05s · bash");
	const expected = "general-purpose · Medium (openai-codex/gpt-5.6-sol#medium) · 2 turns · 3 tools · ↓ 1.2k · 1m 05s · bash";
	assert.equal(formatInlineSubagentStatus(route, now), expected);
	assert.equal(formatBackgroundSubagentStatus(route, now), expected);
	assert.doesNotMatch(expected, /starting|active|stopping/);
	const fast = { ...route, resolved: { ...route.resolved, fast: true } };
	assert.equal(formatInlineSubagentStatus(fast, now), "general-purpose · Fast · Medium (openai-codex/gpt-5.6-sol#medium) · 2 turns · 3 tools · ↓ 1.2k · 1m 05s · bash");
});

test("startup keeps stable identity and route while lifecycle moves to animation", () => {
	const pending = { agent: "general-purpose", tier: "low", startedAt: "2026-01-01T00:01:00.000Z" };
	assert.equal(formatAgentProgress(undefined, now, { fallbackStartedAt: pending.startedAt }), "5s");
	assert.equal(formatInlineSubagentStatus(pending, now), "general-purpose · Low · 5s");
	assert.equal(formatBackgroundSubagentStatus({ ...pending, processStatus: "active" }, now), "general-purpose · Low · 5s");
	assert.notEqual(subagentIndicatorFrame("starting", 0), subagentIndicatorFrame("running", 0));
	assert.notEqual(subagentIndicatorFrame("stopping", 0), subagentIndicatorFrame("running", 0));
});

test("semantic segments apply footer-consistent colors without recoloring the whole line", () => {
	const theme = {
		fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>`,
	} as unknown as Theme;
	const status = { ...route, fast: true, progress: { ...progress, toolErrors: 1 } };
	const segments = subagentStatusSegments(status, now);
	assert.deepEqual(segments.map(({ text }) => text), ["general-purpose", "Fast", "Medium (openai-codex/gpt-5.6-sol#medium)", "2 turns", "3 tools", "1 error", "↓ 1.2k", "1m 05s", "bash"]);
	const rendered = renderSubagentLiveStatus(status, theme, now);
	assert.match(rendered, /<text>general-purpose<\/text>/);
	assert.match(rendered, /<warning>Fast<\/warning>/);
	assert.match(rendered, /<muted>Medium \(openai-codex\/gpt-5\.6-sol#medium\)<\/muted>/);
	assert.match(rendered, /<error>1 error<\/error>/);
	assert.match(rendered, /<accent>bash<\/accent>$/);
});
