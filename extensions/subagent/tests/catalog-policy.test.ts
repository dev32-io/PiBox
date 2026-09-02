import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadSubagentCatalog, DEFAULT_SUBAGENT_CATALOG_CONFIG } from "../catalog.js";
import { activeModelTierLists } from "../../model-tier-list-profiles/profiles.js";
import { mcpLaunchEnvironment, PIBOX_ALLOWED_MCP_SERVERS_ENV } from "../mcp-capabilities.js";
import { resolveSubagentModel } from "../model-resolver.js";
import {
	ALL_TOOLS_SELECTOR,
	DEFAULT_SUBAGENT_TOOLS,
	RECURSIVE_SUBAGENT_CONTROL_EXCLUSIONS,
	resolveSubagentToolSelectors,
} from "../tool-policy.js";

function model(provider: string, id: string, reasoning = false): Model<Api> {
	return { provider, id, reasoning } as unknown as Model<Api>;
}

test("a direct user override may select an unconfigured registered model before same-tier fallbacks", () => {
	const config = structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.medium = ["openai-codex/fallback#off"];
	const result = resolveSubagentModel(config, [model("ollama-cloud", "glm-5.3-flash"), model("openai-codex", "fallback")], {
		tier: "medium",
		override: { model: "ollama-cloud/glm-5.3-flash", effort: "off" },
		allowUnconfiguredOverride: true,
	});
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(`${result.model.provider}/${result.model.id}#${result.effort}`, "ollama-cloud/glm-5.3-flash#off");
		assert.deepEqual(result.candidates, [
			{ provider: "ollama-cloud", model: "glm-5.3-flash", effort: "off" },
			{ provider: "openai-codex", model: "fallback", effort: "off" },
		]);
	}
});

test("an unusable direct user override falls back in same-tier route order", () => {
	const config = structuredClone(DEFAULT_SUBAGENT_CATALOG_CONFIG);
	activeModelTierLists(config.modelTierListProfiles, config.modelTierProfile).tiers.medium = [
		"openai-codex/missing#off",
		"openai-codex/fallback#off",
	];
	const result = resolveSubagentModel(config, [model("ollama-cloud", "glm-5.3-flash"), model("openai-codex", "fallback")], {
		tier: "medium",
		override: { model: "ollama-cloud/glm-5.3-flash", effort: "high" },
		allowUnconfiguredOverride: true,
	});
	assert.equal(result.status, "resolved");
	if (result.status === "resolved") {
		assert.equal(`${result.model.provider}/${result.model.id}#${result.effort}`, "openai-codex/fallback#off");
		assert.equal(result.fallbackUsed, true);
		assert.deepEqual(result.attempts.map((attempt) => attempt.status), ["effort_unsupported", "model_missing", "selected"]);
	}
});

test("loads standalone built-in, harness routing, and trusted project agent policy", () => {
	const root = mkdtempSync(join(tmpdir(), "pibox-subagent-catalog-"));
	const home = join(root, "home");
	try {
		mkdirSync(join(home, ".pi", "agent", "harness"), { recursive: true });
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		writeFileSync(join(home, ".pi", "agent", "harness", "config.yaml"), [
			"schemaVersion: 2",
			"modelTiers:",
			"  medium: [policy/medium#off]",
			"agents:",
			"  explorer:",
			"    tier: high",
			"    tools: [write]",
			"",
		].join("\n"));
		writeFileSync(join(root, ".pi", "harness.yaml"), [
			"schemaVersion: 2",
			"agents:",
			"  explorer:",
			"    model: policy/medium",
			"  custom:",
			"    extends: explorer",
			"    tier: low",
			"",
		].join("\n"));
		writeFileSync(join(root, ".pi", "agents", "trusted.md"), "---\nname: trusted\ndescription: Trusted repository helper\ntools: read, mcp:context7\ntier: high\n---\n\nComplete the assignment.\n");

		const loaded = loadSubagentCatalog(root, { home });
		assert.match(loaded.config.agents.implementer?.prompt ?? "", /agent-definitions\/implementer\.md$/);
		assert.equal(loaded.config.agents.explorer?.tier, "high");
		assert.equal(loaded.config.agents.explorer?.model, "policy/medium");
		assert.equal(loaded.config.agents.custom?.tier, "low");
		assert.deepEqual(loaded.config.agents.explorer?.tools, ["read", "grep", "find", "ls", "bash"], "harness files cannot replace frontmatter tools");
		assert.deepEqual(loaded.config.agents.trusted?.tools, ["read", "mcp:context7"]);
		assert.equal(loaded.sources.length, 4);
		assert.match(loaded.digest, /^sha256:[a-f0-9]{64}$/);

		const resolution = resolveSubagentModel(loaded.config, [model("policy", "medium")], { tier: "medium" });
		assert.equal(resolution.status, "resolved");
		if (resolution.status === "resolved") assert.equal(resolution.route, "policy/medium#off");

		const untrusted = loadSubagentCatalog(root, { home, includeProject: false });
		assert.equal(untrusted.config.agents.custom, undefined);
		assert.equal(untrusted.config.agents.trusted, undefined);
		assert.equal(untrusted.config.agents.explorer?.model, undefined, "project harness policy is not read before trust");
		assert.equal(untrusted.sources.includes(join(root, ".pi", "harness.yaml")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("standalone generic tool policy preserves wildcard, MCP, and recursive-control semantics", () => {
	assert.ok(DEFAULT_SUBAGENT_TOOLS.includes("read"));
	assert.ok(RECURSIVE_SUBAGENT_CONTROL_EXCLUSIONS.includes("subagent_spawn"));
	assert.deepEqual(resolveSubagentToolSelectors([ALL_TOOLS_SELECTOR, "read", "mcp:playwright", "mcp:context7"]), [ALL_TOOLS_SELECTOR, "read", "mcp"]);
	assert.deepEqual(mcpLaunchEnvironment(["read", "mcp:playwright"]), { [PIBOX_ALLOWED_MCP_SERVERS_ENV]: "playwright" });
	assert.deepEqual(mcpLaunchEnvironment([ALL_TOOLS_SELECTOR, "mcp:playwright"]), {});
});
