import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig, mergeConfigValues, validateHarnessConfig } from "../config.js";
import { HarnessError } from "../errors.js";
import { activeModelTierLists } from "../../model-tier-list-profiles/profiles.js";

test("uses performance and token-conservative model tier profiles", () => {
	assert.equal(DEFAULT_HARNESS_CONFIG.limits.repairRounds, 8, "smaller models receive eight bounded review/fix opportunities by default");
	assert.equal(DEFAULT_HARNESS_CONFIG.modelTierProfile, "performance");
	assert.equal(DEFAULT_HARNESS_CONFIG.modelTierListProfiles.profiles.performance?.medium[0], "openai-codex/gpt-5.6-sol#medium");
	assert.equal(DEFAULT_HARNESS_CONFIG.modelTierListProfiles.profiles["token-conservative"]?.medium[0], "openai-codex/gpt-5.6-luna#max");
	assert.deepEqual(activeModelTierLists(DEFAULT_HARNESS_CONFIG.modelTierListProfiles, DEFAULT_HARNESS_CONFIG.modelTierProfile).tiers.local, ["local-llm/meta/muse-glimmer#high"]);
});

test("derives built-in agent policy from standard markdown frontmatter", () => {
	assert.match(DEFAULT_HARNESS_CONFIG.agents.implementer?.prompt ?? "", /agent-definitions\/implementer\.md$/);
	assert.equal(DEFAULT_HARNESS_CONFIG.agents.implementer?.description, "General implementation work for managed tasks");
	assert.deepEqual(DEFAULT_HARNESS_CONFIG.agents.implementer?.tools, ["read", "grep", "find", "bash", "edit", "write", "mcp:context7"]);
	const generalPurpose = DEFAULT_HARNESS_CONFIG.agents["general-purpose"];
	assert.match(generalPurpose?.prompt ?? "", /agent-definitions\/general-purpose\.md$/);
	assert.equal(generalPurpose?.description, "General execution of assignments delegated by the main session");
	assert.deepEqual(generalPurpose?.tools, ["*"]);
	assert.equal(generalPurpose?.canDelegate, false);
	assert.equal(generalPurpose?.tools?.some((tool) => tool.startsWith("subagent_") || tool.startsWith("workflow_")), false);
	assert.equal(DEFAULT_HARNESS_CONFIG.agents.explorer?.tier, "low");
	assert.equal(DEFAULT_HARNESS_CONFIG.agents.investigator?.tier, "medium");
	assert.deepEqual(DEFAULT_HARNESS_CONFIG.agents["e2e-tester"]?.tools, ["read", "grep", "find", "bash", "mcp:playwright"]);
	assert.equal(DEFAULT_HARNESS_CONFIG.agents["e2e-tester"]?.tier, "low");
	assert.equal(DEFAULT_HARNESS_CONFIG.agents["code-reviewer"]?.tier, "medium");
	assert.equal(DEFAULT_HARNESS_CONFIG.agents["repair-implementer"]?.tier, "medium");
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
		"/home/.pi/agent/harness/config.yaml": "schemaVersion: 2\nmodelTiers:\n  medium:\n    - local/bounded#off\nroles:\n  implementer:\n    tier: medium\n    tools: [read]\nlimits:\n  maxConcurrency: 2\n",
		"/repo/.pi/harness.yaml": "schemaVersion: 2\nagents:\n  e2e-tester:\n    tools: [bash]\nlimits:\n  maxConcurrency: 6\n",
	};
	const loaded = loadHarnessConfig("/repo", {
		home: "/home",
		exists: (path) => path in files,
		readFile: (path) => files[path] ?? "",
	});
	assert.equal(loaded.config.limits.maxConcurrency, 6);
	assert.equal(loaded.config.limits.maxActiveSubagentsPerSession, 16);
	assert.equal(loaded.config.limits.maxSubagentDepth, 1);
	assert.equal(loaded.config.limits.repairRounds, 8, "partial repository configuration inherits the review/fix default");
	assert.deepEqual(activeModelTierLists(loaded.config.modelTierListProfiles, loaded.config.modelTierProfile).tiers.medium, ["local/bounded#off"]);
	assert.equal(loaded.config.agents.implementer?.tier, "medium");
	assert.deepEqual(loaded.config.agents.implementer?.tools, DEFAULT_HARNESS_CONFIG.agents.implementer?.tools, "harness policy cannot override frontmatter tools");
	assert.deepEqual(loaded.config.agents["e2e-tester"]?.tools, DEFAULT_HARNESS_CONFIG.agents["e2e-tester"]?.tools, "existing repository tool lists are ignored");
	assert.equal(loaded.sources.length, 3);
	assert.match(loaded.digest, /^sha256:[a-f0-9]{64}$/);
});

test("resolves a requested session tier profile without changing repository defaults", () => {
	const loaded = loadHarnessConfig("/repo", { home: "/home", exists: () => false, modelTierProfile: "token-conservative" });
	assert.equal(loaded.config.modelTierProfile, "token-conservative");
	assert.equal(activeModelTierLists(loaded.config.modelTierListProfiles, loaded.config.modelTierProfile).tiers.medium[0], "openai-codex/gpt-5.6-luna#max");
	assert.equal(loaded.config.modelTierListProfiles.defaultProfile, "performance");
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

test("rejects non-local providers in the isolated local route list", () => {
	const value = structuredClone(DEFAULT_HARNESS_CONFIG) as any;
	value.modelTierListProfiles.profiles.performance.local = ["openrouter/qwen/qwen3.8-27b#high"];
	assert.throws(() => validateHarnessConfig(value), /modelTierListProfiles\.profiles\.performance\.local routes must use the local-llm provider/);
});

test("normalizes legacy route mappings to one model-effort pair", () => {
	const value = structuredClone(DEFAULT_HARNESS_CONFIG) as any;
	value.modelTierListProfiles.profiles.performance.low = [{ provider: "local", model: "small", effort: { standard: "off", deep: "high" } }];
	const normalized = validateHarnessConfig(value);
	assert.deepEqual(activeModelTierLists(normalized.modelTierListProfiles, normalized.modelTierProfile).tiers.low, ["local/small#off"]);
	value.modelTierListProfiles.profiles.performance.low = ["missing-effort"];
	assert.throws(() => validateHarnessConfig(value), /provider\/model#effort/);
});

test("resolves explicit agent inheritance while preserving routing defaults", () => {
	const config = validateHarnessConfig({
		...structuredClone(DEFAULT_HARNESS_CONFIG),
		agents: {
			...structuredClone(DEFAULT_HARNESS_CONFIG.agents),
			custom: { extends: "implementer", tier: "low" },
		},
	});
	assert.equal(config.agents.custom?.workspace, "repository");
	assert.deepEqual(config.agents.custom?.tools, DEFAULT_HARNESS_CONFIG.agents.implementer?.tools);
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
