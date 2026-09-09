import assert from "node:assert/strict";
import test from "node:test";
import { loadModelTierListProfiles } from "../profiles.js";
import { loadSubagentCatalog } from "../../subagent/catalog.js";
import { loadHarnessConfig } from "../../workflow/config.js";

const completeRepositoryProfile = [
	"      low: [repo/low#off]",
	"      medium: [repo/medium#low]",
	"      high: [repo/high#high]",
	"      max: [repo/max#max]",
	"      local: [local-llm/repo#off]",
].join("\n");

function fixture() {
	const files: Record<string, string> = {
		"/repo/.git": "",
		"/home/.pi/agent/settings.json": JSON.stringify({
			unrelated: true,
			modelTierListProfiles: {
				defaultProfile: "token-conservative",
				profiles: { performance: { high: ["global/high#high"] } },
			},
		}),
		"/home/.pi/agent/harness/config.yaml": "schemaVersion: 2\nmodelTiers:\n  high: [ignored/yaml#off]\nlimits:\n  maxConcurrency: 2\n",
		"/repo/.pi/harness.yaml": [
			"schemaVersion: 2",
			"modelTierListProfiles:",
			"  defaultProfile: performance",
			"  profiles:",
			"    performance:",
			"      high: [repo/high-override#max]",
			"    repository-only:",
			completeRepositoryProfile,
			"",
		].join("\n"),
	};
	return {
		home: "/home",
		exists: (path: string) => path in files,
		readFile: (path: string) => files[path] ?? "",
	};
}

test("profile selector, standalone catalog, and workflow resolve identical global-to-repository tier policy", () => {
	const options = fixture();
	const selector = loadModelTierListProfiles("/repo", options);
	const catalog = loadSubagentCatalog("/repo", options).config;
	const workflow = loadHarnessConfig("/repo", options).config;
	assert.deepEqual(catalog.modelTierListProfiles, selector);
	assert.deepEqual(workflow.modelTierListProfiles, selector);
	assert.equal(selector.defaultProfile, "performance", "repository default wins over the global default");
	assert.deepEqual(selector.profiles.performance?.high, ["repo/high-override#max"], "repository arrays replace global arrays");
	assert.deepEqual(selector.profiles.performance?.medium, ["openai-codex/gpt-5.6-sol#medium", "ollama-cloud/deepseek-v4-flash#max"], "omitted capability keys inherit");
	assert.ok(selector.profiles["repository-only"], "complete repository-only profiles are additive");
});

test("global-only loading excludes all repository policy and explicit session profiles win", () => {
	const options = { ...fixture(), includeProject: false };
	const selector = loadModelTierListProfiles("/repo", options);
	const catalog = loadSubagentCatalog("/repo", { ...options, modelTierProfile: "nuke" }).config;
	const workflow = loadHarnessConfig("/repo", { ...options, modelTierProfile: "nuke" }).config;
	assert.equal(selector.defaultProfile, "token-conservative");
	assert.deepEqual(selector.profiles.performance?.high, ["global/high#high"]);
	assert.equal(selector.profiles["repository-only"], undefined);
	assert.deepEqual(catalog.modelTierListProfiles, selector);
	assert.deepEqual(workflow.modelTierListProfiles, selector);
	assert.equal(catalog.modelTierProfile, "nuke");
	assert.equal(workflow.modelTierProfile, "nuke");
	assert.equal(catalog.agents["repository-only"], undefined);
});

test("all three loaders reject unsupported repository schema and legacy model aliases", () => {
	const invalidRepositories = [
		["schemaVersion 1", "schemaVersion: 1\nmodelTierListProfiles: {}\n"],
		["schemaVersion 3", "schemaVersion: 3\nmodelTierListProfiles: {}\n"],
		["legacy models", "schemaVersion: 2\nmodels: {}\n"],
	] as const;
	for (const [name, repository] of invalidRepositories) {
		const files: Record<string, string> = { "/repo/.git": "", "/repo/.pi/harness.yaml": repository };
		const options = { home: "/home", exists: (path: string) => path in files, readFile: (path: string) => files[path] ?? "" };
		for (const load of [
			() => loadModelTierListProfiles("/repo", options),
			() => loadSubagentCatalog("/repo", options),
			() => loadHarnessConfig("/repo", options),
		]) assert.throws(load, /schemaVersion must be 2|Legacy model aliases are unsupported/, name);
	}
});

test("all three loaders allow a missing repository schema and merge tier overrides", () => {
	const files: Record<string, string> = {
		"/repo/.git": "",
		"/repo/.pi/harness.yaml": "modelTierListProfiles:\n  profiles:\n    performance:\n      high: [repo/no-schema#high]\n",
	};
	const options = { home: "/home", exists: (path: string) => path in files, readFile: (path: string) => files[path] ?? "" };
	const selector = loadModelTierListProfiles("/repo", options);
	const catalog = loadSubagentCatalog("/repo", options).config.modelTierListProfiles;
	const workflow = loadHarnessConfig("/repo", options).config.modelTierListProfiles;
	assert.deepEqual(catalog, selector);
	assert.deepEqual(workflow, selector);
	assert.deepEqual(selector.profiles.performance?.high, ["repo/no-schema#high"]);
});

test("all three loaders ignore an invalid untrusted repository", () => {
	const files: Record<string, string> = {
		"/repo/.git": "",
		"/repo/.pi/harness.yaml": "schemaVersion: 1\nmodels: invalid\n",
	};
	const options = { home: "/home", includeProject: false, exists: (path: string) => path in files, readFile: (path: string) => files[path] ?? "" };
	const selector = loadModelTierListProfiles("/repo", options);
	const catalog = loadSubagentCatalog("/repo", options).config.modelTierListProfiles;
	const workflow = loadHarnessConfig("/repo", options).config.modelTierListProfiles;
	assert.deepEqual(catalog, selector);
	assert.deepEqual(workflow, selector);
});

test("all read-only loaders reject malformed global settings instead of rewriting or falling back", () => {
	const options = {
		home: "/home",
		exists: (path: string) => path === "/home/.pi/agent/settings.json",
		readFile: () => "{ malformed",
	};
	assert.throws(() => loadModelTierListProfiles("/repo", options), /malformed JSON/);
	assert.throws(() => loadSubagentCatalog("/repo", options), /malformed JSON/);
	assert.throws(() => loadHarnessConfig("/repo", options), /malformed JSON/);
});
