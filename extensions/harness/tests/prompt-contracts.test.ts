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
		assert.match(content, /## Inputs/);
		assert.match(content, /## Instructions/);
		assert.match(content, /## Completion/);
	}
});

test("orchestrator and planner require user clarification before canonical planning", async () => {
	const orchestrator = await readFile(join(root, "extensions/harness/index.ts"), "utf8");
	const planner = await readFile(join(root, "skills/harness-plan/SKILL.md"), "utf8");
	const critic = await readFile(join(root, "extensions/harness/roles/plan-critic.md"), "utf8");
	assert.match(orchestrator, /ask one numbered round[\s\S]+then wait/i);
	assert.match(orchestrator, /Do not mutate canonical planning until the user and agent reach shared understanding/i);
	assert.match(orchestrator, /refine the plan conversationally, or approve the frozen revision/i);
	assert.match(orchestrator, /Never require a magic confirmation phrase/i);
	assert.match(planner, /Map unresolved decisions as a dependency tree/i);
	assert.match(planner, /give a recommended answer/i);
	assert.match(planner, /Do not call `work_item_create`[\s\S]+before that confirmation/i);
	assert.match(planner, /without requiring a special phrase/i);
	assert.match(planner, /describe refinements conversationally, or approve/i);
	assert.match(critic, /silently invented product and technical choices as blocking/i);
});

test("skill descriptions are trigger-only context pointers", async () => {
	for (const surface of BUILT_IN_PROMPT_SURFACES.filter((entry) => entry.category === "skill")) {
		const content = await readFile(join(root, surface.source), "utf8");
		const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		assert.match(description, /^Use when /, surface.id);
		assert.doesNotMatch(description, /\b(first|then|through|by |and then|runs|creates|records)\b/i, surface.id);
	}
});
