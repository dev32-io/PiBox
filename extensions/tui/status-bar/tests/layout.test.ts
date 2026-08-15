import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeStatusBarConfig } from "../config.js";
import { layoutMode, renderStatusBar } from "../layout.js";

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

const ctx = {
	cwd: "/Users/test/Development/PiBox",
	model: { id: "test-model", name: "Test Model", provider: "local", contextWindow: 100_000 },
	getContextUsage: () => ({ tokens: 42_000, contextWindow: 100_000, percent: 42 }),
	sessionManager: { getSessionName: () => "visual pass" },
} as unknown as ExtensionContext;

const data = {
	ctx,
	theme,
	thinkingLevel: "medium",
	permissionMode: "enforce" as const,
	metrics: { input: 12_400, output: 810, cacheRead: 4_000, cacheWrite: 0, cacheHitPercent: 24.4, cost: 0.042, durationMs: 840_000 },
	git: { insideWorkTree: true, branch: "main", staged: 1, modified: 2, untracked: 0, ahead: 0, behind: 0 },
	config: normalizeStatusBarConfig(),
};

test("selects explicit responsive modes", () => {
	assert.equal(layoutMode(120, data.config), "wide");
	assert.equal(layoutMode(90, data.config), "medium");
	assert.equal(layoutMode(60, data.config), "narrow");
});

test("every status layout stays within terminal width", () => {
	for (const width of [1, 2, 44, 60, 72, 90, 110, 140]) {
		const lines = renderStatusBar(width, data);
		assert.equal(lines.length, 4);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
	}
});

test("wide layout distinguishes context and session metrics", () => {
	const text = renderStatusBar(160, data).join("\n");
	assert.match(text, /42\.0%/);
	assert.match(text, /\/ 100k/);
	assert.match(text, /◆ Permissions: ENFORCED │ Thinking: MEDIUM/);
	assert.match(text, /↑ 12k/);
	assert.match(text, /↓ 810/);
	assert.match(text, /\$0\.04/);
});

test("bypass permission mode is rendered before thinking", () => {
	const row = renderStatusBar(160, { ...data, permissionMode: "bypass" })[3] ?? "";
	assert.match(row, /⚠ Permissions: BYPASS │ Thinking: MEDIUM/);
});

test("services share one optional row below thinking", () => {
	const lines = renderStatusBar(120, { ...data, serviceStatuses: ["● Mem0", "● SearXNG", "○ Visual companion"] });
	assert.equal(lines.length, 5);
	assert.match(lines[3] ?? "", /Thinking: MEDIUM/);
	assert.match(lines[4] ?? "", /● Mem0 │ ● SearXNG │ ○ Visual companion/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 120);
});

test("subagent dashboard stacks below the compact service row", () => {
	const lines = renderStatusBar(120, {
		...data,
		serviceStatuses: ["● Mem0", "● SearXNG", "○ Visual companion"],
		subagentStatuses: ["• general-purpose running · background · openai-codex/gpt-5.6-luna#max · 12s", "• explorer running · background · medium tier · 4s"],
	});
	assert.equal(lines.length, 7);
	assert.match(lines[4] ?? "", /Mem0 │ ● SearXNG │ ○ Visual companion/);
	assert.match(lines[5] ?? "", /general-purpose running/);
	assert.match(lines[6] ?? "", /explorer running/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 120);
});

test("medium layout preserves the higher-priority context segment", () => {
	const longModelContext = {
		...ctx,
		model: { ...ctx.model!, name: "An Extremely Long Local Model Name That Must Yield" },
	} as ExtensionContext;
	const firstLine = renderStatusBar(72, { ...data, ctx: longModelContext })[1] ?? "";
	assert.match(firstLine, /42\.0%/);
	assert.ok(visibleWidth(firstLine) <= 72);
});
