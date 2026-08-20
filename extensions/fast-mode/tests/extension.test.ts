import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { initTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import fastMode, { applyFastModeSetting, restoreFastModePolicy } from "../index.js";
import { FAST_MODE_CHILD_ENV, FAST_MODE_ENTRY_TYPE, FAST_MODE_STATUS_KEY, parseFastModeStatus } from "../policy.js";
import { resetActiveFastModePolicy } from "../runtime.js";

initTheme("dark", false);

const eligibleModel = { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-luna" } as Model<any>;

function context(entries: unknown[] = [], model: Model<any> = eligibleModel): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		model,
		sessionManager: { getBranch: () => entries },
		ui: { setStatus() {} },
	} as unknown as ExtensionContext;
}

test("restores the last valid branch entry and isolates explicit child launch state", () => {
	const entries = [
		{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { main: true, subagents: "low" } },
		{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { main: "invalid", subagents: "max" } },
		{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { main: false, subagents: "high" } },
	];
	assert.deepEqual(restoreFastModePolicy(context(entries)), { main: false, subagents: "high" });
	assert.deepEqual(restoreFastModePolicy(context(entries), { PIBOX_SUBAGENT_ID: "agent-1", [FAST_MODE_CHILD_ENV]: "1" }), { main: true, subagents: "off" });
	assert.deepEqual(restoreFastModePolicy(context(entries), { PIBOX_SUBAGENT_ID: "agent-1", [FAST_MODE_CHILD_ENV]: "0" }), { main: false, subagents: "off" });
	assert.deepEqual(restoreFastModePolicy(context(entries), { [FAST_MODE_CHILD_ENV]: "1" }), { main: true, subagents: "off" });
	assert.deepEqual(restoreFastModePolicy(context([])), { main: false, subagents: "off" });
});

test("maps the two menu settings without manufacturing combinations", () => {
	const initial = { main: false, subagents: "off" } as const;
	assert.deepEqual(applyFastModeSetting(initial, "main", "On"), { main: true, subagents: "off" });
	assert.deepEqual(applyFastModeSetting(initial, "subagents", "Up to Medium"), { main: false, subagents: "medium" });
	assert.deepEqual(applyFastModeSetting(initial, "subagents", "All tiers"), { main: false, subagents: "max" });
	assert.equal(applyFastModeSetting(initial, "subagents", "Local"), undefined);
});

test("registers session restoration, request rewriting, status, and cleanup", async (t) => {
	t.after(resetActiveFastModePolicy);
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) { commands.set(name, command); },
		appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
	} as unknown as ExtensionAPI;
	fastMode(pi);
	assert.ok(commands.has("fast"));

	const statuses = new Map<string, string | undefined>();
	const entries = [{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { main: true, subagents: "medium" } }];
	const ctx = {
		...context(entries),
		ui: { setStatus: (key: string, value: string | undefined) => statuses.set(key, value) },
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.[0]?.({ reason: "reload" }, ctx);
	assert.deepEqual(parseFastModeStatus(statuses.get(FAST_MODE_STATUS_KEY)), { mainAvailable: true, mainEnabled: true, subagents: "medium" });

	const payload = { model: eligibleModel.id, input: "hello" };
	assert.deepEqual(await handlers.get("before_provider_request")?.[0]?.({ payload }, ctx), { ...payload, service_tier: "priority" });
	assert.deepEqual(payload, { model: eligibleModel.id, input: "hello" });

	const treeCtx = {
		...context([{ type: "custom", customType: FAST_MODE_ENTRY_TYPE, data: { main: false, subagents: "high" } }]),
		ui: ctx.ui,
	} as unknown as ExtensionContext;
	await handlers.get("session_tree")?.[0]?.({}, treeCtx);
	assert.deepEqual(parseFastModeStatus(statuses.get(FAST_MODE_STATUS_KEY)), { mainAvailable: true, mainEnabled: false, subagents: "high" });

	await handlers.get("session_shutdown")?.[0]?.({ reason: "resume" }, treeCtx);
	assert.equal(statuses.get(FAST_MODE_STATUS_KEY), undefined);
	const replacementCtx = { ...context([]), ui: ctx.ui } as unknown as ExtensionContext;
	await handlers.get("session_start")?.[0]?.({ reason: "resume" }, replacementCtx);
	assert.deepEqual(parseFastModeStatus(statuses.get(FAST_MODE_STATUS_KEY)), { mainAvailable: true, mainEnabled: false, subagents: "off" }, "replacement session does not inherit prior in-memory policy");
	await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, replacementCtx);
	assert.deepEqual(appended, []);
});

test("renders the in-place /fast settings menu and persists each complete change", async () => {
	let command: { handler: (args: string, ctx: any) => Promise<void> } | undefined;
	const appended: unknown[] = [];
	const pi = {
		on() {},
		registerCommand(_name: string, value: typeof command) { command = value; },
		appendEntry(_type: string, data: unknown) { appended.push(data); },
	} as unknown as ExtensionAPI;
	fastMode(pi);
	let rendered: string[] = [];
	let component: { render(width: number): string[]; handleInput?(data: string): void } | undefined;
	const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value } as unknown as Theme;
	await command?.handler("", {
		mode: "tui",
		ui: {
			notify() {},
			custom: async (factory: any) => {
				component = factory({ requestRender() {} }, theme, {}, () => undefined);
				rendered = component!.render(80);
			},
		},
	});
	const text = rendered.join("\n");
	assert.match(text, /Fast mode/);
	assert.match(text, /Main session/);
	assert.match(text, /Subagents/);
	assert.match(text, /additional ChatGPT credits/);
	component?.handleInput?.("\r");
	component?.handleInput?.("\x1b[B");
	component?.handleInput?.("\r");
	assert.deepEqual(appended, [
		{ main: true, subagents: "off" },
		{ main: true, subagents: "low" },
	]);
});
