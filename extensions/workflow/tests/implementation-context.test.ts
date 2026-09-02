import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { buildRoleAttemptContext, buildRolePersistentContext, buildTaskPersistentContext } from "../implementation-context.js";
import { readTaskClarification, registerWorkerCapabilities } from "../worker-capabilities.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../types.js";
import { WorkItemStore } from "../work-items.js";

const exec = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<void> { await exec("git", args, { cwd: root }); }
async function fixture(t: test.TestContext, storyOverrides: Partial<StoryDocument> = {}) {
	const root = await mkdtemp(join(tmpdir(), "pibox-context-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await git(root, "init", "--quiet");
	await git(root, "config", "user.name", "Context Test");
	await git(root, "config", "user.email", "context@example.test");
	await writeFile(join(root, "README.md"), "fixture\n");
	await git(root, "add", ".");
	await git(root, "commit", "--quiet", "-m", "initial");
	await git(root, "branch", "-M", "develop");
	const story: StoryDocument = {
		schemaVersion: 1, id: "context-story", title: "Context story", kind: "story",
		spec: "# Spec\n\n  Keep exact indentation.\n\nEnd.",
		design: "# Design\n\nUse `native` boundaries.\n",
		e2e: "# Journey\n\nOpen the app and observe the result.\nNo invented cases.",
		...storyOverrides,
	};
	const task: AuthoredTaskDocument = {
		schemaVersion: 1, id: "exact-task", title: "Exact task", dependsOn: [],
		description: "Line one.\n\n  Description bytes stay exact.",
		scope: "Only this slice.\nDo not touch runtime wiring.",
		delivery: "Return code and focused evidence.\n",
		checks: ["npm run check", { id: "focused", command: "node --test focused" }],
		assignment: { agent: "implementer", tier: "medium", rationale: "Bounded work." },
	};
	const plan: StoryPlanDocument = { schemaVersion: 1, stages: [{ id: "delivery", tasks: [task.id], mode: "sequential", checks: ["npm run check"], review: { mode: "required", focus: "Inspect exact context boundaries." } }] };
	const store = new WorkItemStore(root);
	await store.writeStoryDocument({ story });
	await store.writeAuthoredPlan({ story, plan, tasks: [task] });
	return { store, story, task, stage: plan.stages[0]! };
}

test("implementation context preserves complete binding fields, excludes checks, and is stable", async (t) => {
	const { store, task } = await fixture(t);
	const first = await buildTaskPersistentContext(store, "context-story", task);
	const retry = await buildTaskPersistentContext(store, "context-story", task);
	assert.equal(first, retry);
	for (const field of [task.description, task.scope, task.delivery]) assert.equal(first.includes(field), true, field);
	assert.doesNotMatch(first, /npm run check|node --test focused|Context Source Manifest|artifact|criterion|report/i);
	await assert.rejects(buildTaskPersistentContext(store, "context-story", task, { maxBytes: 64 }), /binding content was not truncated/);
});

test("role contexts separate stable contracts from exact dynamic coordinates and current findings", async (t) => {
	const { story, task, stage } = await fixture(t);
	const review = buildRolePersistentContext({ role: "stage-reviewer", story, tasks: [task], stage });
	assert.match(review, /Story Specification[\s\S]+Story Design[\s\S]+Scoped Task Contracts[\s\S]+Harness-Owned Checks[\s\S]+Inspect exact context boundaries/);
	assert.doesNotMatch(review, /base-a|head-b|events\.jsonl/);
	const fixer = buildRolePersistentContext({ role: "stage-fixer", story, tasks: [task], stage });
	assert.doesNotMatch(fixer, /F-1|broken behavior|Harness-Owned Checks|npm run check|Inspect exact context boundaries/);
	const e2e = buildRolePersistentContext({ role: "e2e", story });
	assert.equal(e2e.includes(story.e2e), true);
	assert.doesNotMatch(e2e, /^## Story (Specification|Design)|^## (Cases|Criteria|Matrix)/m);
	const dynamic = buildRoleAttemptContext({
		baseCommit: "base-a", headCommit: "head-b", branch: "feature/context", worktree: "/safe/worktree",
		findings: [{ id: "F-1", severity: "major", code: "regression", summary: "broken behavior", path: "src/file.ts", line: 7 }],
		ledger: [{ id: "L-1", updatedAt: "2026-01-01T00:00:00Z", sourceRole: "reviewer", summary: "Preserve a non-obvious invariant." }],
	});
	assert.match(dynamic, /base-a\.\.head-b[\s\S]+F-1[\s\S]+broken behavior[\s\S]+Preserve a non-obvious invariant/);
	assert.doesNotMatch(dynamic, /story specification|historical report|events\.jsonl/i);
});

test("task clarification provides bounded story ranges and literal search", async (t) => {
	const definitions = new Map<string, any>();
	registerWorkerCapabilities({ registerTool(definition: any) { definitions.set(definition.name, definition); } } as ExtensionAPI);
	const schema = definitions.get("task_clarify").parameters;
	assert.equal(Check(schema, { section: "spec" }), true);
	assert.equal(Check(schema, { section: "design", startLine: 2, lineCount: 2 }), true);
	assert.equal(Check(schema, { section: "spec", findText: "indentation", contextLines: 1, maxMatches: 2 }), true);
	assert.equal(Check(schema, { section: "spec", findText: "indentation", startLine: 1 }), false);
	assert.equal(Check(schema, { section: "spec", lineCount: 201 }), false);
	assert.equal(Check(schema, { section: "criteria" }), false);
	assert.equal(Check(schema, { action: "read", ref: "artifact:spec" }), false);

	const { store, story } = await fixture(t);
	const firstPage = await readTaskClarification(store, story.id, { section: "spec" });
	assert.match(firstPage, /section: spec[\s\S]+lines: 1-5 of 5[\s\S]+# Spec[\s\S]+Keep exact indentation/);
	const range = await readTaskClarification(store, story.id, { section: "design", startLine: 3, lineCount: 1 });
	assert.match(range, /lines: 3-3 of 4[\s\S]+Use `native` boundaries\./);
	assert.doesNotMatch(range, /# Design/);
	const matches = await readTaskClarification(store, story.id, { section: "spec", findText: "INDENTATION", contextLines: 0 });
	assert.match(matches, /matchingLines: 1[\s\S]+\[lines 3-3\][\s\S]+Keep exact indentation/);
	const absent = await readTaskClarification(store, story.id, { section: "design", findText: "missing" });
	assert.match(absent, /matchingLines: 0[\s\S]+No matching lines/);
	await assert.rejects(readTaskClarification(store, story.id, { section: "criteria" as never }), /only the story spec or design field/);
});

test("task clarification output remains hard byte- and match-bounded", async (t) => {
	const spec = Array.from({ length: 300 }, (_, index) => `needle line ${index} ${"x".repeat(200)}`).join("\n");
	const { store, story } = await fixture(t, { spec });
	const page = await readTaskClarification(store, story.id, { section: "spec", startLine: 1, lineCount: 200 });
	assert.ok(Buffer.byteLength(page, "utf8") <= 16 * 1024);
	assert.match(page, /output truncated at the 16 KiB task clarification limit/);
	const matches = await readTaskClarification(store, story.id, { section: "spec", findText: "needle", contextLines: 0 });
	assert.match(matches, /matchingLines: 300[\s\S]+shownMatches: 8[\s\S]+moreMatches: true/);
	assert.match(matches, /\[lines 1-8\]/, "adjacent match passages should merge without duplicate context");
});
