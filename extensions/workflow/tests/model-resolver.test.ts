import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig } from "../config.js";
import { normalizeExplicitModelOverride, resolveHarnessModel, supportsEffort } from "../model-resolver.js";
import { activeModelTierLists } from "../../model-tier-list-profiles/profiles.js";

function model(provider: string, id: string, reasoning = true, thinkingLevelMap?: ThinkingLevelMap): Model<Api> {
	return { provider, id, reasoning, thinkingLevelMap } as unknown as Model<Api>;
}

test("keeps omitted dynamic routing on medium when a repository config also defines local", () => {
	const files: Record<string, string> = {
		"/repo/.pi/harness.yaml": "schemaVersion: 2\nmodelTiers:\n  local:\n    - local-llm/qwen3.8-27b-uncensored#medium\n",
	};
	const loaded = loadHarnessConfig("/repo", {
		home: "/home",
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? "",
	});
	assert.deepEqual(activeModelTierLists(loaded.config.modelTierListProfiles, loaded.config.modelTierProfile).tiers.local, ["local-llm/qwen3.8-27b-uncensored#medium"]);
	const result = resolveHarnessModel(loaded.config, [model("openai-codex", "gpt-5.6-sol", true, { medium: "medium" })], { tier: "medium" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(`${result.model.provider}/${result.model.id}#${result.effort}`, "openai-codex/gpt-5.6-sol#medium");
});

test("resolves the configured model and effort pair from one tier", () => {
	const available = [model("openai-codex", "gpt-5.6-sol")];
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, available, { tier: "high" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "gpt-5.6-sol");
		assert.equal(result.effort, "high");
		assert.equal(result.fallbackUsed, false);
	}
});

test("falls back visibly within the ordered model-effort list", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.high = ["openai-codex/gpt-5.6-luna#max", "openai-codex/gpt-5.6-sol#medium"];
	const result = resolveHarnessModel(config, [model("openai-codex", "gpt-5.6-sol")], { tier: "high" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.id, "gpt-5.6-sol");
		assert.equal(result.effort, "medium");
		assert.equal(result.fallbackUsed, true);
		assert.deepEqual(result.candidates, [{ provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" }]);
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["model_missing", "selected"]);
	}
});

test("normalizes compact model effort preferences", () => {
	assert.deepEqual(normalizeExplicitModelOverride("deepseek-v4-pro#high"), { model: "deepseek-v4-pro", effort: "high" });
	assert.deepEqual(normalizeExplicitModelOverride("ollama-cloud/deepseek-v4-pro#max", "low"), { model: "ollama-cloud/deepseek-v4-pro", effort: "low" });
	assert.throws(() => normalizeExplicitModelOverride("deepseek-v4-pro#turbo"), /Unsupported model effort suffix/);
});

test("preferred model is promoted ahead of the selected tier fallback list", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.high = ["openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-pro#high"];
	const preference = normalizeExplicitModelOverride("deepseek-v4-pro#high");
	const result = resolveHarnessModel(config, [model("openai-codex", "gpt-5.6-sol"), model("ollama-cloud", "deepseek-v4-pro")], {
		tier: "high",
		override: preference,
	});
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(`${result.model.provider}/${result.model.id}#${result.effort}`, "ollama-cloud/deepseek-v4-pro#high");
		assert.deepEqual(result.candidates, [
			{ provider: "ollama-cloud", model: "deepseek-v4-pro", effort: "high" },
			{ provider: "openai-codex", model: "gpt-5.6-sol", effort: "medium" },
		]);
	}
});

test("local routing cannot match or fall back to an identically named paid model", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	const tiers = activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers;
	tiers.local = ["local-llm/qwen/qwen3.8-27b#high"];
	tiers.high = ["openrouter/qwen/qwen3.8-27b#high"];
	const result = resolveHarnessModel(config, [
		model("openrouter", "qwen/qwen3.8-27b"),
		model("local-llm", "qwen/qwen3.8-27b"),
	], { tier: "local", override: { model: "qwen/qwen3.8-27b" } });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(result.model.provider, "local-llm");
		assert.deepEqual(result.candidates, [{ provider: "local-llm", model: "qwen/qwen3.8-27b", effort: "high" }]);
	}
});

test("an unknown explicit local model fails closed instead of using a configured fallback", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.local = ["local-llm/meta/muse-glimmer#high"];
	const result = resolveHarnessModel(config, [
		model("local-llm", "meta/muse-glimmer"),
		model("openai-codex", "gpt-5.6-luna"),
	], { tier: "local", override: { model: "local-llm/qwen3.8-27b-uncensored", effort: "medium" } });
	assert.equal(result.status, "waiting_model");
	assert.deepEqual(result.attempts, [{ model: "local-llm/qwen3.8-27b-uncensored", effort: "medium", status: "override_not_configured" }]);
});

test("an unsupported effort for an explicit local model fails without fallback", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.local = ["local-llm/meta/muse-glimmer#high", "local-llm/qwen3.8-27b-uncensored#medium"];
	const result = resolveHarnessModel(config, [
		model("local-llm", "meta/muse-glimmer"),
		model("local-llm", "qwen3.8-27b-uncensored", true, { medium: null, high: "high" }),
	], { tier: "local", override: { model: "local-llm/qwen3.8-27b-uncensored", effort: "medium" } });
	assert.equal(result.status, "waiting_model");
	assert.deepEqual(result.attempts, [{ provider: "local-llm", model: "qwen3.8-27b-uncensored", effort: "medium", status: "effort_unsupported" }]);
});

test("ordinary tiers never promote a matching local route", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.high = ["openrouter/qwen/qwen3.8-27b#high"];
	const result = resolveHarnessModel(config, [model("local-llm", "qwen/qwen3.8-27b")], {
		tier: "high",
		override: { model: "qwen/qwen3.8-27b" },
	});
	assert.equal(result.status, "waiting_model");
	assert.equal(result.attempts.some((attempt) => attempt.provider === "local-llm"), false);
});

test("strict concrete override does not silently fall back", () => {
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, [model("openai-codex", "gpt-5.6-luna", true, { max: "max" })], {
		tier: "high",
		override: { model: "gpt-5.6-sol", effort: "high" },
		strict: true,
	});
	assert.equal(result.status, "waiting_model");
	assert.equal(result.attempts.length, 1);
});

test("strict concrete selection exposes no runtime fallback candidates", () => {
	const result = resolveHarnessModel(DEFAULT_HARNESS_CONFIG, [model("openai-codex", "gpt-5.6-sol")], {
		tier: "high",
		override: { model: "gpt-5.6-sol", effort: "high" },
		strict: true,
	});
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.deepEqual(result.candidates, [{ provider: "openai-codex", model: "gpt-5.6-sol", effort: "high" }]);
});

test("skips a configured pair when its effort is unsupported", () => {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.low = ["local/small#high", "openai-codex/gpt-5.6-luna#medium"];
	const result = resolveHarnessModel(config, [model("local", "small", false), model("openai-codex", "gpt-5.6-luna")], { tier: "low" });
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") assert.equal(result.model.id, "gpt-5.6-luna");
	assert.equal(result.attempts[0]?.status, "effort_unsupported");
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
