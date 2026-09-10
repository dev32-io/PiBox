import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	availableAgentCatalogDescription,
	subagentSpawnToolDescription,
} from "../catalog-description.js";
import { DEFAULT_SUBAGENT_CATALOG_CONFIG, loadSubagentCatalog } from "../catalog.js";

test("describes loaded catalog entries in deterministic name order", () => {
	const catalog = {
		config: {
			modelTierListProfiles: { defaultProfile: "default", profiles: { default: { low: [], medium: [], high: [], max: [], local: [] } } },
			modelTierProfile: "default",
			agents: {
				zeta: { description: "Last agent", tier: "medium" as const },
				alpha: { description: "First agent", tier: "low" as const },
				bare: { tier: "high" as const },
				pinned: { description: "Pinned agent", model: "provider/model" },
				"local-pinned": { model: "local-llm/model#high" },
				"local-with-tier": { tier: "high" as const, model: " local-llm/model " },
			},
		},
		digest: "sha256:test",
		sources: [],
		diagnostics: [],
	};

	const listing = availableAgentCatalogDescription(catalog);
	assert.equal(listing, [
		"Available configured agents:",
		"- alpha [default tier: low]: First agent",
		"- bare [default tier: high]",
		"- local-pinned [default tier: local; configured model takes precedence]",
		"- local-with-tier [default tier: local; configured model takes precedence]",
		"- pinned [default tier: medium; configured model takes precedence]: Pinned agent",
		"- zeta [default tier: medium]: Last agent",
	].join("\n"));
	assert.match(subagentSpawnToolDescription(catalog), /bounded assignment[\s\S]*normally omit tier[\s\S]*- alpha \[default tier: low\]: First agent/);
});

test("spawn guidance defaults to configured tiers and requires justified upward overrides", () => {
	const description = subagentSpawnToolDescription({
		config: {
			modelTierListProfiles: { defaultProfile: "default", profiles: { default: { low: [], medium: [], high: [], max: [], local: [] } } },
			modelTierProfile: "default",
			agents: {},
		},
		digest: "sha256:test",
		sources: [],
		diagnostics: [],
	});
	for (const expected of [
		"Use the configured agent's default tier; normally omit tier",
		"Ordinary implementation, multi-file integration, debugging, and review do not need an upward override",
		"Use a higher tier only for complex architecture/design or unusually demanding reasoning",
		"briefly explain the task-specific need and why the default is insufficient",
		"Failed attempts do not by themselves justify escalation",
		"Max is a very rare exception",
		"explain why High is insufficient and the expected benefit",
		"Nuke profiles upgrade routed models, not task tiers",
		"configured agent model takes precedence",
		"local-llm model requires tier local, so up/down tier overrides do not apply while that model is selected",
		"strict explicit-model, fallback, and local-isolation semantics",
	]) assert.ok(description.includes(expected), `missing guidance: ${expected}`);
	assert.doesNotMatch(description, /smallest sufficient tier|prefer High when unsure|normal ceiling|Low for bounded scans/);
});

test("uses current loaded descriptions and includes trusted project agents", () => {
	const root = mkdtempSync(join(tmpdir(), "pibox-catalog-description-"));
	try {
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.yaml"), "schemaVersion: 2\nagents:\n  explorer:\n    description: Current policy description\n");
		writeFileSync(join(root, ".pi", "agents", "local-helper.md"), "---\nname: local-helper\ndescription: Trusted local custom helper\ntools: [read]\n---\n\nInspect the requested files.\n");

		const loaded = loadSubagentCatalog(root, { home: join(root, "home") });
		const description = availableAgentCatalogDescription(loaded);
		assert.match(description, /^Available configured agents:\n- code-reviewer \[default tier: medium\]:/);
		assert.ok(description.includes(`\n- explorer [default tier: low]: ${DEFAULT_SUBAGENT_CATALOG_CONFIG.agents.explorer!.description}\n`));
		assert.match(description, /\n- local-helper \[default tier: medium\]: Trusted local custom helper\n/);
		assert.doesNotMatch(description, /Current policy description/);

		const untrusted = loadSubagentCatalog(root, { home: join(root, "home"), includeProject: false });
		assert.doesNotMatch(availableAgentCatalogDescription(untrusted), /local-helper/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
