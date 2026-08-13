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

test("collaboration phases have focused boundaries and natural handoffs", async () => {
	const orchestrator = await readFile(join(root, "extensions/workflow/index.ts"), "utf8");
	const discussion = await readFile(join(root, "skills/product-discussion/SKILL.md"), "utf8");
	const shaping = await readFile(join(root, "skills/shape-story/SKILL.md"), "utf8");
	const delivery = await readFile(join(root, "skills/plan-delivery/SKILL.md"), "utf8");
	const critic = await readFile(join(root, "extensions/workflow/roles/plan-critic.md"), "utf8");
	assert.match(orchestrator, /constructive product and technical partner/i);
	assert.match(orchestrator, /Seek the outcome behind requested solutions/i);
	assert.match(orchestrator, /product-discussion[\s\S]+shape-story[\s\S]+plan-delivery[\s\S]+workflow-run/i);
	assert.match(orchestrator, /Each active phase owns one deliverable and naturally offers the next phase/i);
	assert.match(orchestrator, /continue from shape-story into plan-delivery without asking them to repeat permission/i);
	assert.match(orchestrator, /Keep clear, local, reversible work ad hoc/i);
	assert.match(orchestrator, /Write plans with workflow_plan_write/i);
	assert.match(orchestrator, /create for a new, fresh, separate, or ignore-previous plan/i);
	assert.match(orchestrator, /update only when the user explicitly asks/i);
	assert.match(orchestrator, /Initial approval is user-only through \/workflow approve/i);
	assert.match(orchestrator, /problem report[\s\S]+is not by itself permission to start, stop, resume, or amend/i);
	assert.match(orchestrator, /A create source is read-only background/i);
	assert.match(orchestrator, /initial write is atomic[\s\S]+use edit rather than resending unchanged plan content/i);
	assert.match(orchestrator, /Use subagent_spawn for dynamic role-and-prompt delegation[\s\S]+Managed workflow tasks and evaluations are scheduled internally/i);
	assert.match(orchestrator, /do not ask the model to launch each planned task separately/i);
	assert.match(orchestrator, /Preserve dirty or conflicting work/i);
	assert.doesNotMatch(orchestrator, /malformed tool call after 16 KiB|whitespaceToolDeltaBytes/);
	assert.match(discussion, /Think with the user in an open room/i);
	assert.match(discussion, /Respond substantively before interviewing them/i);
	assert.match(discussion, /Do not create or modify canonical workflow resources/i);
	assert.match(discussion, /Want me to shape this into a high-level story/i);
	assert.match(shaping, /reviewable high-level story/i);
	assert.match(shaping, /Do not define tasks, stages, model assignments/i);
	assert.match(shaping, /Want me to turn it into an execution-ready delivery plan/i);
	assert.match(shaping, /hand off to `plan-delivery` in the same turn/i);
	assert.match(delivery, /tracer-bullet contributions/i);
	assert.match(delivery, /fit one fresh worker context/i);
	assert.match(delivery, /write the complete draft with `workflow_plan_write`/i);
	assert.match(delivery, /structured task brief and acceptance fields/i);
	assert.match(delivery, /Read the whole written plan back[\s\S]+`view=full`[\s\S]+exact returned revision[\s\S]+self-review/i);
	assert.match(delivery, /Coverage:[\s\S]+Vagueness:[\s\S]+Consistency:/i);
	assert.match(delivery, /one revision-pinned `workflow_plan_write` `edit`[\s\S]+do not resend the unchanged plan[\s\S]+Do not repeat the self-review/i);
	assert.match(delivery, /planning critique is optional[\s\S]+user explicitly requests it/i);
	assert.match(delivery, /spawn `plan-critic` through `subagent_spawn`/i);
	assert.match(delivery, /Tasks in one stage are the parallel frontier/i);
	assert.match(delivery, /runtime—not the planner—executes singleton stages on the feature branch/i);
	assert.match(delivery, /Use `medium\/standard` by default/i);
	assert.match(delivery, /harness selects provider, concrete model, and model-specific effort/i);
	assert.match(delivery, /call `workflow_transition` with `submit`/i);
	assert.match(delivery, /after approval the user can say “start the workflow”/i);
	assert.match(critic, /Upstream premises/i);
	assert.match(critic, /Do not reward task count or concurrency/i);
	assert.match(critic, /Judge the graph without accepting the caller's preferred task count/i);
	assert.match(critic, /Tracer-bullet fit/i);
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
