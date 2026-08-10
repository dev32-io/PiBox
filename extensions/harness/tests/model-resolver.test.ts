import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { DEFAULT_HARNESS_CONFIG } from "../config.js";
import { resolveHarnessModel, supportsEffort } from "../model-resolver.js";

function model(provider: string, id: string, reasoning = true, thinkingLevelMap?: ThinkingLevelMap): Model<Api> {
	return { provider, id, reasoning, thinkingLevelMap } as unknown as Model<Api>;
}

test("resolves the first available capability-ranked candidate", () => {
	const available = [model("openai-codex", "gpt-5.6-terra")];
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, available, {
		candidates: [
			{ model: "sol", effort: "high" },
			{ model: "terra", effort: "high" },
		],
		minimumCapabilityRank: 200,
	});
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.alias, "terra");
		assert.equal(result.fallbackUsed, true);
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["model_missing", "selected"]);
	}
});

test("strict resolution does not silently fall back", () => {
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, [model("openai-codex", "gpt-5.6-terra")], {
		candidates: [
			{ model: "sol", effort: "high" },
			{ model: "terra", effort: "high" },
		],
		strict: true,
	});
	assert.equal(result.status, "waiting_model");
	assert.equal(result.attempts.length, 1);
});

test("rejects unsupported effort without downgrading effort", () => {
	const nonReasoning = model("local", "small", false);
	assert.equal(supportsEffort(nonReasoning, "high"), false);
	assert.equal(supportsEffort(nonReasoning, "off"), true);
	const mapped = model("local", "mapped", true, { high: null });
	assert.equal(supportsEffort(mapped, "high"), false);
});
