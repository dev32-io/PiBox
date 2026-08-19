import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { isHarnessTool, renderHarnessToolCall, renderHarnessToolResult } from "../components/harness-tool-renderers.js";
import { resourceDisplayDiff } from "../../../workflow/resource-diff.js";

initTheme("dark", false);

const theme = {
	fg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

const lines = (component: { render(width: number): string[] }) => component.render(160).map((line) => stripTerminalSequences(line).trimEnd());

test("renders a foreground subagent as an inline pulsing agent row", () => {
	assert.equal(isHarnessTool("subagent_spawn"), true);
	const starting = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester",
		mode: "foreground",
		tier: "medium",
		task: "Verify one browser flow like a real user",
	}, theme, true, false));
	assert.equal(starting[1], "└─ starting · Medium");
	assert.doesNotMatch(starting.join("\n"), /resolving model|foreground/);
	const rendered = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester",
		mode: "foreground",
		tier: "medium",
		task: "Verify one browser flow like a real user",
	}, theme, true, false, {
		tier: "medium",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
	}));
	assert.match(rendered[0] ?? "", /^[·•●] e2e-tester Verify one browser flow like a real user/);
	assert.equal(rendered[1], "└─ starting · Medium (openai-codex/gpt-5.6-sol#medium)");
	assert.doesNotMatch(rendered[1] ?? "", /foreground/);
	const activeComponent = renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester", mode: "foreground", tier: "medium", task: "Verify one browser flow like a real user",
	}, theme, true, false, {
		tier: "medium",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
		progress: {
			startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z",
			lastEventAt: "2026-01-01T00:01:04.000Z", turns: 2, toolCalls: 3, toolErrors: 0,
			outputTokens: 1234, reasoningTokens: 50, activeTool: "bash",
		},
	}, () => Date.parse("2026-01-01T00:01:05.000Z"));
	const active = lines(activeComponent);
	assert.equal(active[1], "└─ 1m 05s · 2 turns · 3 tools · bash · ↓ 1.2k · active · Medium (openai-codex/gpt-5.6-sol#medium)");
	const narrow = activeComponent.render(48).map((line) => stripTerminalSequences(line));
	assert.equal(narrow.length, 2, "volatile status stays on one detail row");
	assert.ok(narrow.every((line) => !line.includes("\n") && line.length <= 48), "each row stays single-line and width-bounded");
});

test("renders distillation calls with scope-specific titles", () => {
	assert.equal(isHarnessTool("distill_prepare"), true);
	assert.deepEqual(lines(renderHarnessToolCall("distill_prepare", {
		baseline: "v1.0",
		target: "main",
	}, theme, false, false)), ["✓ Preview distillation v1.0..main"]);
});

test("renders memory calls with action-specific titles", () => {
	assert.equal(isHarnessTool("memory_adapter"), true);
	assert.deepEqual(lines(renderHarnessToolCall("memory_adapter", {
		action: "recall",
		query: "audio interruption semantics",
	}, theme, false, false)), [
		"✓ Recall memories “audio interruption semantics”",
	]);
});

test("renders recalled memories as compact typed tree rows", () => {
	const rendered = lines(renderHarnessToolResult("memory_adapter", {
		content: [{ type: "text", text: "raw memory output that should not be rendered" }],
		details: {
			action: "recall",
			records: [
				{ id: "memory-1", memory: "Assistant audio remains FIFO by turn.", metadata: { type: "audio-contract", status: "active" } },
				{ id: "memory-2", memory: "Interrupt clears local playback first.", metadata: { type: "audio-pitfall", status: "active" } },
			],
		},
	}, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 2 memories",
		"├─ memory-1 · audio-contract · Assistant audio remains FIFO by turn.",
		"└─ memory-2 · audio-pitfall · Interrupt clears local playback first.",
	]);
	assert.doesNotMatch(rendered.join("\n"), /raw memory output/);
});

