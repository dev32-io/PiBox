import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_PROMPT_SURFACES } from "../prompt-contracts.js";

const root = join(import.meta.dirname, "..", "..", "..");

test("inventories every built-in role and skill prompt", async () => {
	const ids = new Set(BUILT_IN_PROMPT_SURFACES.map((surface) => surface.id));
	assert.equal(ids.size, BUILT_IN_PROMPT_SURFACES.length);
	for (const surface of BUILT_IN_PROMPT_SURFACES) {
		const [path, symbol] = surface.source.split("#");
		assert.ok(path);
		const content = await readFile(join(root, path), "utf8");
		if (symbol) assert.match(content, new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("role prompts use instruction contracts instead of identity preambles", async () => {
	for (const surface of BUILT_IN_PROMPT_SURFACES.filter((entry) => entry.category === "role")) {
		const content = await readFile(join(root, surface.source), "utf8");
		assert.doesNotMatch(content, /\byou are\b/i, surface.id);
		assert.match(content, /^# .+/);
		assert.match(content, /## Completion/);
	}
});

test("discovery preserves product partnership while planning stays executable", async () => {
	const orchestrator = await readFile(join(root, "extensions/workflow/index.ts"), "utf8");
	const discovery = await readFile(join(root, "skills/workflow-discover/SKILL.md"), "utf8");
	const planner = await readFile(join(root, "skills/workflow-plan/SKILL.md"), "utf8");
	const critic = await readFile(join(root, "extensions/workflow/roles/plan-critic.md"), "utf8");
	assert.match(orchestrator, /constructive product and technical partner/i);
	assert.match(orchestrator, /Seek the outcome behind requested solutions/i);
	assert.match(orchestrator, /workflow-discover[\s\S]+workflow-plan[\s\S]+workflow-run/i);
	assert.match(orchestrator, /Keep clear, local, reversible work ad hoc/i);
	assert.match(orchestrator, /List before create and get before patch/i);
	assert.match(orchestrator, /Initial approval is user-only through \/workflow approve/i);
	assert.match(orchestrator, /mixes a concrete change with questions[\s\S]+before any canonical mutation or execution/i);
	assert.match(orchestrator, /problem report[\s\S]+is not by itself permission to start, stop, resume, or amend/i);
	assert.match(orchestrator, /Existing resources are context, not an automatic target/i);
	assert.match(orchestrator, /Preserve dirty or conflicting work/i);
	assert.doesNotMatch(orchestrator, /malformed tool call after 16 KiB|whitespaceToolDeltaBytes/);
	assert.match(discovery, /requested mechanism as a hypothesis/i);
	assert.match(discovery, /proximate cause[\s\S]+upstream enabling condition/i);
	assert.match(discovery, /checkpoint only meaningful changes/i);
	assert.match(discovery, /never write every turn/i);
	assert.match(discovery, /Treat mixed turns as discovery/i);
	assert.match(discovery, /do not stop, start, resume, patch, or add work to an existing workflow/i);
	assert.match(discovery, /first give the user a substantive conversational response/i);
	assert.match(planner, /coherent vertical contributions/i);
	assert.match(planner, /Semantic overlap or related code is evidence, not consent/i);
	assert.match(planner, /concurrency only for independent work/i);
	assert.match(planner, /create the parent once with `workflow_create`/i);
	assert.match(planner, /Initial approval is user-only/i);
	assert.match(critic, /Upstream premises/i);
	assert.match(critic, /Do not reward task count or concurrency/i);
});

test("explorer supports evidence-driven code understanding and diagnosis", async () => {
	const explorer = await readFile(join(root, "extensions/workflow/roles/explorer.md"), "utf8");
	for (const mode of ["lookup", "map", "trace", "impact", "diagnose", "explain"]) assert.ok(explorer.includes(`\`${mode}\``), mode);
	assert.match(explorer, /Separate proximate technical cause from an upstream enabling product/i);
	assert.match(explorer, /do not treat correlation as causation/i);
	assert.match(explorer, /cheapest next probe/i);
});

test("skill descriptions are trigger-only context pointers", async () => {
	for (const surface of BUILT_IN_PROMPT_SURFACES.filter((entry) => entry.category === "skill")) {
		const content = await readFile(join(root, surface.source), "utf8");
		const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		assert.match(description, /^Use when /, surface.id);
		assert.doesNotMatch(description, /\b(first|then|through|by |and then|runs|creates|records)\b/i, surface.id);
	}
});
