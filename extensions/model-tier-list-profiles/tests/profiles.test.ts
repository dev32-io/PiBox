import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	activeModelTierLists,
	loadModelTierListProfiles,
	validateModelTierListProfiles,
} from "../profiles.js";

const BUILT_IN_CODEX = {
	low: ["openai-codex/gpt-6-luna#xhigh"],
	medium: ["openai-codex/gpt-6.1-sol#high"],
	high: ["openai-codex/gpt-6-astra#low"],
	max: ["openai-codex/gpt-6-astra#medium"],
	local: ["local-llm/qwen-3.8-27b#xhigh"],
};

test("ships only the codex profile as the editable default", () => {
	assert.equal(DEFAULT_MODEL_TIER_LIST_PROFILES.defaultProfile, "codex");
	assert.deepEqual(Object.keys(DEFAULT_MODEL_TIER_LIST_PROFILES.profiles), ["codex"]);
	assert.deepEqual(activeModelTierLists(DEFAULT_MODEL_TIER_LIST_PROFILES).tiers, BUILT_IN_CODEX);
});

test("accepts any number of complete named profiles", () => {
	const base = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	base.profiles.custom = structuredClone(base.profiles.codex!);
	base.profiles.custom.medium = ["example/model#xhigh"];
	const parsed = validateModelTierListProfiles(base);
	assert.deepEqual(Object.keys(parsed.profiles).sort(), ["codex", "custom"]);
	assert.deepEqual(parsed.profiles.custom?.medium, ["example/model#xhigh"]);
});

test("repository without tier lists inherits shipped codex routes and local isolation", () => {
	const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const loaded = loadModelTierListProfiles(repositoryRoot, { home: "/missing-home" });
	assert.equal(loaded.defaultProfile, "codex");
	assert.deepEqual(loaded.profiles.codex, DEFAULT_MODEL_TIER_LIST_PROFILES.profiles.codex);
	assert.deepEqual(loaded.profiles.codex?.local, ["local-llm/qwen-3.8-27b#xhigh"]);
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
	assert.deepEqual(loaded.profiles.codex?.medium, ["legacy/model#high"]);
	assert.deepEqual(Object.keys(loaded.profiles), ["codex"]);
});

test("rejects incomplete profiles and non-local routes in local", () => {
	assert.throws(() => validateModelTierListProfiles({ defaultProfile: "custom", profiles: { custom: { medium: ["x/y#high"] } } }), /custom\.low|custom\.max/);
	const invalid = structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	invalid.profiles.codex!.local = ["openai/model#high"];
	assert.throws(() => validateModelTierListProfiles(invalid), /local-llm provider/);
});