test("renders memory audit findings with bounded review reasons", () => {
	const rendered = lines(renderHarnessToolResult("memory_adapter", {
		content: [{ type: "text", text: "1 memories require semantic review." }],
		details: {
			action: "audit",
			checked: 41,
			bounded: true,
			findings: [{ id: "memory-1", reasons: ["evidence changed since verification", "verification older than 90 days"] }],
		},
	}, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 41 checked · 1 finding · bounded",
		"└─ memory-1 · evidence changed since verification; verification older than 90 days",
	]);
});

test("renders resource lists as concise tree rows instead of raw JSON", () => {
	const result = {
		content: [{ type: "text", text: JSON.stringify({ count: 2, resources: [
			{ ref: "work-item:checkout", title: "Checkout", state: "active" },
			{ ref: "work-item:search", title: "Search", state: "complete" },
		] }, null, 2) }],
		details: { label: "resource list" },
	};
	const rendered = lines(renderHarnessToolResult("resource_list", result, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 2 items",
		"├─ work-item:checkout · Checkout · active",
		"└─ work-item:search · Search · complete",
	]);
	assert.doesNotMatch(rendered.join("\n"), /[{}\[\]"]/);
});

test("renders resource mutation receipts as labeled fields", () => {
	const receipt = { ref: "work-item:checkout/task:implement", commit: "abc123", revision: 3 };
	const result = {
		content: [{ type: "text", text: `Wrote ${receipt.ref}.\n${JSON.stringify(receipt, null, 2)}` }],
		details: receipt,
	};
	const rendered = lines(renderHarnessToolResult("resource_write", result, false, theme, false));
	assert.equal(rendered[0], "└─ Done · commit abc123");
	assert.match(rendered.join("\n"), /Ref: work-item:checkout\/task:implement/);
	assert.match(rendered.join("\n"), /Revision: 3/);
	assert.match(rendered.join("\n"), /Commit: abc123/);
});

test("renders canonical resource updates as a colored semantic diff", () => {
	const diff = resourceDisplayDiff("update", "work-item:checkout/task:implement", {
		id: "implement", revision: 2, status: "draft", brief: "Old behavior",
	}, {
		id: "implement", revision: 3, status: "ready", brief: "New behavior",
	});
	const rendered = lines(renderHarnessToolResult("resource_write", {
		content: [{ type: "text", text: "Wrote work-item:checkout/task:implement." }],
		details: { commit: "abcdef1234567890", piboxResourceDiff: diff },
	}, false, theme, false));
	assert.match(rendered[0] ?? "", /Done · Update work-item:checkout\/task:implement · commit abcdef123456/);
	assert.match(rendered.join("\n"), /-.*draft/);
	assert.match(rendered.join("\n"), /\+.*ready/);
	assert.doesNotMatch(rendered.join("\n"), /revision/);
});

test("renders canonical mutation changes and commit without receipt JSON", () => {
	const receipt = {
		ok: true,
		commit: "1234567890abcdef",
		changes: [{ action: "create", ref: "work-item:checkout/task:implement" }],
		affected: [{ ref: "work-item:checkout", revision: 2, state: "active" }],
	};
	const rendered = lines(renderHarnessToolResult("resource_write", {
		content: [{ type: "text", text: `Wrote work-item:checkout/task:implement.\n${JSON.stringify(receipt, null, 2)}` }],
		details: receipt,
	}, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · 1 item · commit 1234567890ab",
		"└─ work-item:checkout/task:implement · create",
	]);
});

test("collapses verbose foreground subagent results with an expand hint", () => {
	const resultLines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
	const rendered = lines(renderHarnessToolResult("subagent_spawn", {
		content: [{ type: "text", text: resultLines.join("\n") }],
	}, false, theme, false));
	assert.match(rendered.join("\n"), /line 10/);
	assert.doesNotMatch(rendered.join("\n"), /line 11/);
	assert.match(rendered.join("\n"), /… \+2 more lines \(ctrl\+o to expand\)/);

	const expanded = lines(renderHarnessToolResult("subagent_spawn", {
		content: [{ type: "text", text: resultLines.join("\n") }],
	}, true, theme, false));
	assert.match(expanded.join("\n"), /line 12/);
});
