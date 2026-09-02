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
	assert.match(task, /complete task description, scope, and delivery/i);
	assert.match(task, /Select `spec` or `design`[\s\S]+case-insensitive literal[\s\S]+bounded line range/i);
	assert.match(task, /does not list or read artifacts[\s\S]+blocks[\s\S]+criteria[\s\S]+reports/i);
	assert.match(task, /harness owns deterministic checks/i);
	assert.doesNotMatch(task, /latest ten entries|Context Source Manifest/i);
	assert.match(task, /Do not seek `events\.jsonl`, historical reports,[\s\S]+legacy handoffs/i);
	assert.match(task, /do not use legacy `task_checkpoint` or `task_complete`/i);
	const repair = await readFile(join(root, "prompt/workflow-repair-agent.md"), "utf8");
	assert.match(repair, /current structured findings or latest failure[\s\S]+exact repository coordinates/i);
	assert.match(repair, /Fix only the supplied findings or failure/i);
	assert.match(repair, /do not consult `events\.jsonl`/i);
	const review = await readFile(join(root, "prompt/workflow-review-agent.md"), "utf8");
	assert.match(review, /exact role and contract boundary/i);
	assert.match(review, /stage review[\s\S]+scoped task contracts[\s\S]+full story specification and design/i);
	assert.match(review, /final review[\s\S]+complete execution `base\.\.head` diff/i);
	assert.match(review, /complete rendered story E2E contract[\s\S]+Preserve every authored `E2E-NNN` case ID/i);
	assert.match(review, /Do not consult `events\.jsonl`/i);
	assert.doesNotMatch(review, /caseResults|approved matrix case|evaluation_context/i);
	const implementer = await readFile(join(root, "agent-definitions/implementer.md"), "utf8");
	assert.match(implementer, /smallest correct change, not merely the shortest diff/i);
	assert.match(implementer, /avoid speculative features, abstractions, compatibility layers, dependencies, and drive-by refactors/i);
	assert.match(implementer, /defensive handling only for a concrete supported failure mode/i);
	const codeReviewer = await readFile(join(root, "agent-definitions/code-reviewer.md"), "utf8");
	assert.match(codeReviewer, /broad in inspection but strict in finding admission/i);
	assert.match(codeReviewer, /Severity means:[\s\S]+Critical[\s\S]+Major[\s\S]+Minor[\s\S]+Advisory/i);
	assert.match(codeReviewer, /An empty finding set is valid/i);
});

