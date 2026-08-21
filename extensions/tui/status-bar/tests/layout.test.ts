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

test("renders variable provider windows after unchanged context", () => {
	const text = renderStatusBar(160, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [
		{ usedPercent: 70, resetAt: Date.now() + 60 * 60_000 },
		{ usedPercent: 85, resetAt: Date.now() + 24 * 60 * 60_000 },
	] } }).join("\n");
	assert.match(text, /42\.0% \/ 100k │ 70%/);
	assert.match(text, /85%/);
});

test("renders a single returned window without reserving text for a missing short window", () => {
	const text = renderStatusBar(160, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [{ usedPercent: 92 }] } }).join("\n");
	assert.match(text, /\/ 100k │ 92%/);
	assert.doesNotMatch(text, /—|5h|7d/);
});

test("hides quota when it cannot fit or no reliable windows exist", () => {
	assert.doesNotMatch(renderStatusBar(72, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [{ usedPercent: 70 }] } }).join("\n"), /70%/);
	assert.deepEqual(
		renderStatusBar(160, { ...data, usage: { provider: "ollama-cloud", observedAt: Date.now(), windows: [] } }),
		renderStatusBar(160, data),
	);
});

test("wide layout distinguishes context and session metrics", () => {
	const text = renderStatusBar(160, data).join("\n");
	assert.match(text, /42\.0%/);
	assert.match(text, /\/ 100k/);
	assert.match(text, /◆ Permissions: ENFORCED │ Effort: MEDIUM/);
	assert.match(text, /↑ 12k/);
	assert.match(text, /↓ 810/);
	assert.match(text, /\$0\.04/);
});

test("bypass permission mode is rendered before effort", () => {
	const row = renderStatusBar(160, { ...data, permissionMode: "bypass" })[3] ?? "";
	assert.match(row, /⚠ Permissions: BYPASS │ Effort: MEDIUM/);
});

test("renders compact requested Fast-mode scopes after effort", () => {
	const off = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.match(off, /Effort: MEDIUM │ Fast req: OFF/);
	const main = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "off" } })[3] ?? "";
	assert.match(main, /Effort: MEDIUM │ Fast req: MAIN/);
	for (const [limit, label] of [["low", "LOW"], ["medium", "MED"], ["high", "HIGH"], ["max", "MAX"]] as const) {
		const combined = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: limit } })[3] ?? "";
		assert.match(combined, new RegExp(`Effort: MEDIUM │ Fast req: MAIN\\+SUB≤${label}`));
		const subagentsOnly = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: false, subagents: limit } })[3] ?? "";
		assert.match(subagentsOnly, new RegExp(`Effort: MEDIUM │ Fast req: SUB≤${label}`));
	}
});

test("colors enabled Fast request scopes as premium usage and drops the whole segment at its fit boundary", () => {
	const tokenTheme = {
		fg: (token: string, value: string) => `<${token}>${value}</${token}>`,
		bold: (value: string) => value,
	} as unknown as Theme;
	const enabled = renderStatusBar(400, { ...data, theme: tokenTheme, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "off" } })[3] ?? "";
	assert.match(enabled, /<dim>Fast req:<\/dim> <warning>MAIN<\/warning>/);
	const off = renderStatusBar(400, { ...data, theme: tokenTheme, fastMode: { mainAvailable: true, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.match(off, /<dim>Fast req:<\/dim> <dim>OFF<\/dim>/);

	const status = { mainAvailable: true, mainEnabled: true, subagents: "max" as const };
	const firstVisible = Array.from({ length: 129 }, (_, index) => 72 + index).find((width) => (renderStatusBar(width, { ...data, fastMode: status })[3] ?? "").includes("Fast req:"));
	assert.ok(firstVisible && firstVisible > 72);
	assert.doesNotMatch(renderStatusBar(firstVisible! - 1, { ...data, fastMode: status })[3] ?? "", /Fast req:/);
	assert.match(renderStatusBar(firstVisible!, { ...data, fastMode: status })[3] ?? "", /Fast req: MAIN\+SUB≤MAX/);
});

test("hides unavailable or width-constrained Fast-mode status without harming core segments", () => {
	const unavailable = renderStatusBar(160, { ...data, fastMode: { mainAvailable: false, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.doesNotMatch(unavailable, /Fast req:/);
	const subagents = renderStatusBar(160, { ...data, fastMode: { mainAvailable: false, mainEnabled: false, subagents: "medium" } })[3] ?? "";
	assert.match(subagents, /Fast req: SUB≤MED/);
	const narrow = renderStatusBar(60, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "max" } })[3] ?? "";
	assert.doesNotMatch(narrow, /Fast req:/);
	assert.equal(narrow, renderStatusBar(60, data)[3]);
	assert.ok(visibleWidth(narrow) <= 60);
});

test("services share one optional row below effort", () => {
	const lines = renderStatusBar(120, { ...data, serviceStatuses: ["● Mem0", "● SearXNG", "○ Visual companion"] });
	assert.equal(lines.length, 5);
	assert.match(lines[3] ?? "", /Effort: MEDIUM/);
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
