import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig, mergeConfigValues, validateHarnessConfig } from "../config.js";
import { HarnessError } from "../errors.js";

test("uses cost-aware model-effort pairs for the four capability tiers", () => {
	assert.deepEqual(DEFAULT_HARNESS_CONFIG.modelTiers, {
		max: ["openai-codex/gpt-5.6-sol#high"],
		high: ["openai-codex/gpt-5.6-sol#medium"],
		medium: ["openai-codex/gpt-5.6-luna#max"],
		low: ["openai-codex/gpt-5.6-luna#medium"],
	});
});

test("merges maps recursively and replaces arrays", () => {
	assert.deepEqual(
		mergeConfigValues(
			{ nested: { keep: true, list: [1, 2] }, scalar: "old" },
			{ nested: { list: [3] }, scalar: "new" },
		),
		{ nested: { keep: true, list: [3] }, scalar: "new" },
	);
});

test("loads user then repository tier configuration and records a stable digest", () => {
	const files: Record<string, string> = {
		"/home/.pi/agent/harness/config.yaml": "schemaVersion: 2\nmodelTiers:\n  medium:\n    - local/bounded#off\nroles:\n  implementer:\n    tier: medium\nlimits:\n  maxConcurrency: 2\n",
		"/repo/.pi/harness.yaml": "schemaVersion: 2\nlimits:\n  maxConcurrency: 6\n",
	};
	const loaded = loadHarnessConfig("/repo", {
		home: "/home",
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? "",
	});
	assert.equal(loaded.config.limits.maxConcurrency, 6);
	assert.equal(loaded.config.limits.maxActiveSubagentsPerSession, 16);
	assert.equal(loaded.config.limits.maxSubagentDepth, 1);
	assert.deepEqual(loaded.config.modelTiers.medium, ["local/bounded#off"]);
	assert.equal(loaded.config.agents.implementer?.tier, "medium");
	assert.equal(loaded.sources.length, 3);
	assert.match(loaded.digest, /^sha256:[a-f0-9]{64}$/);
});

test("normalizes legacy route mappings to one model-effort pair", () => {
	const value = structuredClone(DEFAULT_HARNESS_CONFIG) as any;
	value.modelTiers.low = [{ provider: "local", model: "small", effort: { standard: "off", deep: "high" } }];
	assert.deepEqual(validateHarnessConfig(value).modelTiers.low, ["local/small#off"]);
	value.modelTiers.low = ["missing-effort"];
	assert.throws(() => validateHarnessConfig(value), /provider\/model#effort/);
});

test("resolves explicit agent inheritance while preserving routing defaults", () => {
	const config = validateHarnessConfig({
		...structuredClone(DEFAULT_HARNESS_CONFIG),
		agents: {
			...structuredClone(DEFAULT_HARNESS_CONFIG.agents),
			custom: { extends: "implementer", tools: ["read"], tier: "low" },
		},
	});
	assert.equal(config.agents.custom?.workspace, "repository");
	assert.deepEqual(config.agents.custom?.tools, ["read"]);
	assert.equal(config.agents.custom?.tier, "low");
	assert.equal(config.agents["plan-critic"]?.tier, "medium");
	assert.ok(config.agents.implementer?.tools?.includes("edit"));
});

test("fails closed on legacy aliases and unknown top-level configuration", () => {
	assert.throws(
		() => validateHarnessConfig({ ...structuredClone(DEFAULT_HARNESS_CONFIG), unsafeOverride: true }),
		(error: unknown) => error instanceof HarnessError && error.code === "CONFIG_INVALID",
	);
	assert.throws(
		() => loadHarnessConfig("/repo", { home: "/home", exists: () => true, readFile: () => "schemaVersion: 1\nmodels: {}\n" }),
		(error: unknown) => error instanceof HarnessError && error.code === "CONFIG_INVALID" && /migrate/i.test(error.message),
	);
});
