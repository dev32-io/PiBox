import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import effort, { configuredLevel, shouldApplyEffortDefault, supportedLevels } from "./index.js";
import type { EffortConfig } from "./config.js";

function model(provider: string, id: string, thinkingLevelMap: Model<any>["thinkingLevelMap"]): Model<any> {
	return { provider, id, reasoning: true, thinkingLevelMap } as Model<any>;
}

const local = model("local-llm", "local-model", { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
const other = model("other", "remote-model", { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const standardOnly = model("other", "standard-only", undefined);
const maxWithoutXhigh = model("other", "max-without-xhigh", { max: "max" });
const config: EffortConfig = { default: "high", models: {} };

test("uses Pi's tristate effort semantics for omitted, null, and mapped levels", () => {
	assert.deepEqual(supportedLevels(local), ["off", "low", "medium", "high", "xhigh"]);
	assert.deepEqual(supportedLevels(standardOnly), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(supportedLevels(maxWithoutXhigh), ["off", "minimal", "low", "medium", "high", "max"]);
});

test("Pi's resolved effort survives when PiBox has no explicit override", async () => {
	assert.equal(configuredLevel({ models: {} }, local), undefined);
	assert.equal(configuredLevel({ models: {} }, other), undefined);

	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const applied: ModelThinkingLevel[] = [];
	const pi = {
		on(name: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(name, handler); },
		registerCommand() {},
		setThinkingLevel(level: ModelThinkingLevel) { applied.push(level); },
	} as unknown as ExtensionAPI;
	effort(pi, () => ({ models: {} }), {});
	await handlers.get("session_start")?.({ reason: "startup" }, { cwd: process.cwd(), model: other } as ExtensionContext);
	assert.deepEqual(applied, [], "the extension must not overwrite Pi's globally resolved effort");
});

test("local and remote models retain explicit PiBox defaults", () => {
	assert.equal(configuredLevel(config, local), "high");
	assert.equal(configuredLevel(config, other), "high");
});

test("managed subagents and restored runtime state preserve their effort", () => {
	assert.equal(shouldApplyEffortDefault({}), true);
	assert.equal(shouldApplyEffortDefault({ PIBOX_SUBAGENT_ID: "agent-1" }), false);
	assert.equal(shouldApplyEffortDefault({}, "reload"), false);
	assert.equal(shouldApplyEffortDefault({}, "restore"), false);
	assert.equal(shouldApplyEffortDefault({}, "startup"), true);
	assert.equal(shouldApplyEffortDefault({}, "set"), true);
});

test("explicit per-model effort overrides the shared default", () => {
	assert.equal(configuredLevel({ ...config, models: { "local-llm/local-model": "medium" } }, local), "medium");
	assert.equal(configuredLevel({ ...config, models: { "local-model": "xhigh" } }, local), "xhigh");
});
