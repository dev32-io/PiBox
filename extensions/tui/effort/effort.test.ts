import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import { configuredLevel, supportedLevels } from "./index.js";
import type { EffortConfig } from "./config.js";

function model(provider: string, id: string, thinkingLevelMap: Model<any>["thinkingLevelMap"]): Model<any> {
	return { provider, id, reasoning: true, thinkingLevelMap } as Model<any>;
}

const local = model("local-llm", "local-model", { off: "off", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null });
const other = model("other", "remote-model", { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
const config: EffortConfig = { default: "high", models: {} };

test("local-llm exposes exactly off through xhigh, excluding minimal and max", () => {
	assert.deepEqual(supportedLevels(local), ["off", "low", "medium", "high", "xhigh"]);
});

test("local-llm defaults to off while other providers retain configured defaults", () => {
	assert.equal(configuredLevel(config, local), "off");
	assert.equal(configuredLevel(config, other), "high");
});

test("explicit per-model effort overrides local-llm off default", () => {
	assert.equal(configuredLevel({ ...config, models: { "local-llm/local-model": "medium" } }, local), "medium");
	assert.equal(configuredLevel({ ...config, models: { "local-model": "xhigh" } }, local), "xhigh");
});
