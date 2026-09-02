import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import spinners from "./index.js";

function harness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const entries: unknown[] = [];
	const pi = {
		on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); },
		registerEntryRenderer() {},
		appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
	} as unknown as ExtensionAPI;
	spinners(pi);
	return { handlers, entries };
}

function tuiContext(tokens: () => number) {
	const working: Array<string | undefined> = [];
	return {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setWorkingIndicator() {},
			setHiddenThinkingLabel() {},
			setWorkingMessage(value?: string) { working.push(value); },
		},
		getContextUsage: () => ({ tokens: tokens(), contextWindow: 100_000, percent: 0 }),
		working,
	};
}

test("headless context events do not inspect or serialize messages", async () => {
	const { handlers } = harness();
	const ctx = {
		mode: "json",
		ui: {},
		getContextUsage() { throw new Error("headless context usage must stay untouched"); },
	};
	const message = { toJSON() { throw new Error("headless message was serialized"); } };

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("agent_start")?.({}, ctx);
	assert.doesNotThrow(() => handlers.get("context")?.({ messages: [message] }, ctx));
	await handlers.get("session_shutdown")?.({}, ctx);
});

test("TUI context metering reuses Pi token usage without serializing messages", async () => {
	const { handlers } = harness();
	let tokens = 100;
	const ctx = tuiContext(() => tokens);
	const message = { toJSON() { throw new Error("TUI message was serialized"); } };

	await handlers.get("session_start")?.({}, ctx);
	await handlers.get("agent_start")?.({}, ctx);
	assert.doesNotThrow(() => handlers.get("context")?.({ messages: [message] }, ctx));
	tokens = 125;
	assert.doesNotThrow(() => handlers.get("context")?.({ messages: [message, message] }, ctx));
	assert.ok(ctx.working.length >= 2);
	await handlers.get("agent_end")?.({ messages: [] }, ctx);
	await handlers.get("session_shutdown")?.({}, ctx);
});
