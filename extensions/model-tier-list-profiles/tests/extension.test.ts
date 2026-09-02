import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import modelTierListProfiles, { restoreModelTierProfile } from "../index.js";
import { DEFAULT_MODEL_TIER_LIST_PROFILES } from "../profiles.js";
import {
	MODEL_TIER_PROFILE_ENTRY_TYPE,
	MODEL_TIER_PROFILE_EVENT,
	MODEL_TIER_PROFILE_STATUS_KEY,
	parseModelTierProfileStatus,
} from "../policy.js";

function context(entries: unknown[] = []): ExtensionContext {
	return {
		cwd: "/repo",
		mode: "tui",
		hasUI: true,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => entries },
		ui: { setStatus() {}, notify() {}, select: async () => undefined },
	} as unknown as ExtensionContext;
}

test("restores the latest valid session profile before configured defaults", () => {
	const entries = [
		{ type: "custom", customType: MODEL_TIER_PROFILE_ENTRY_TYPE, data: { profile: "performance" } },
		{ type: "custom", customType: MODEL_TIER_PROFILE_ENTRY_TYPE, data: { profile: "missing" } },
		{ type: "custom", customType: MODEL_TIER_PROFILE_ENTRY_TYPE, data: { profile: "token-conservative" } },
	];
	assert.equal(restoreModelTierProfile(context(entries), DEFAULT_MODEL_TIER_LIST_PROFILES, "performance"), "token-conservative");
	assert.equal(restoreModelTierProfile(context([]), DEFAULT_MODEL_TIER_LIST_PROFILES, "token-conservative"), "token-conservative");
});

test("registers /tier-profile, emits session policy, persists switches, and updates footer status", async () => {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	let command: { handler: (args: string, ctx: ExtensionContext) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown } | undefined;
	const emitted: Array<{ name: string; value: unknown }> = [];
	const appended: Array<{ type: string; data: unknown }> = [];
	const pi = {
		events: { emit(name: string, value: unknown) { emitted.push({ name, value }); } },
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand(_name: string, value: typeof command) { command = value; },
		appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
	} as unknown as ExtensionAPI;
	modelTierListProfiles(pi, () => structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES), () => "performance");
	assert.ok(command);

	const statuses = new Map<string, string | undefined>();
	const notices: string[] = [];
	const ctx = {
		...context([]),
		ui: {
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			notify: (message: string) => notices.push(message),
			select: async () => undefined,
		},
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
	assert.deepEqual(emitted.at(-1), { name: MODEL_TIER_PROFILE_EVENT, value: { profile: "performance" } });
	assert.deepEqual(parseModelTierProfileStatus(statuses.get(MODEL_TIER_PROFILE_STATUS_KEY)), { profile: "performance" });

	await command!.handler("token-conservative", ctx);
	assert.deepEqual(appended, [{ type: MODEL_TIER_PROFILE_ENTRY_TYPE, data: { profile: "token-conservative" } }]);
	assert.deepEqual(emitted.at(-1), { name: MODEL_TIER_PROFILE_EVENT, value: { profile: "token-conservative" } });
	assert.deepEqual(parseModelTierProfileStatus(statuses.get(MODEL_TIER_PROFILE_STATUS_KEY)), { profile: "token-conservative" });
	assert.match(notices.at(-1) ?? "", /token-conservative/);

	await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	assert.equal(statuses.get(MODEL_TIER_PROFILE_STATUS_KEY), undefined);
});
