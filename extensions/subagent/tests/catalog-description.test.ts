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
			},
		},
		digest: "sha256:test",
		sources: [],
		diagnostics: [],
	};

	const listing = availableAgentCatalogDescription(catalog);
	assert.equal(listing, "Available configured agents:\n- alpha: First agent\n- bare\n- zeta: Last agent");
	assert.match(subagentSpawnToolDescription(catalog), /bounded assignment[\s\S]*- alpha: First agent/);
});

test("uses current loaded descriptions and includes trusted project agents", () => {
	const root = mkdtempSync(join(tmpdir(), "pibox-catalog-description-"));
	try {
		mkdirSync(join(root, ".pi", "agents"), { recursive: true });
		writeFileSync(join(root, ".pi", "harness.yaml"), "schemaVersion: 2\nagents:\n  explorer:\n    description: Current policy description\n");
		writeFileSync(join(root, ".pi", "agents", "local-helper.md"), "---\nname: local-helper\ndescription: Trusted local custom helper\ntools: [read]\n---\n\nInspect the requested files.\n");

		const loaded = loadSubagentCatalog(root, { home: join(root, "home") });
		const description = availableAgentCatalogDescription(loaded);
		assert.match(description, /^Available configured agents:\n- code-reviewer:/);
		assert.ok(description.includes(`\n- explorer: ${DEFAULT_SUBAGENT_CATALOG_CONFIG.agents.explorer!.description}\n`));
		assert.match(description, /\n- local-helper: Trusted local custom helper\n/);
		assert.doesNotMatch(description, /Current policy description/);

		const untrusted = loadSubagentCatalog(root, { home: join(root, "home"), includeProject: false });
		assert.doesNotMatch(availableAgentCatalogDescription(untrusted), /local-helper/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
