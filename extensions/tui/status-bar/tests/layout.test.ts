import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { normalizeStatusBarConfig } from "../config.js";
import { layoutMode, renderStatusBar, renderStatusBarLayout } from "../layout.js";

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

test("renders remaining percentages for variable provider windows after unchanged context", () => {
	const text = renderStatusBar(160, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [
		{ usedPercent: 70, resetAt: Date.now() + 60 * 60_000 },
		{ usedPercent: 85, resetAt: Date.now() + 24 * 60 * 60_000 },
	] } }).join("\n");
	assert.match(text, /42\.0% \/ 100k │ 30%/);
	assert.match(text, /15%/);
});

test("renders a single returned window as remaining quota without reserving text for a missing short window", () => {
	const text = renderStatusBar(160, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [{ usedPercent: 92 }] } }).join("\n");
	assert.match(text, /\/ 100k │ 8%/);
	assert.doesNotMatch(text, /—|5h|7d/);
});

test("hides quota when it cannot fit or no reliable windows exist", () => {
	assert.doesNotMatch(renderStatusBar(72, { ...data, usage: { provider: "openai-codex", observedAt: Date.now(), windows: [{ usedPercent: 70 }] } }).join("\n"), /30%/);
	assert.deepEqual(
		renderStatusBar(160, { ...data, usage: { provider: "ollama-cloud", observedAt: Date.now(), windows: [] } }),
		renderStatusBar(160, data),
	);
});

test("designer profile replaces the Pi mark with a visible designer identity", () => {
	const designer = renderStatusBar(160, { ...data, profile: "designer" })[1] ?? "";
	assert.match(designer, /designer/);
	assert.doesNotMatch(renderStatusBar(160, data)[1] ?? "", /designer/);
});

test("wide layout distinguishes context and session metrics", () => {
	const text = renderStatusBar(160, data).join("\n");
	assert.match(text, /42\.0%/);
	assert.match(text, /\/ 100k/);
	assert.match(text, /◆ Permissions: Enforced │ Effort: Medium/);
	assert.match(text, /↑ 12k/);
	assert.match(text, /↓ 810/);
	assert.match(text, /\$0\.04/);
});

test("bypass permission mode is rendered before effort", () => {
	const row = renderStatusBar(160, { ...data, permissionMode: "bypass" })[3] ?? "";
	assert.match(row, /⚠ Permissions: Bypass │ Effort: Medium/);
});

test("renders the tier profile after effort and before compact Fast scopes", () => {
	const row = renderStatusBar(200, {
		...data,
		tierProfile: { profile: "token-conservative" },
		fastMode: { mainAvailable: true, mainEnabled: true, subagents: "medium" },
	})[3] ?? "";
	assert.match(row, /Effort: Medium │ Tier: Token-conservative │ Fast: Main\+Sub≤Med/);
});

test("renders compact requested Fast-mode scopes after effort", () => {
	const off = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.match(off, /Effort: Medium │ Fast: Off/);
	const main = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "off" } })[3] ?? "";
	assert.match(main, /Effort: Medium │ Fast: Main/);
	for (const [limit, label] of [["low", "Low"], ["medium", "Med"], ["high", "High"], ["max", "Max"]] as const) {
		const combined = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: limit } })[3] ?? "";
		assert.match(combined, new RegExp(`Effort: Medium │ Fast: Main\\+Sub≤${label}`));
		const subagentsOnly = renderStatusBar(160, { ...data, fastMode: { mainAvailable: true, mainEnabled: false, subagents: limit } })[3] ?? "";
		assert.match(subagentsOnly, new RegExp(`Effort: Medium │ Fast: Sub≤${label}`));
	}
});

