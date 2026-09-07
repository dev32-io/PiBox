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
	assert.equal(starting[1], "└─ Starting · Medium");
	assert.doesNotMatch(starting.join("\n"), /resolving model|foreground/);
	const rendered = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester",
		title: "Verify checkout flow",
		mode: "foreground",
		tier: "medium",
		task: "Verify one browser flow like a real user",
	}, theme, true, false, {
		agent: "e2e-tester",
		title: "Verify checkout flow",
		tier: "medium",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
	}));
	assert.match(rendered[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] e2e-tester Verify checkout flow/);
	assert.doesNotMatch(rendered[0] ?? "", /Verify one browser flow/);
	assert.equal(rendered[1], "└─ Starting · Medium (openai-codex/gpt-5.6-sol#medium)");
	assert.doesNotMatch(rendered[1] ?? "", /foreground/);
	const activeComponent = renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester", mode: "foreground", tier: "medium", task: "Verify one browser flow like a real user",
	}, theme, true, false, {
		tier: "medium",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium", fast: true },
		progress: {
			startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z",
			lastEventAt: "2026-01-01T00:01:04.000Z", turns: 2, toolCalls: 3, toolErrors: 0,
			outputTokens: 1234, reasoningTokens: 50, activeTool: "bash",
		},
	}, () => Date.parse("2026-01-01T00:01:05.000Z"));
	const active = lines(activeComponent);
	assert.equal(active[1], "└─ Running · Fast · Medium (openai-codex/gpt-5.6-sol#medium) · 2 turns · 3 tools · ↓ 1.2k · 1m 05s · bash");
	const narrow = activeComponent.render(48).map((line) => stripTerminalSequences(line));
	assert.equal(narrow.length, 4, "volatile status stays on one detail row above the prompt block");
	assert.ok(narrow.every((line) => !line.includes("\n") && line.length <= 48), "each row stays single-line and width-bounded");

	const settled = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "e2e-tester", mode: "foreground", tier: "medium", task: "Verify one browser flow like a real user",
	}, theme, false, false, {
		tier: "medium",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium", startedAt: "2026-01-01T00:00:00.000Z" },
		fast: true,
		progress: {
			startedAt: "2026-01-01T00:00:00.000Z", settledAt: "2026-01-01T00:01:05.000Z",
			lastEventAt: "2026-01-01T00:01:05.000Z", turns: 2, toolCalls: 3, toolErrors: 0,
			outputTokens: 1234, reasoningTokens: 50,
		},
	}, () => Date.parse("2026-01-01T00:02:00.000Z")));
	assert.equal(settled.length, 4, "settled foreground rows retain their resolved request metadata and prompt");
	assert.match(settled[0] ?? "", /^✓ e2e-tester/);
	assert.match(settled[1] ?? "", /^└─ Done · Fast · Medium \(openai-codex\/gpt-5\.6-sol#medium\).*1m 05s$/);

});

