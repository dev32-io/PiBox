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

test("orchestrator and planner act as constructive product partners before canonical planning", async () => {
	const orchestrator = await readFile(join(root, "extensions/harness/index.ts"), "utf8");
	const planner = await readFile(join(root, "skills/harness-plan/SKILL.md"), "utf8");
	const critic = await readFile(join(root, "extensions/harness/roles/plan-critic.md"), "utf8");
	assert.match(orchestrator, /constructive product and technical partner/i);
	assert.match(orchestrator, /Treat product rules, UX\/UI flows, schemas, APIs, and architecture as prior decisions/i);
	assert.match(orchestrator, /Ask one pivotal question alone[\s\S]+numbered frontier[\s\S]+then wait/i);
	assert.match(orchestrator, /Stop when further answers would not change the contract/i);
	assert.match(orchestrator, /Do not mutate canonical planning until shared understanding/i);
	assert.match(orchestrator, /conversational refinement or \/harness approve/i);
	assert.match(orchestrator, /trusted canonical coordinator/i);
	assert.match(orchestrator, /Never create a second work item to repair an existing draft/i);
	assert.match(orchestrator, /create the initial work item with one harness_create call/i);
	assert.match(orchestrator, /never use a batch merely to wrap one creation/i);
	assert.doesNotMatch(orchestrator, /malformed tool call after 16 KiB|whitespaceToolDeltaBytes/);
	assert.match(orchestrator, /Approval is continuity, not a blanket mutation freeze/i);
	assert.match(planner, /requested solution as one hypothesis, not the goal itself/i);
	assert.match(planner, /Proximate technical cause/i);
	assert.match(planner, /Do not manufacture scope/i);
	assert.match(planner, /Parallel execution is an option[\s\S]+never create tasks merely to increase concurrency/i);
	assert.match(planner, /without requiring a special phrase/i);
	assert.match(planner, /audited `retain-approval` disposition/i);
	assert.match(planner, /initial parent work item with a single `harness_create` call/i);
	assert.match(critic, /Upstream premises/i);
	assert.match(critic, /Do not reward task count or concurrency/i);
});

test("explorer supports evidence-driven code understanding and diagnosis", async () => {
	const explorer = await readFile(join(root, "extensions/harness/roles/explorer.md"), "utf8");
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
