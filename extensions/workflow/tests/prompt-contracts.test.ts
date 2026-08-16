import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { BUILT_IN_PROMPT_SURFACES } from "../prompt-contracts.js";

const root = join(import.meta.dirname, "..", "..", "..");

test("inventories every built-in agent definition and skill prompt", async () => {
	const ids = new Set(BUILT_IN_PROMPT_SURFACES.map((surface) => surface.id));
	assert.equal(ids.size, BUILT_IN_PROMPT_SURFACES.length);
	for (const surface of BUILT_IN_PROMPT_SURFACES) {
		const [path, symbol] = surface.source.split("#");
		assert.ok(path);
		const content = await readFile(join(root, path), "utf8");
		if (symbol) assert.match(content, new RegExp(symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	}
});

test("agent definitions stay generic while workflow protocols remain launch-time prompts", async () => {
	for (const surface of BUILT_IN_PROMPT_SURFACES.filter((entry) => entry.category === "agent")) {
		const content = await readFile(join(root, surface.source), "utf8");
		const { frontmatter, body } = parseFrontmatter<{ name?: unknown; description?: unknown; tools?: unknown; tier?: unknown }>(content);
		assert.equal(frontmatter.name, surface.id);
		assert.equal(typeof frontmatter.description, "string");
		assert.ok(Array.isArray(frontmatter.tools));
		assert.match(String(frontmatter.tier), /^(low|medium|high|max)$/);
		assert.doesNotMatch(body, /\byou are\b/i, surface.id);
		assert.doesNotMatch(body, /evaluation_context|evaluation_complete|task_complete|task_clarify|PiBox/i, surface.id);
		assert.match(body, /^# .+/);
		assert.match(body, /## Completion/);
	}
	const task = await readFile(join(root, "prompt/workflow-task-agent.md"), "utf8");
	assert.match(task, /task_complete/);
	assert.match(task, /Read the one relevant canonical resource with `task_clarify`[\s\S]+use `task_request_change`/i);
	assert.match(task, /conflicting clauses[\s\S]+smallest safe contract correction/i);
	assert.match(task, /same logical worker/i);
	const review = await readFile(join(root, "prompt/workflow-review-agent.md"), "utf8");
	assert.match(review, /persistent review context/i);
	assert.match(review, /Do not call `evaluation_context` as a prerequisite/i);
	assert.match(review, /evaluation_complete/);
});

test("collaboration phases have focused boundaries and natural handoffs", async () => {
	const orchestrator = await readFile(join(root, "prompt/orchestrator-routing.md"), "utf8");
	const discussion = await readFile(join(root, "skills/product-discussion/SKILL.md"), "utf8");
	const shaping = await readFile(join(root, "skills/shape-story/SKILL.md"), "utf8");
	const delivery = await readFile(join(root, "skills/plan-delivery/SKILL.md"), "utf8");
	const critic = await readFile(join(root, "agent-definitions/plan-critic.md"), "utf8");
	const run = await readFile(join(root, "skills/workflow-run/SKILL.md"), "utf8");
	assert.match(orchestrator, /constructive product and technical partner/i);
	assert.match(orchestrator, /Seek the outcome behind requested solutions/i);
	assert.match(orchestrator, /product-discussion[\s\S]+shape-story[\s\S]+plan-delivery[\s\S]+workflow-run/i);
	assert.match(orchestrator, /Each active phase owns one deliverable and naturally offers the next phase/i);
	assert.match(orchestrator, /end-to-end planning request[\s\S]+never waives the story review gate/i);
	assert.match(orchestrator, /Keep clear, local, reversible work ad hoc/i);
	assert.match(orchestrator, /Manage durable stories and plans through `resource_list`, `resource_read`, `resource_write`, and `resource_delete`/i);
	assert.match(orchestrator, /Shape-story writes only the work item and high-level artifacts it owns/i);
	assert.match(orchestrator, /Plan-delivery reads those resources and writes self-contained task/i);
	assert.match(orchestrator, /Execution has one user-authority gate: a clear request to start or run the reviewed workflow/i);
	assert.match(orchestrator, /There is no separate approval command or planning-status gate/i);
	assert.match(orchestrator, /problem report[\s\S]+is not by itself permission to start, stop, resume, or amend/i);
	assert.match(orchestrator, /Create with `type`, optional `parent`, and `value`/i);
	assert.match(orchestrator, /update one known resource with `ref` and changed `value`/i);
	assert.match(orchestrator, /Use subagent_spawn for dynamic agent-and-prompt delegation[\s\S]+Managed workflow tasks and evaluations are scheduled internally/i);
	assert.match(orchestrator, /do not ask the model to launch each planned task separately/i);
	assert.match(orchestrator, /Preserve dirty or conflicting work/i);
	assert.doesNotMatch(orchestrator, /malformed tool call after 16 KiB|whitespaceToolDeltaBytes/);
	assert.match(discussion, /Think with the user in an open room/i);
	assert.match(discussion, /Respond substantively before interviewing them/i);
	assert.match(discussion, /Do not create or modify canonical workflow resources/i);
	assert.match(discussion, /offer to shape the domain, behavior, and high-level design/i);
	assert.match(discussion, /do not bundle story shaping and delivery planning into one offer/i);
	assert.match(shaping, /collaborative technical round/i);
	assert.match(shaping, /Sharpen the domain/i);
	assert.match(shaping, /Probe with scenarios/i);
	assert.match(shaping, /Explore approaches/i);
	assert.match(shaping, /Do not define implementation tasks, stages, assignments/i);
	assert.match(shaping, /Prior agreement[\s\S]+does not approve this unseen checkpoint/i);
	assert.match(shaping, /Always wait for the user to review[\s\S]+Never load or invoke `plan-delivery` in the same turn/i);
	assert.match(delivery, /Map the seams first/i);
	assert.match(delivery, /smallest coherent.*independently useful/i);
	assert.match(delivery, /explicit ordered concrete implementation\/test steps/i);
	assert.match(delivery, /interfaces consumed and produced/i);
	assert.match(delivery, /true blockers/i);
	assert.match(delivery, /prefactor-only work.*expand.?migrate.?contract/i);
	assert.match(delivery, /multiple independently reviewable outcomes.*state machines.*separate domains/i);
	assert.match(delivery, /high\/max require a substantive justification/i);
	assert.match(delivery, /Cut tracer bullets/i);
	assert.match(delivery, /Every completed task must leave a runnable, demonstrable behavior/i);
	assert.match(delivery, /greenfield repository[\s\S]+setup with the first user-visible vertical slice/i);
	assert.match(delivery, /one fresh worker/i);
	assert.match(delivery, /Use `resource_write` to create or update tasks and stages/i);
	assert.match(delivery, /complete rendered task contract in persistent context/i);
	assert.match(delivery, /Use `resource_list` to inventory[\s\S]+`resource_read` to inspect each complete task/i);
	assert.match(delivery, /Check coverage, vagueness, consistency/i);
	assert.match(delivery, /runtime also owns final whole-branch journey verification and final branch review/i);
	assert.match(delivery, /Never create an evaluation resource/i);
	assert.match(delivery, /approved E2E matrix is binding verification context/i);
	assert.match(delivery, /Preserve every approved E2E matrix case exactly/i);
	assert.match(delivery, /Correct only the affected resource with `resource_write`/i);
	assert.match(delivery, /Resource Examples/i);
	assert.match(delivery, /task_clarify.*escape hatch/is);
	assert.match(delivery, /planning critique is optional[\s\S]+user explicitly requests it/i);
	assert.match(delivery, /`subagent_spawn` with `plan-critic`/i);
	assert.match(delivery, /Tasks in one stage are the concurrent set/i);
	assert.match(delivery, /runtime derives repository versus worktree isolation/i);
	assert.match(delivery, /`medium` is the hard default/i);
	assert.match(delivery, /Use `medium` by default/i);
	assert.match(delivery, /ordered list of concrete `provider\/model#effort` pairs/i);
	assert.match(delivery, /call `workflow_transition` with `submit`/i);
	assert.match(delivery, /user can say “start the workflow”[\s\S]+sole execution gate/i);
	assert.match(delivery, /no separate approval command is required/i);
	assert.match(run, /clear user request to execute the reviewed workflow is the sole execution gate/i);
	assert.match(run, /call `workflow_start` directly/i);
	assert.match(run, /## Management Protocol/i);
	assert.match(run, /Settled by canonical authority[\s\S]+Genuinely user-owned/i);
	assert.match(run, /one atomic `workflow_apply_change` call/i);
	assert.match(run, /`resume-requesting-agent`[\s\S]+`restart-affected`/i);
	assert.match(run, /include the tool's `response` object with the exact agent\/message IDs/i);
	assert.match(run, /Do not make a separate `subagent_respond` call/i);
	assert.match(run, /call `work_item_complete` with the bare work-item ID/i);
	assert.match(run, /Do not report[\s\S]+pre-gate absence of `outcome\.md` as a deviation/i);
	assert.match(critic, /Upstream premises/i);
	assert.match(critic, /without rewarding task count or concurrency/i);
	assert.match(critic, /Do not accept the caller's preferred task count/i);
	assert.match(critic, /Prefer narrow end-to-end contributions/i);
});

test("general-purpose supports open-ended delegation without recursive spawning", async () => {
	const content = await readFile(join(root, "agent-definitions/general-purpose.md"), "utf8");
	const { frontmatter, body } = parseFrontmatter<{ tools?: unknown }>(content);
	assert.deepEqual(frontmatter.tools, ["read", "grep", "find", "ls", "bash", "edit", "write", "mcp:playwright", "mcp:context7"]);
	assert.match(body, /research, analysis, editing, command execution, and testing directly/i);
	assert.match(body, /Do not delegate or spawn another agent/i);
	assert.match(body, /rather than assuming every delegation requires code changes/i);
});

test("explorer supports evidence-driven code understanding and diagnosis", async () => {
	const explorer = await readFile(join(root, "agent-definitions/explorer.md"), "utf8");
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
