import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import spinners from "./index.js";

function harness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: Array<{ type: string; data: any }> = [];
	const renderers = new Map<string, (...args: any[]) => any>();
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerEntryRenderer(name: string, renderer: (...args: any[]) => any) { renderers.set(name, renderer); },
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
	} as unknown as ExtensionAPI;
	spinners(pi);
	return { handlers, entries, renderers };
}

function tuiContext() {
	const working: Array<string | undefined> = [];
	return {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWorkingIndicator() {},
			setHiddenThinkingLabel() {},
			setWorkingMessage(value?: string) { working.push(value); },
		},
		getContextUsage() { throw new Error("must not read full context"); },
		sessionManager: { getBranch() { throw new Error("must not count history"); } },
		working,
	};
}

const message = (output = 120, stopReason = "toolUse") => ({
	role: "assistant", stopReason,
	content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "x" } }],
	usage: { input: 100, output, cacheRead: 900, cacheWrite: 20, cost: { total: 0 } },
});
const detail = (ctx: ReturnType<typeof tuiContext>) => ctx.working.at(-1)?.split("\n").at(-1);

test("headless events neither inspect messages nor emit metrics", () => {
	const { handlers, entries } = harness();
	const ctx = { mode: "json", ui: {} };
	const unreadable = { get content() { throw new Error("headless content read"); } };
	for (const name of ["session_start", "agent_start", "before_provider_request", "message_update", "message_end", "agent_end", "session_shutdown"]) {
		handlers.get(name)?.({ message: unreadable, messages: [unreadable] }, ctx);
	}
	assert.equal(entries.length, 0);
});

