import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("derives built-in agent policy from standard markdown frontmatter", () => {
	assert.match(DEFAULT_HARNESS_CONFIG.agents.implementer?.prompt ?? "", /agent-definitions\/implementer\.md$/);
	assert.equal(DEFAULT_HARNESS_CONFIG.agents.implementer?.description, "General implementation work for managed tasks");
	assert.deepEqual(DEFAULT_HARNESS_CONFIG.agents.implementer?.tools, ["read", "grep", "find", "bash", "edit", "write"]);
	assert.equal(DEFAULT_HARNESS_CONFIG.agents["code-reviewer"]?.tier, "high");
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

test("discovers traditional project agent markdown with optional harness tier routing", () => {
	const root = mkdtempSync(join(tmpdir(), "pibox-agent-definitions-"));
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });
	writeFileSync(join(root, ".pi", "agents", "scout.md"), `---\nname: project-scout\ndescription: Fast project reconnaissance\ntools: read, grep, find\nmodel: local/scout\ntier: low\n---\n\nInvestigate the assigned question.\n`);
	writeFileSync(join(root, ".pi", "agents", "traditional.md"), `---\nname: traditional\ndescription: Conventional Pi agent without harness fields\n---\n\nComplete the assignment.\n`);
	writeFileSync(join(root, ".pi", "agents", "invalid.md"), `---\nname: invalid\ntier: impossible\n---\n\nMissing description.\n`);
	const loaded = loadHarnessConfig(root, { home: join(root, "home") });
	assert.equal(loaded.config.agents["project-scout"]?.tier, "low");
	assert.equal(loaded.config.agents["project-scout"]?.model, "local/scout");
	assert.deepEqual(loaded.config.agents["project-scout"]?.tools, ["read", "grep", "find"]);
	assert.equal(loaded.config.agents.traditional?.tier, "medium");
	assert.equal(loaded.config.agents.traditional?.prompt, join(root, ".pi", "agents", "traditional.md"));
	assert.equal(loaded.config.agents.invalid, undefined);
	assert.equal(loaded.diagnostics.some((diagnostic) => diagnostic.source.endsWith("invalid.md") && diagnostic.level === "warning"), true);
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
