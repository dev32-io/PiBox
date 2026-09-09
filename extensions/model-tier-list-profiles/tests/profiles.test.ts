import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	activeModelTierLists,
	loadModelTierListProfiles,
	validateModelTierListProfiles,
} from "../profiles.js";

const BUILT_IN_PERFORMANCE = {
	max: ["openai-codex/gpt-5.6-sol#max", "ollama-cloud/deepseek-v4-pro#max"],
	high: ["openai-codex/gpt-5.6-sol#high", "ollama-cloud/deepseek-v4-pro:0813#high"],
	medium: ["openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-flash#max"],
	low: ["openai-codex/gpt-5.6-luna#high", "ollama-cloud/deepseek-v4-flash#low"],
	local: ["local-llm/meta/muse-glimmer#high"],
};

test("ships opt-in nuke routes while preserving built-in defaults and existing profiles", () => {
	assert.equal(DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile, "performance");
	assert.deepEqual(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES).tiers, BUILT_IN_PERFORMANCE);
	assert.deepEqual(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES, "token-conservative").tiers, {
		...BUILT_IN_PERFORMANCE,
		medium: ["openai-codex/gpt-5.6-luna#max", "ollama-cloud/deepseek-v4-flash#max"],
	});
	assert.deepEqual(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES, "nuke").tiers, {
		max: ["openai-codex/gpt-6-astra#max", "openai-codex/gpt-5.6-sol#max", "ollama-cloud/deepseek-v4-pro#max"],
		high: ["openai-codex/gpt-6-astra#high", "openai-codex/gpt-5.6-sol#high", "ollama-cloud/deepseek-v4-pro:0813#high"],
		medium: ["openai-codex/gpt-6-astra#medium", "openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-flash#max"],
		low: BUILT_IN_PERFORMANCE.low,
		local: BUILT_IN_PERFORMANCE.local,
	});
});

test("accepts any number of complete named profiles", () => {
	const base = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	base.profiles.custom = structuredClone(base.profiles.performance!);
	base.profiles.custom.medium = ["example/model#xhigh"];
	const parsed = validateModelTierListProfiles(base);
	assert.deepEqual(Object.keys(parsed.profiles).sort(), ["custom", "nuke", "performance", "token-conservative"]);
	assert.deepEqual(parsed.profiles.custom?.medium, ["example/model#xhigh"]);
});

test("repository without tier lists inherits built-in nuke routes and local isolation", () => {
	const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const loaded = loadModelTierListProfiles(repositoryRoot, { home: "/missing-home" });
	assert.equal(loaded.defaultProfile, "performance");
	assert.deepEqual(loaded.profiles.nuke, DEFAULT_MODEL_TIER_LIST_PROFILES.profiles.nuke);
	assert.deepEqual(loaded.profiles.nuke?.local, loaded.profiles.performance?.local);
});

test("loads repository profiles and normalizes the former modelTiers field", () => {
	const files: Record<string, string> = {
		"/repo/.pi/harness.yaml": "schemaVersion: 2\nmodelTiers:\n  medium: [legacy/model#high]\n",
		"/repo/.git": "",
	};
	const loaded = loadModelTierListProfiles("/repo", {
		home: "/home",
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? "",
	});
	assert.deepEqual(loaded.profiles.performance?.medium, ["legacy/model#high"]);
	assert.ok(loaded.profiles.nuke);
	assert.ok(loaded.profiles["token-conservative"]);
});

test("rejects incomplete profiles and non-local routes in local", () => {
	assert.throws(() => validateModelTierListProfiles({ defaultProfile: "custom", profiles: { custom: { medium: ["x/y#high"] } } }), /custom\.low|custom\.max/);
	const invalid = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	invalid.profiles.performance!.local = ["openai/model#high"];
	assert.throws(() => validateModelTierListProfiles(invalid), /local-llm provider/);
});
