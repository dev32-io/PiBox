import assert from "node:assert/strict";
import test from "node:test";
import {
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	activeModelTierLists,
	loadModelTierListProfiles,
	validateModelTierListProfiles,
} from "../profiles.js";

test("ships performance by default plus a token-conservative medium route", () => {
	assert.equal(DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile, "performance");
	assert.equal(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES).tiers.medium[0], "openai-codex/gpt-5.6-sol#medium");
	assert.equal(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES, "token-conservative").tiers.medium[0], "openai-codex/gpt-5.6-luna#max");
});

test("accepts any number of complete named profiles", () => {
	const base = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	base.profiles.custom = structuredClone(base.profiles.performance!);
	base.profiles.custom.medium = ["example/model#xhigh"];
	const parsed = validateModelTierListProfiles(base);
	assert.deepEqual(Object.keys(parsed.profiles).sort(), ["custom", "performance", "token-conservative"]);
	assert.deepEqual(parsed.profiles.custom?.medium, ["example/model#xhigh"]);
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
	assert.ok(loaded.profiles["token-conservative"]);
});

test("rejects incomplete profiles and non-local routes in local", () => {
	assert.throws(() => validateModelTierListProfiles({ defaultProfile: "custom", profiles: { custom: { medium: ["x/y#high"] } } }), /custom\.low|custom\.max/);
	const invalid = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	invalid.profiles.performance!.local = ["openai/model#high"];
	assert.throws(() => validateModelTierListProfiles(invalid), /local-llm provider/);
});
