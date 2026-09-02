import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { projectWorkflowDashboard, workflowDashboardLines } from "../dashboard.js";
import type { ReviewRuntimeState, StageRuntimeState, StoryRuntimeState } from "../../workflow/story-runtime-store.js";

const skippedReview = (): ReviewRuntimeState => ({ status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] });
const pendingReview = (): ReviewRuntimeState => ({ status: "pending", iteration: 0, repairCount: 0, currentFindings: [] });

function stage(tasks: StageRuntimeState["tasks"], review = skippedReview()): StageRuntimeState {
	return {
		id: "delivery",
		status: "running",
		tasks,
		integration: { status: "pending", repairCount: 0, contributionCommits: [] },
		verification: { status: "pending", repairCount: 0, checks: [] },
		review,
	};
}

function state(stages: StageRuntimeState[]): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId: "dashboard-story",
		status: "running",
		contracts: { story: `sha256:${"a".repeat(64)}`, plan: `sha256:${"b".repeat(64)}`, tasks: {} },
		git: { canonicalBranch: "main", baseCommit: "abc" },
		stages,
		finalReview: pendingReview(),
		e2e: { status: "pending", repairCount: 0, evidenceRefs: [] },
		metrics: {
			workflowMs: 15_000,
			categories: { implementation: 5_000, integration: 2_000, verification: 3_000, review: 4_000, e2e: 1_000 },
			incompleteIntervals: 0,
			incompleteCategories: [],
		},
	};
}

const task = (id: string, status: StageRuntimeState["tasks"][number]["status"]): StageRuntimeState["tasks"][number] => ({
	id,
	status,
	repairCount: 0,
	checks: [],
});

const theme = {
	fg: (_token: string, value: string) => value,
	bg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as ExtensionContext["ui"]["theme"];
const ctx = { ui: { theme } } as unknown as ExtensionContext;

function visible(lines: string[]): string[] {
	return lines.map((line) => line.trimEnd());
}

test("projects sequential and concurrent task activity exactly from ordered stage state", () => {
	const sequential = projectWorkflowDashboard(state([stage([task("first", "implementing"), task("second", "pending")])]), 0);
	assert.deepEqual(sequential.items.slice(0, 3), [
		{ label: "Stage 1 · delivery · 0/2 tasks", status: "active", indent: 0 },
		{ label: "Task · first", status: "active", detail: "implementation", indent: 1 },
		{ label: "Task · second", status: "queued", indent: 1 },
	]);

	const concurrent = projectWorkflowDashboard(state([stage([task("android", "implementing"), task("ios", "checking")])]), 0);
	assert.deepEqual(concurrent.items.slice(1, 3), [
		{ label: "Task · android", status: "active", detail: "implementation", indent: 1 },
		{ label: "Task · ios", status: "active", detail: "checks", indent: 1 },
	]);
});

test("projects stage review fixes and final review/E2E gates without generic workflow steps", () => {
	const review: ReviewRuntimeState = { status: "fixing", iteration: 1, repairCount: 0, currentFindings: [] };
	const runtime = state([stage([task("complete", "completed")], review)]);
	runtime.stages[0]!.integration.status = "completed";
	runtime.stages[0]!.verification.status = "completed";
	runtime.finalReview = { status: "interrupted", interruptedFrom: "reviewing", iteration: 2, repairCount: 1, currentFindings: [] };
	runtime.e2e = { status: "fix_pending", repairCount: 2, evidenceRefs: [] };
	const projection = projectWorkflowDashboard(runtime, 0);

	assert.deepEqual(projection.items.slice(-3), [
		{ label: "Review", status: "active", detail: "fix #1", indent: 1 },
		{ label: "Final review", status: "interrupted", detail: "review #2", indent: 0 },
		{ label: "E2E", status: "queued", detail: "fix #3", indent: 0 },
	]);
	assert.equal(projection.reviewPosition, "Stage 1 · fix #1 · active");
});

test("adds one live wall-clock interval and never multiplies it for concurrent tasks", () => {
	const runtime = state([stage([task("one", "implementing"), task("two", "implementing")])]);
	runtime.metrics.open = { category: "implementation", since: "2026-01-01T00:00:10.000Z" };
	const projection = projectWorkflowDashboard(runtime, Date.parse("2026-01-01T00:00:15.000Z"));

	assert.equal(projection.metrics.workflowMs, 20_000);
	assert.deepEqual(projection.metrics.categories, {
		implementation: 10_000,
		integration: 2_000,
		verification: 3_000,
		review: 4_000,
		e2e: 1_000,
	});
	assert.equal(Object.values(projection.metrics.categories).reduce((sum, value) => sum + value, 0), projection.metrics.workflowMs);
});

test("renders active wide and narrow wall-clock metrics from the open state interval", () => {
	const runtime = state([stage([task("one", "implementing")])]);
	runtime.metrics.open = { category: "verification", since: "2026-01-01T00:00:10.000Z" };
	const now = Date.parse("2026-01-01T00:00:15.000Z");
	const wide = visible(workflowDashboardLines(runtime, ctx, 110, 0, now));
	assert.match(wide[0]!, /Workflow time\s+20s$/);
	assert.match(wide[3]!, /Verification\s+8s$/);
	assert.match(wide[5]!, /E2E\s+1s$/);

	const narrow = visible(workflowDashboardLines(runtime, ctx, 60, 0, now));
	assert.equal(narrow.some((line) => line.includes("│")), false);
	assert.match(narrow[1]!, /^ Time · 20s · Verification 8s/);
});

test("marks incomplete workflow time with plus while preserving known category partition", () => {
	const runtime = state([stage([task("lost", "interrupted")])]);
	runtime.status = "paused";
	runtime.metrics.incompleteIntervals = 1;
	runtime.metrics.incompleteCategories = ["review"];
	const projection = projectWorkflowDashboard(runtime, 0);
	assert.equal(Object.values(projection.metrics.categories).reduce((sum, value) => sum + value, 0), projection.metrics.workflowMs);

	const wide = visible(workflowDashboardLines(runtime, ctx, 110, 0, 0));
	assert.match(wide[0]!, /Workflow time\s+15s\+$/);
	assert.ok(wide.some((line) => /Review\s+4s\+$/.test(line)));
	assert.ok(wide.some((line) => line.includes("‖ Stage 1 · delivery") && line.includes("interrupted")));
	assert.ok(wide.some((line) => line.includes("‖ Task · lost") && line.includes("interrupted")));
});
