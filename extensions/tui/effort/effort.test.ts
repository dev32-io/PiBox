import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { configuredLevel, shouldApplyEffortDefault, supportedLevels } from "./index.js";
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

test("local and remote models retain configured defaults", () => {
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