test("live counters stay visible, completed usage freezes and measured speed excludes tools", (t) => {
	let now = 1_000;
	t.mock.method(performance, "now", () => now);
	const { handlers, entries, renderers } = harness();
	const ctx = tuiContext();
	const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	t.after(() => fire("session_shutdown"));
	fire("session_start");
	fire("agent_start");
	assert.match(detail(ctx)!, /^└─ 0s · ↑ 0 · ↓ 0 · 0.0 tok\/s$/);
	fire("message_end", { message: { role: "system", content: "s".repeat(100_000) } });
	fire("message_end", { message: { role: "user", content: [{ type: "text", text: "p".repeat(4_800) }] } });
	fire("before_provider_request");
	now = 1_600;
	fire("message_update", { message: { ...message(), content: [] } });
	assert.equal(detail(ctx), "└─ 0s · ↑ 600 · ↓ 0 · 0.0 tok/s");
	now = 2_000;
	fire("message_update", { message: { ...message(), content: [{ type: "thinking", thinking: "Checking numbers" }] } });
	assert.equal(detail(ctx), "└─ 1s · ↑ 1,000 · ↓ 4 · 4.0 tok/s");
	assert.match(ctx.working.at(-1)!.replace(/\x1b\[[0-9;]*m/g, ""), /Checking numbers/);
	now = 3_000;
	fire("message_update", { message: message() });
	assert.equal(detail(ctx), "└─ 2s · ↑ 1,200 · ↓ 3 · 1.5 tok/s");
	fire("message_end", { message: message() });
	assert.equal(detail(ctx), "└─ 2s · ↑ 1,200 · ↓ 120 · cache 88.24% · 60.0 tok/s");
	const frozen = detail(ctx);
	now = 23_000;
	fire("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "r".repeat(32) }] } });
	fire("message_update", { message: { role: "toolResult" } });
	assert.equal(detail(ctx), frozen);
	fire("turn_start");
	fire("before_provider_request");
	assert.equal(detail(ctx), "└─ 0s · ↑ 1,200 · ↓ 120 · 0.0 tok/s");
	now = 27_000;
	fire("message_end", { message: message(60, "stop") });
	assert.equal(detail(ctx), "└─ 4s · ↑ 1,208 · ↓ 180 · cache 88.24% · 15.0 tok/s");
	fire("agent_end", { messages: [message(), message(60, "stop")] });
	assert.equal(entries[0]!.data.averageTokensPerSecond, 30);
	assert.equal(entries[0]!.data.outputTokens, 180);
	assert.equal(entries[0]!.data.inputTokens, 1_208);
	const renderer = renderers.get("pibox-round-summary")!;
	const rendered = renderer(entries[0], {}, ctx.ui.theme).render(200).join("\n");
	assert.match(rendered, /↑ 1,208 · ↓ 180 · cache 88.24% · 30.0 tok\/s/);
	assert.doesNotMatch(rendered, /avg|≈|estimate/);
	const legacy = { data: { word: "Cooked", durationMs: 1000, inputTokens: 1, outputTokens: 2 } };
	assert.doesNotMatch(renderer(legacy, {}, ctx.ui.theme).render(200).join("\n"), /tok\/s|cache/);
	fire("agent_start");
	assert.equal(detail(ctx), "└─ 0s · ↑ 0 · ↓ 0 · 0.0 tok/s");
	fire("agent_end", { messages: [] });
	assert.equal(entries[1]!.data.averageTokensPerSecond, undefined);
});

test("retry clock resets; failed, absent and zero-duration measurements never invent speed", (t) => {
	let now = 0;
	t.mock.method(performance, "now", () => now);
	const { handlers, entries } = harness();
	const ctx = tuiContext();
	const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	t.after(() => fire("session_shutdown"));
	fire("agent_start");
	fire("before_provider_request");
	now = 10_000;
	fire("before_provider_request");
	now = 12_000;
	fire("message_end", { message: message() });
	assert.match(detail(ctx)!, /60.0 tok\/s$/);
	fire("agent_end", { messages: [message()] });
	for (const reason of ["error", "aborted", "stop"]) {
		fire("agent_start");
		fire("before_provider_request");
		if (reason !== "stop") now += 1_000;
		fire("message_end", { message: message(120, reason) });
		assert.doesNotMatch(detail(ctx)!, /tok\/s/);
		fire("agent_end", { messages: [message(120, reason)] });
		assert.equal(entries.at(-1)!.data.averageTokensPerSecond, undefined);
	}
	fire("agent_start");
	fire("message_end", { message: message() });
	assert.doesNotMatch(detail(ctx)!, /tok\/s/);
	fire("before_provider_request");
	now += 1_000;
	fire("message_end", { message: { ...message(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
	assert.equal(detail(ctx), "└─ 1s · ↑ 0 · ↓ 123");
});

test("cache rate uses reported input, weights requests, and hides unavailable usage", (t) => {
	const { handlers, entries, renderers } = harness();
	const ctx = tuiContext();
	const fire = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	t.after(() => fire("session_shutdown"));
	const first = { ...message(), usage: { input: 10, output: 1000, cacheRead: 90, cacheWrite: 0, cost: { total: 1 } } };
	const second = { ...message(), usage: { input: 300, output: 1000, cacheRead: 0, cacheWrite: 600, cost: { total: 2 } } };
	fire("agent_start");
	fire("message_end", { message: first });
	assert.match(detail(ctx)!, /↓ 1,000 · cache 90%$/);
	fire("message_end", { message: second });
	assert.match(detail(ctx)!, /cache 0%$/);
	fire("agent_end", { messages: [first, second] });
	assert.equal(entries[0]!.data.cacheHitPercent, 9);
	const rendered = renderers.get("pibox-round-summary")!(entries[0], {}, ctx.ui.theme).render(200).join("\n");
	assert.match(rendered, /↑ 0 · ↓ 2,000 · cache 9% · \$3.00/);
	fire("agent_start");
	const nextTurn = { ...message(), usage: { input: 2, output: 10, cacheRead: 1, cacheWrite: 0, cost: { total: 0 } } };
	fire("message_end", { message: nextTurn });
	assert.match(detail(ctx)!, /cache 33.33%$/);
	fire("agent_end", { messages: [nextTurn] });
	assert.equal(entries[1]!.data.cacheHitPercent, 1 / 3 * 100);
	const nextRendered = renderers.get("pibox-round-summary")!(entries[1], {}, ctx.ui.theme).render(200).join("\n");
	assert.match(nextRendered, /cache 33.33%/);
	fire("agent_start");
	const missing = { ...message(), usage: { input: 0, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } };
	fire("message_end", { message: missing });
	assert.doesNotMatch(detail(ctx)!, /cache/);
	fire("agent_end", { messages: [missing] });
	assert.equal(entries[2]!.data.cacheHitPercent, undefined);
});
