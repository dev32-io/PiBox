import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { resolveHarnessModel, supportsEffort } from "../model-resolver.js";

function model(provider: string, id: string, reasoning = true, thinkingLevelMap?: ThinkingLevelMap): Model<Api> {
	return { provider, id, reasoning, thinkingLevelMap } as unknown as Model<Api>;
}

test("resolves model-specific effort from the requested tier and deliberation", () => {
	const available = [model("openai-codex", "gpt-5.6-terra")];
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, available, { tier: "high", deliberation: "standard" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "gpt-5.6-terra");
		assert.equal(result.effort, "medium");
		assert.equal(result.fallbackUsed, false);
	}
});

test("falls back visibly only within the same tier and deliberation profile", () => {
	const available = [model("openai-codex", "gpt-5.6-sol")];
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, available, { tier: "high", deliberation: "deep" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "gpt-5.6-sol");
		assert.equal(result.effort, "high");
		assert.equal(result.fallbackUsed, true);
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["model_missing", "selected"]);
	}
});

test("strict concrete override does not silently fall back", () => {
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, [model("openai-codex", "gpt-5.6-terra")], {
		tier: "high",
		deliberation: "standard",
		override: { model: "gpt-5.6-sol", effort: "high" },
		strict: true,
	});
	assert.equal(result.status, "waiting_model");
	assert.equal(result.attempts.length, 1);
});

test("skips routes without the requested deliberation mapping", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	config.modelTiers.low = [
		{ provider: "local", model: "small", effort: { standard: "off" } },
		{ provider: "openai-codex", model: "gpt-5.6-luna", effort: { standard: "low", deep: "medium" } },
	];
	const result = resolveHarnessModel(config, [model("local", "small", false), model("openai-codex", "gpt-5.6-luna")], { tier: "low", deliberation: "deep" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.id, "gpt-5.6-luna");
	assert.equal(result.attempts[0]?.status, "profile_unsupported");
});

test("validates provider-specific thinking support without clamping", () => {
	const nonReasoning = model("local", "small", false);
	assert.equal(supportsEffort(nonReasoning, "high"), false);
	assert.equal(supportsEffort(nonReasoning, "off"), true);
	const mapped = model("local", "mapped", true, { high: null, max: "max" });
	assert.equal(supportsEffort(mapped, "high"), false);
	assert.equal(supportsEffort(mapped, "max"), true);
	assert.equal(supportsEffort(model("local", "plain", true), "max"), false);
});