test("background transcript rows follow the owner-fenced event projection through terminal settlement", () => {
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const uiRef = { owner, agentId: "agent-1" };
	let now = Date.parse("2026-01-01T00:00:10.000Z");
	let projection: any = {
		agentId: "agent-1", agent: "general-purpose", state: "running", presentation: "background",
		provider: "openai-codex", model: "gpt-5.6-sol", effort: "low", tier: "low", fast: true,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:10.000Z",
		progress: { startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z", lastEventAt: "2026-01-01T00:00:10.000Z", turns: 1, toolCalls: 1, toolErrors: 0, outputTokens: 100, reasoningTokens: 0 },
	};
	const lookup = (ref: any) => {
		assert.deepEqual(ref, uiRef);
		return projection;
	};
	const details = {
		agentId: "agent-1", uiRef, state: "running",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "low", startedAt: "2026-01-01T00:00:00.000Z" },
		progress: { startedAt: "2026-01-01T00:00:00.000Z", lastEventAt: "2026-01-01T00:00:00.000Z", turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 },
	};
	const call = renderHarnessToolCall("subagent_spawn", { agent: "general-purpose", mode: "background", tier: "low", task: "Inspect" }, theme, false, false, details, () => now, lookup);
	const result = renderHarnessToolResult("subagent_spawn", { content: [{ type: "text", text: "Spawned in background." }], details }, true, theme, false, lookup);
	assert.match(lines(call)[0] ?? "", /^[·•●] general-purpose$/);
	assert.match(lines(call)[1] ?? "", /^└─ Running · Fast · Low \(openai-codex\/gpt-5\.6-sol#low\) · 1 turn · 1 tool · ↓ 100 · 10s$/);
	assert.doesNotMatch(lines(result).join("\n"), /State:|Title:|Done/);

	projection = {
		...projection,
		state: "completed",
		updatedAt: "2026-01-01T00:00:12.000Z",
		progress: { ...projection.progress, processExitedAt: "2026-01-01T00:00:12.000Z", settledAt: "2026-01-01T00:00:11.000Z", lastEventAt: "2026-01-01T00:00:12.000Z" },
	};
	now = Date.parse("2026-01-01T00:01:00.000Z");
	const terminalAtOneMinute = lines(call);
	now = Date.parse("2026-01-01T00:02:00.000Z");
	assert.deepEqual(lines(call), terminalAtOneMinute, "authoritative processExitedAt freezes the terminal duration across later renders");
	assert.match(terminalAtOneMinute[0] ?? "", /^✓ general-purpose$/);
	assert.match(terminalAtOneMinute[1] ?? "", /^└─ Done .*12s$/);

	projection = undefined;
	assert.deepEqual(lines(call).slice(1), ["└─ Launched · Low (openai-codex/gpt-5.6-sol#low)", "   Prompt:", "      Inspect"], "a detached historical launch is a static receipt, never a live clock");
	assert.doesNotMatch(lines(call).join("\n"), /Done|Running|\d+s/);
	assert.doesNotMatch(lines(result).join("\n"), /State: launched/);
});

test("foreground terminal receipts stay pinned to their attempt when the logical agent continues", () => {
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const uiRef = { owner, agentId: "agent-1" };
	const newerProjection: any = {
		agentId: "agent-1", agent: "investigator", title: "Newer attempt", state: "running", presentation: "foreground",
		provider: "new-provider", model: "new-model", effort: "high", tier: "high", fast: false,
		startedAt: "2026-01-01T00:02:00.000Z", updatedAt: "2026-01-01T00:02:03.000Z",
		progress: { startedAt: "2026-01-01T00:02:00.000Z", processStartedAt: "2026-01-01T00:02:01.000Z", turns: 1, toolCalls: 0, toolErrors: 0, outputTokens: 20, reasoningTokens: 0 },
	};
	const details = {
		agentId: "agent-1", agent: "investigator", title: "Original attempt", uiRef, state: "completed", tier: "low",
		resolved: { provider: "old-provider", model: "old-model", effort: "low", startedAt: "2026-01-01T00:00:00.000Z" },
		progress: { startedAt: "2026-01-01T00:00:00.000Z", processExitedAt: "2026-01-01T00:00:05.000Z", turns: 1, toolCalls: 1, toolErrors: 0, outputTokens: 40, reasoningTokens: 0 },
		terminal: { status: "completed" },
	};
	const rendered = lines(renderHarnessToolCall("subagent_continue", { agentId: "agent-1", task: "First follow-up" }, theme, false, false, details, () => Date.parse("2026-01-01T00:03:00.000Z"), () => newerProjection));
	assert.match(rendered[0] ?? "", /^✓ investigator Original attempt$/);
	assert.match(rendered[1] ?? "", /^└─ Done · Low \(old-provider\/old-model#low\).*5s$/);
	assert.doesNotMatch(rendered.join("\n"), /Newer attempt|new-provider|Running/);
});

test("renders child lifecycle icons and labels for stopping, failed, stopped, and launch errors", () => {
	const owner = { sessionId: "session", processInstanceId: "process", activationId: "activation" };
	const uiRef = { owner, agentId: "agent-1" };
	let state: any = "stopping";
	const lookup = () => ({
		agentId: "agent-1", agent: "investigator", state, presentation: "background",
		provider: "provider", model: "model", effort: "low", tier: "low", fast: false,
		startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:02.000Z",
		progress: { startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z", processExitedAt: state === "stopping" ? undefined : "2026-01-01T00:00:03.000Z", turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 },
	} as any);
	const call = () => lines(renderHarnessToolCall("subagent_spawn", { agent: "investigator", mode: "background", task: "Inspect" }, theme, false, false, { uiRef }, () => Date.parse("2026-01-01T00:00:04.000Z"), lookup));
	assert.match(call()[0] ?? "", /^[◐◓◑◒] investigator$/);
	assert.match(call()[1] ?? "", /^└─ Stopping · Low/);
	state = "failed";
	assert.match(call()[0] ?? "", /^✗ investigator$/);
	assert.match(call()[1] ?? "", /^└─ Failed · Low/);
	state = "cancelled";
	assert.match(call()[0] ?? "", /^○ investigator$/);
	assert.match(call()[1] ?? "", /^└─ Stopped · Low/);

	const launchError = lines(renderHarnessToolCall("subagent_spawn", { agent: "investigator", task: "Inspect" }, theme, false, true));
	assert.match(launchError[0] ?? "", /^✗ investigator$/);
	assert.equal(launchError[1], "└─ Failed");
});

test("composes one lifecycle status before prompt and foreground report", () => {
	const args = { agent: "investigator", title: "Inspect layout", task: "Check ordering", mode: "foreground" };
	const details = { agent: "investigator", title: "Inspect layout", state: "completed", terminal: { status: "completed" } };
	const call = lines(renderHarnessToolCall("subagent_spawn", args, theme, false, false, details));
	const output = lines(renderHarnessToolResult("subagent_spawn", { content: [{ type: "text", text: "Report\n  proof" }], details }, true, theme, false));
	const composed = [...call, ...output];
	assert.deepEqual(composed, [
		"✓ investigator Inspect layout",
		"└─ Done",
		"   Prompt:",
		"      Check ordering",
		"   Result:",
		"      Report",
		"        proof",
	]);
	assert.equal(composed.filter((line) => /└─ (Done|Failed|Stopped|Launched|Running|Starting|Stopping)/.test(line)).length, 1);
	assert.doesNotMatch(composed.join("\n"), /Title:|State:|Agent Id:|AgentId:/);
});

test("renders continuation foreground progress and prose like spawn", () => {
	const rendered = lines(renderHarnessToolCall("subagent_continue", {
		agentId: "agent-1", agent: "model-supplied-role", task: "Inspect the follow-up",
	}, theme, true, false, {
		agent: "investigator",
		title: "Trace fallback routing",
		tier: "high",
		resolved: { provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" },
		progress: {
			startedAt: "2026-01-01T00:00:00.000Z", processStartedAt: "2026-01-01T00:00:01.000Z",
			lastEventAt: "2026-01-01T00:00:02.000Z", turns: 1, toolCalls: 2, toolErrors: 0,
			outputTokens: 200, reasoningTokens: 0,
		},
	}, () => Date.parse("2026-01-01T00:00:03.000Z")));
	assert.match(rendered[0] ?? "", /^[·•●] investigator Trace fallback routing/);
	assert.doesNotMatch(rendered[0] ?? "", /model-supplied-role|agent-1|Inspect the follow-up/);
	assert.match(rendered[1] ?? "", /^└─ Running · High \(openai-codex\/gpt-5\.6-sol#high\) · 1 turn · 2 tools · ↓ 200 · 3s/);

	const report = Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join("\n");
	const result = lines(renderHarnessToolResult("subagent_continue", { content: [{ type: "text", text: report }] }, false, theme, false));
	assert.match(result.join("\n"), /line 10/);
	assert.doesNotMatch(result.join("\n"), /line 11/);
});

test("renders fallback provenance and sanitizes title control sequences", () => {
	const rendered = lines(renderHarnessToolCall("subagent_spawn", {
		agent: "general-purpose", title: "  Audit\n\u001b[31mrouting\u001b[0m\u001b]2;owned\u0007 ", tier: "medium", task: "ignored",
	}, theme, true, false, {
		agent: "general-purpose",
		title: "  Audit\n\u001b[31mrouting\u001b[0m\u001b]2;owned\u0007 ",
		tier: "medium",
		resolved: { provider: "selected", model: "actual", effort: "medium" },
		routing: {
			requested: { tier: "medium", model: "requested/model", effort: "high", allowFallback: true },
			selected: { provider: "selected", model: "actual", effort: "medium" },
			fallbackUsed: true,
			attempts: [{ model: "requested/model", effort: "high", status: "effort_unsupported" }],
		},
	}));
	assert.match(rendered[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] general-purpose Audit routing$/);
	assert.equal(rendered[1], "└─ Starting · Medium (selected/actual#medium) · Fallback requested/model#high → selected/actual#medium (effort unsupported)");
	assert.doesNotMatch(rendered.join(" "), /owned|[\u0000-\u001f\u007f]/);
});

test("renders paged subagent reads as historical prose with identity", () => {
	assert.equal(isHarnessTool("subagent_read"), true);
	assert.deepEqual(lines(renderHarnessToolCall("subagent_read", { agentId: "agent-1", offset: 10, limit: 20 }, theme, false, false)), ["✓ Read subagent agent-1"]);
	const rendered = lines(renderHarnessToolResult("subagent_read", {
		content: [{ type: "text", text: "terminal report\n  indented proof" }],
		details: {
			agentId: "agent-1", agent: "investigator", title: "Trace routing",
			offset: 10, count: 2, totalCharacters: 40, nextOffset: 12,
		},
	}, false, theme, false));
	assert.deepEqual(rendered, [
		"└─ Done · investigator · Trace routing · 10–12 of 40 characters",
		"  terminal report",
		"    indented proof",
	]);
});

test("renders wait timers with an animated countdown and elapsed completion", () => {
	assert.equal(isHarnessTool("wait"), true);
	const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
	let now = startedAt + 10_000;
	const live = renderHarnessToolCall("wait", { durationMs: 30_000 }, theme, true, false, {
		kind: "time", durationMs: 30_000, startedAt,
	}, () => now);
	const rendered = lines(live);
	assert.match(rendered[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Waiting 20s remaining$/);
	assert.equal(rendered[1], "└─ Timer · 30s total · 10s elapsed");
	now += 90;
	assert.notEqual(lines(live)[0]?.[0], rendered[0]?.[0], "the wait indicator advances with the shared animation cadence");
	assert.ok(live.render(24).every((line) => stripTerminalSequences(line).length <= 24));

	assert.deepEqual(lines(renderHarnessToolCall("wait", { durationMs: 30_000 }, theme, false, false, {
		kind: "time", durationMs: 30_000, startedAt, elapsedMs: 30_000,
	})), ["✓ Waited 30s"]);
	assert.deepEqual(lines(renderHarnessToolResult("wait", {
		content: [{ type: "text", text: "Waited 30000 ms." }],
		details: { kind: "time", durationMs: 30_000, startedAt, elapsedMs: 30_000 },
	}, false, theme, false)), ["└─ Timer complete · 30s elapsed"]);
});

test("renders event waits with the event, elapsed time, pending count, and settlements", () => {
	const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
	const live = lines(renderHarnessToolCall("wait", { event: "subagent_settled" }, theme, true, false, {
		kind: "event", event: "subagent_settled", startedAt, pendingCount: 2,
	}, () => startedAt + 72_000));
	assert.match(live[0] ?? "", /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Waiting for next subagent settlement$/);
	assert.equal(live[1], "└─ Event: subagent_settled · 1m 12s elapsed · 2 subagents pending");

	assert.deepEqual(lines(renderHarnessToolCall("wait", { event: "subagent_settled" }, theme, false, false, {
		kind: "event", event: "subagent_settled", startedAt, elapsedMs: 74_000,
	})), ["✓ Event received subagent_settled"]);
	assert.deepEqual(lines(renderHarnessToolResult("wait", {
		content: [{ type: "text", text: "dependency report" }],
		details: {
			kind: "event", event: "subagent_settled", startedAt, elapsedMs: 74_000,
			settlements: [{ agent: "general-purpose", agentId: "agent-1", status: "completed", summary: "dependency report" }],
		},
	}, false, theme, false)), [
		"└─ Event received · subagent_settled · 1 settlement · 1m 14s elapsed",
		"└─ general-purpose · completed · agent-1",
	]);
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

test("renders specialized workflow authoring calls", () => {
	for (const name of ["story_write", "e2e_write", "task_write", "stage_write", "workflow_compile"]) assert.equal(isHarnessTool(name), true, name);
	assert.deepEqual(lines(renderHarnessToolCall("story_write", { id: "checkout", title: "Reliable checkout" }, theme, false, false)), ["✓ Create story checkout · Reliable checkout"]);
	assert.deepEqual(lines(renderHarnessToolCall("e2e_write", { story: "work-item:checkout", id: "E2E-001", title: "Submit checkout" }, theme, false, false)), ["✓ Create E2E case work-item:checkout · E2E-001 · Submit checkout"]);
	assert.deepEqual(lines(renderHarnessToolCall("workflow_compile", {}, theme, false, false)), ["✓ Compile workflow"]);
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
	const rendered = lines(renderHarnessToolResult("task_write", result, false, theme, false));
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
	const rendered = lines(renderHarnessToolResult("task_write", {
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
	const rendered = lines(renderHarnessToolResult("task_write", {
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

test("preserves subagent report and nested output indentation", () => {
	const rendered = lines(renderHarnessToolResult("subagent_spawn", {
		content: [{ type: "text", text: [
			"Research summary",
			"",
			"src/example.ts",
			"  function outer() {",
			"    return inner();",
			"  }",
			"",
			"Command output:",
			"    nested value",
		].join("\n") }],
	}, true, theme, false));

	assert.deepEqual(rendered, [
		"   Result:",
		"      Research summary",
		"",
		"      src/example.ts",
		"        function outer() {",
		"          return inner();",
		"        }",
		"",
		"      Command output:",
		"          nested value",
	]);
});

test("child state wins over the tool result delivery phase", () => {
	const uiRef = { owner: { sessionId: "s", processInstanceId: "p", activationId: "a" }, agentId: "agent-1" };
	const projection: any = { agentId: "agent-1", agent: "investigator", state: "completed" };
	const terminalUpdate = lines(renderHarnessToolCall("subagent_spawn", { agent: "investigator", mode: "foreground" }, theme, true, false, { uiRef, state: "running" }, undefined, () => projection));
	assert.match(terminalUpdate[1]!, /^└─ Done/, "a completed child need not be mislabeled Running while its tool return is delivered");
	projection.state = "running";
	const backgroundReceipt = lines(renderHarnessToolCall("subagent_spawn", { agent: "investigator", mode: "background" }, theme, false, false, { uiRef }, undefined, () => projection));
	assert.match(backgroundReceipt[1]!, /^└─ Running/, "a returned tool receipt does not mean its child is done");
});

test("background launch receipts and identifiers stay in expanded details, not the report preview", () => {
	const details = { agentId: "agent-1", uiRef: { owner: { sessionId: "s", processInstanceId: "p", activationId: "a" }, agentId: "agent-1" }, state: "running" };
	const receipt = { content: [{ type: "text", text: "Spawned in background. Delivery instructions." }], details };
	assert.deepEqual(lines(renderHarnessToolResult("subagent_spawn", receipt, false, theme, false)), []);
	const expanded = lines(renderHarnessToolResult("subagent_spawn", receipt, true, theme, false));
	assert.deepEqual(expanded, ["   AgentId: agent-1", "   Launch receipt:", "      Spawned in background. Delivery instructions."]);
	const failed = lines(renderHarnessToolResult("subagent_spawn", receipt, false, theme, true));
	assert.match(failed.join("\n"), /Delivery instructions/, "errors must never be hidden as successful receipts");
});