test("collaboration phases enforce the simplified story, plan, and run contracts", async () => {
	const orchestrator = await readFile(join(root, "prompt/orchestrator-routing.md"), "utf8");
	const shaping = await readFile(join(root, "skills/shape-story/SKILL.md"), "utf8");
	const delivery = await readFile(join(root, "skills/plan-delivery/SKILL.md"), "utf8");
	const run = await readFile(join(root, "skills/workflow-run/SKILL.md"), "utf8");

	assert.match(orchestrator, /product-discussion[\s\S]+shape-story[\s\S]+plan-delivery[\s\S]+workflow-run/i);
	assert.match(orchestrator, /first persist a story[\s\S]+same turn/i);
	assert.match(orchestrator, /Planning does not authorize execution/i);
	assert.match(orchestrator, /structured Markdown story[\s\S]+per-case E2E matrix/i);
	assert.match(orchestrator, /fields are optional only for ref-addressed surgical updates/i);
	assert.match(orchestrator, /`description`, `scope`, and `delivery`[\s\S]+deterministic `checks`/i);
	assert.match(orchestrator, /no story\/artifact\/block references or narrative taxonomy/i);
	assert.match(orchestrator, /never authors evaluations, reports, handoffs, repair tasks, or retry counts/i);
	assert.match(orchestrator, /start or resume[\s\S]+permission-bypass confirmation/i);
	assert.match(orchestrator, /`state\.yaml`[\s\S]+`ledger\.yaml`[\s\S]+`events\.jsonl`/i);
	assert.match(orchestrator, /Never replay events/i);
	assert.match(orchestrator, /Treat quit as crash/i);

	assert.match(shaping, /`story_write`[\s\S]+Outcome[\s\S]+Scope[\s\S]+Behavior[\s\S]+Acceptance/i);
	assert.match(shaping, /Approach[\s\S]+Boundaries and Flow[\s\S]+Failure and Verification/i);
	assert.match(shaping, /E2E-NNN[\s\S]+Exercise[\s\S]+Oracle[\s\S]+Proof/i);
	assert.match(shaping, /Create a story without `ref`[\s\S]+all seven story sections[\s\S]+Create each case without `ref`/i);
	assert.match(shaping, /renderer owns level-two[\s\S]+level-three/i);
	assert.match(shaping, /near-zero-argument `workflow_compile`[\s\S]+mutates nothing/i);
	assert.match(shaping, /Do not create intent artifacts[\s\S]+criterion IDs/i);
	assert.match(shaping, /Do not define tasks, stages, assignments/i);
	assert.match(shaping, /Always wait for the user to review[\s\S]+Never load or invoke `plan-delivery` in the same turn/i);

	assert.match(delivery, /ordered stage train/i);
	assert.match(delivery, /Every stage declares `mode: sequential` or `mode: concurrent`/i);
	assert.match(delivery, /concurrent stage[\s\S]+per-task worktrees[\s\S]+one barrier/i);
	assert.match(delivery, /sequential stage[\s\S]+isolated stage workspace/i);
	assert.match(delivery, /Markdown-rich `description`, `scope`, and `delivery`[\s\S]+deterministic `checks`/i);
	assert.match(delivery, /without dereferencing story artifacts or narrative block references/i);
	assert.match(delivery, /never evaluations, reports, handoffs, repair tasks, or retry limits/i);
	assert.match(delivery, /`reviewMode`[\s\S]+`reviewFocus`/i);
	assert.match(delivery, /Create a task without `ref`[\s\S]+create a stage with `story`/i);
	assert.match(delivery, /`dependsOn`, `checks`, and stage `tasks` replace their complete arrays/i);
	assert.match(delivery, /High\/max require `tierJustification`/i);
	assert.match(delivery, /`limits\.repairRounds`[\s\S]+sole retry-limit authority/i);
	assert.match(delivery, /`workflow_compile`[\s\S]+without resending authored content/i);
	assert.match(delivery, /Planning and successful compilation[\s\S]+do not authorize execution/i);
	assert.doesNotMatch(delivery, /intentSections|requiredWork|acceptanceSections|maxIterations/i);

	assert.match(run, /clear user request to execute or resume[\s\S]+sole execution gate/i);
	assert.match(run, /explicit confirmation[\s\S]+permission bypass/i);
	assert.match(run, /Cancellation launches nothing[\s\S]+does not mutate execution state/i);
	assert.match(run, /ordered stages[\s\S]+Sequential tasks[\s\S]+concurrent tasks/i);
	assert.match(run, /runtime-generated CI repair[\s\S]+state slots[\s\S]+not authored tasks, evaluations, reports, or handoffs/i);
	assert.match(run, /`task_clarify`[\s\S]+bounded line range[\s\S]+story `spec` or `design`/i);
	assert.match(run, /`state\.yaml` is the sole authority/i);
	assert.match(run, /`ledger\.yaml`[\s\S]+only rolling handoff context/i);
	assert.match(run, /`events\.jsonl`[\s\S]+never replayed/i);
	assert.match(run, /`\/reload` is the only same-activation rebind path/i);
	assert.match(run, /Treat session quit exactly like a process crash/i);
	assert.match(run, /fresh attempts[\s\S]+explicit user request to resume/i);
	assert.match(run, /Never edit authored story, plan, or task resources after runtime state pins their digests/i);
	assert.match(run, /Accepting a critical-risk finding additionally requires explicit user ownership/i);
	assert.match(run, /Do not author a separate evaluation, report, handoff/i);
});

test("general-purpose supports arbitrary main-session assignments without recursive spawning", async () => {
	const content = await readFile(join(root, "agent-definitions/general-purpose.md"), "utf8");
	const { frontmatter, body } = parseFrontmatter<{ description?: unknown; tools?: unknown }>(content);
	assert.deepEqual(frontmatter.tools, ["*"]);
	assert.match(String(frontmatter.description), /assignments delegated by the main session/i);
	assert.match(body, /Use judgment about the methods needed/i);
	assert.match(body, /Do not delegate or spawn another agent/i);
	assert.match(body, /Do not silently turn a focused assignment into a broader project/i);
	assert.doesNotMatch(body, /web_search|fetch_content|playwright|context7|optional `mcp`/i);
});

test("explorer stays lightweight while investigator owns causal diagnosis", async () => {
	const explorerContent = await readFile(join(root, "agent-definitions/explorer.md"), "utf8");
	const explorer = parseFrontmatter<{ tier?: unknown }>(explorerContent);
	assert.equal(explorer.frontmatter.tier, "low");
	assert.match(explorer.body, /Quickly answer one focused repository question/i);
	assert.match(explorer.body, /Do not perform causal diagnosis, broad impact analysis/i);
	assert.match(explorer.body, /smallest next lookup/i);

	const investigatorContent = await readFile(join(root, "agent-definitions/investigator.md"), "utf8");
	const investigator = parseFrontmatter<{ tier?: unknown }>(investigatorContent);
	assert.equal(investigator.frontmatter.tier, "medium");
	assert.match(investigator.body, /competing hypotheses/i);
	assert.match(investigator.body, /Do not treat correlation, timing, or adjacency as causation/i);
	assert.match(investigator.body, /cheapest next probe/i);
});

test("skill descriptions are trigger-only context pointers", async () => {
	for (const surface of BUILT_IN_PROMPT_SURFACES.filter((entry) => entry.category === "skill")) {
		const content = await readFile(join(root, surface.source), "utf8");
		const description = content.match(/^description:\s*(.+)$/m)?.[1] ?? "";
		assert.match(description, /^Use when /, surface.id);
		assert.doesNotMatch(description, /\b(first|then|through|by |and then|runs|creates|records)\b/i, surface.id);
	}
});