test("colors enabled Fast request scopes as premium usage and drops the whole segment at its fit boundary", () => {
	const tokenTheme = {
		fg: (token: string, value: string) => `<${token}>${value}</${token}>`,
		bold: (value: string) => value,
	} as unknown as Theme;
	const enabled = renderStatusBar(400, { ...data, theme: tokenTheme, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "off" } })[3] ?? "";
	assert.match(enabled, /<dim>Fast:<\/dim> <warning>Main<\/warning>/);
	const off = renderStatusBar(400, { ...data, theme: tokenTheme, fastMode: { mainAvailable: true, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.match(off, /<dim>Fast:<\/dim> <dim>Off<\/dim>/);

	const status = { mainAvailable: true, mainEnabled: true, subagents: "max" as const };
	const firstVisible = Array.from({ length: 129 }, (_, index) => 72 + index).find((width) => (renderStatusBar(width, { ...data, fastMode: status })[3] ?? "").includes("Fast:"));
	assert.ok(firstVisible && firstVisible > 72);
	assert.doesNotMatch(renderStatusBar(firstVisible! - 1, { ...data, fastMode: status })[3] ?? "", /Fast:/);
	assert.match(renderStatusBar(firstVisible!, { ...data, fastMode: status })[3] ?? "", /Fast: Main\+Sub≤Max/);
});

test("hides unavailable or width-constrained Fast-mode status without harming core segments", () => {
	const unavailable = renderStatusBar(160, { ...data, fastMode: { mainAvailable: false, mainEnabled: false, subagents: "off" } })[3] ?? "";
	assert.doesNotMatch(unavailable, /Fast:/);
	const subagents = renderStatusBar(160, { ...data, fastMode: { mainAvailable: false, mainEnabled: false, subagents: "medium" } })[3] ?? "";
	assert.match(subagents, /Fast: Sub≤Med/);
	const narrow = renderStatusBar(60, { ...data, fastMode: { mainAvailable: true, mainEnabled: true, subagents: "max" } })[3] ?? "";
	assert.doesNotMatch(narrow, /Fast:/);
	assert.equal(narrow, renderStatusBar(60, data)[3]);
	assert.ok(visibleWidth(narrow) <= 60);
});

test("services share one optional row below effort", () => {
	const lines = renderStatusBar(120, { ...data, serviceStatuses: ["● Mem0", "● SearXNG", "○ Visual companion"] });
	assert.equal(lines.length, 5);
	assert.match(lines[3] ?? "", /Effort: Medium/);
	assert.match(lines[4] ?? "", /● Mem0 │ ● SearXNG │ ○ Visual companion/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 120);
});

test("interactive layout exposes visible footer rows and marks the selected element", () => {
	const layout = renderStatusBarLayout(160, {
		...data,
		tierProfile: { profile: "performance" },
		fastMode: { mainAvailable: true, mainEnabled: true, subagents: "medium" },
		serviceStatuses: [
			{ id: "service:mem0", text: "● Mem0" },
			{ id: "service:searxng", text: "● SearXNG" },
		],
		selectedInteractiveId: "tier-profile",
	});
	assert.deepEqual(layout.interactiveRows, [
		["permissions", "effort", "tier-profile", "fast-mode"],
		["service:mem0", "service:searxng"],
	]);
	assert.match(layout.lines[3] ?? "", /› Tier: Performance/);
	for (const line of layout.lines) assert.ok(visibleWidth(line) <= 160);
});

test("settings hidden by right-side metrics are not exposed as invisible interactive targets", () => {
	const layout = renderStatusBarLayout(20, data);
	assert.deepEqual(layout.interactiveRows, []);
	assert.doesNotMatch(layout.lines[3] ?? "", /Permissions|Effort/);
	assert.ok(layout.lines.every((line) => visibleWidth(line) <= 20));
});

test("truncated services are not exposed as invisible interactive targets", () => {
	const layout = renderStatusBarLayout(16, {
		...data,
		serviceStatuses: [
			{ id: "service:mem0", text: "● Mem0" },
			{ id: "service:searxng", text: "● SearXNG" },
			{ id: "service:visual-companion", text: "○ Visual companion" },
		],
	});
	assert.deepEqual(layout.interactiveRows.at(-1), ["service:mem0"]);
	assert.ok(layout.lines.every((line) => visibleWidth(line) <= 16));
});

test("service targets remain stable when selection markers are applied at a fit boundary", () => {
	const services = [
		{ id: "service:mem0", text: "● Mem0" },
		{ id: "service:searxng", text: "● SearXNG" },
	];
	const inactive = renderStatusBarLayout(22, { ...data, serviceStatuses: services });
	const selected = renderStatusBarLayout(22, { ...data, serviceStatuses: services, selectedInteractiveId: "service:searxng" });
	assert.deepEqual(inactive.interactiveRows.at(-1), ["service:mem0"]);
	assert.deepEqual(selected.interactiveRows.at(-1), ["service:mem0"]);
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

test("structured subagent projection renders bounded semantic rows and overflow width-safely", () => {
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const startedAt = "2026-01-01T00:00:00.000Z";
	const agents = ["alpha", "beta", "gamma"].map((agent, index) => ({
		agentId: `agent-${index}`,
		agent,
		state: "running" as const,
		presentation: "background" as const,
		provider: "openai-codex",
		model: "gpt-5.6-sol-with-a-very-long-route-name",
		effort: "high",
		tier: "medium",
		fast: index === 0,
		startedAt,
		updatedAt: startedAt,
		progress: { startedAt, processStartedAt: startedAt, lastEventAt: startedAt, turns: 2, toolCalls: 3, toolErrors: 0, outputTokens: 1200, reasoningTokens: 0, cacheReadTokens: 400, cacheWriteTokens: 20 },
	}));
	const now = Date.parse("2026-01-01T00:01:05.000Z");
	for (const width of [24, 60, 120]) {
		const lines = renderStatusBar(width, { ...data, now, subagents: { owner, agents, overflow: 2 } });
		assert.equal(lines.length, 8);
		assert.match(lines.at(-1) ?? "", /\+2 more subagents/);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
	}
	const text = renderStatusBar(160, { ...data, now, subagents: { owner, agents, overflow: 2 } }).join("\n");
	assert.match(text, /alpha · Fast · Medium \(openai-codex\/gpt-5\.6-sol-with-a-very-long-route-name#high\)/);
	assert.match(text, /2 turns · 3 tools · ↓ 1\.2k · 1m 05s/);
	assert.doesNotMatch(text, /R 400|W 20| · active/);
});
