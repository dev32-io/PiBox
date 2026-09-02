import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SubagentUiWorkflowProjection } from "../../subagent/ui-projection.js";
import type { ReviewRuntimeState, StageRuntimeState, StoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { WorkflowSnapshot } from "../api.js";
import { projectWorkflowDashboard, workflowDashboardLines, workflowDashboardNeedsAnimation } from "../dashboard.js";

const skippedReview = (): ReviewRuntimeState => ({ status: "skipped", iteration: 0, repairCount: 0, currentFindings: [] });
const pendingReview = (): ReviewRuntimeState => ({ status: "pending", iteration: 0, repairCount: 0, currentFindings: [] });
const task = (id: string, status: StageRuntimeState["tasks"][number]["status"]): StageRuntimeState["tasks"][number] => ({ id, status, repairCount: 0, checks: [] });

function stage(id: string, status: StageRuntimeState["status"], tasks: StageRuntimeState["tasks"], review = skippedReview()): StageRuntimeState {
	return {
		id,
		status,
		tasks,
		integration: { status: status === "completed" ? "completed" : "pending", repairCount: 0, contributionCommits: [] },
		verification: { status: status === "completed" ? "completed" : "pending", repairCount: 0, checks: [] },
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

function snapshot(runtime: StoryRuntimeState, modes: Array<"sequential" | "concurrent"> = runtime.stages.map(() => "sequential")): WorkflowSnapshot {
	return {
		ref: `work-item:${runtime.storyId}`,
		title: "Dashboard story",
		status: runtime.status === "completed" ? "done" : runtime.status === "paused" ? "paused" : "running",
		runtime,
		stageTopology: runtime.stages.map((value, index) => ({ id: value.id, mode: modes[index] ?? "sequential" })),
	};
}

const theme = {
	fg: (_token: string, value: string) => value,
	bg: (_token: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as ExtensionContext["ui"]["theme"];
const ctx = { ui: { theme } } as unknown as ExtensionContext;
const visible = (lines: string[]): string[] => lines.map((line) => line.trimEnd());

test("compacts every stage header and expands only the active stage with authored mode icons", () => {
	const completed = stage("foundation", "completed", [task("base", "completed")]);
	const active = stage("platforms", "running", [task("android", "implementing"), task("ios", "pending")]);
	const queued = stage("release", "pending", [task("ship", "pending")]);
	const projection = projectWorkflowDashboard(snapshot(state([completed, active, queued]), ["sequential", "concurrent", "sequential"]), 0);

	assert.deepEqual(projection.items.map(({ label }) => label), [
		"→ Stage 1 · foundation · Completed · 1/1 tasks",
		"⇉ Stage 2 · platforms · Implementing · 0/2 tasks",
		"Implementing · android",
		"Queued · ios",
		"→ Stage 3 · release · Queued · 0/1 tasks",
		"→ Final validation · Queued",
	]);
	assert.equal(projection.items.filter((value) => value.indent === 1).length, 2);
});

test("discloses integration, verification, review/fix, and final validation only as each phase is reached", () => {
	const delivery = stage("delivery", "running", [task("done", "completed")], pendingReview());
	let runtime = state([delivery]);
	let projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.map(({ label }) => label), [
		"→ Stage 1 · delivery · Integrating · 1/1 tasks",
		"Ready to integrate",
		"→ Final validation · Queued",
	]);

	delivery.integration.status = "completed";
	delivery.verification.status = "checking";
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.slice(1, -1).map(({ label }) => label), ["Integrated", "Verifying"]);

	delivery.verification.status = "completed";
	delivery.review = { status: "fixing", iteration: 1, repairCount: 1, currentFindings: [] };
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.slice(1, -1).map(({ label }) => label), ["Integrated", "Verified", "Stage fix #2"]);

	delivery.status = "completed";
	delivery.review = { status: "completed", iteration: 1, repairCount: 1, currentFindings: [] };
	runtime.finalReview = { status: "reviewing", iteration: 2, repairCount: 0, currentFindings: [] };
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.slice(-2).map(({ label }) => label), ["→ Final validation · Whole-branch review", "Whole-branch review #2"]);

	runtime.finalReview.status = "fix_pending";
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.slice(-2).map(({ label, status }) => [label, status]), [
		["→ Final validation · Whole-branch fix", "ready"],
		["Whole-branch fix #1", "ready"],
	]);

	runtime.finalReview.status = "completed";
	runtime.e2e = { status: "fixing", repairCount: 2, evidenceRefs: [] };
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	assert.deepEqual(projection.items.slice(-2).map(({ label }) => label), ["→ Final validation · E2E fix", "E2E fix #3"]);
});

test("capacity-blocked all-pending active stage is queued without animation", () => {
	const runtime = state([stage("delivery", "running", [task("one", "pending"), task("two", "pending")])]);
	const value = snapshot(runtime, ["concurrent"]);
	const projection = projectWorkflowDashboard(value, 0);
	assert.deepEqual(projection.items.map(({ label, status }) => [label, status]), [
		["⇉ Stage 1 · delivery · Waiting for capacity · 0/2 tasks", "queued"],
		["→ Final validation · Queued", "queued"],
	], "capacity-blocked stages remain compact until execution actually begins");
	assert.equal(workflowDashboardNeedsAnimation({ snapshot: value }, 0), false);
	assert.deepEqual(workflowDashboardLines(value, ctx, 80, 0, 0), workflowDashboardLines(value, ctx, 80, 7, 0));

	runtime.stages[0]!.tasks = [task("one", "check_pending"), task("two", "completed")];
	assert.equal(projectWorkflowDashboard(value, 0).items[0]!.status, "ready");
	assert.equal(workflowDashboardNeedsAnimation({ snapshot: value }, 0), false, "ready work does not run the timer");
	runtime.stages[0]!.tasks[0]!.status = "checking";
	assert.equal(workflowDashboardNeedsAnimation({ snapshot: value }, 0), true, "an active projected item runs the timer");
});

test("missing or mismatched topology uses only neutral unknown-mode indicators", () => {
	const runtime = state([
		stage("one", "completed", [task("first", "completed")]),
		stage("two", "pending", [task("second", "pending")]),
	]);
	const missing = snapshot(runtime);
	delete missing.stageTopology;
	assert.deepEqual(projectWorkflowDashboard(missing, 0).items.filter((value) => value.indent === 0).map(({ label }) => label.slice(0, 1)), ["?", "?", "→"]);

	const mismatched = snapshot(runtime);
	mismatched.stageTopology = [{ id: "two", mode: "concurrent" }, { id: "one", mode: "sequential" }];
	const headers = projectWorkflowDashboard(mismatched, 0).items.filter((value) => value.label.includes("Stage "));
	assert.ok(headers.every((value) => value.label.startsWith("? ")));
	assert.equal(headers.some((value) => value.label.startsWith("→ ") || value.label.startsWith("⇉ ")), false);
});

test("renders interrupted stage disclosure and semantic phase-specific icons", () => {
	const interrupted = stage("delivery", "running", [task("lost", "interrupted")]);
	interrupted.tasks[0]!.interruptedFrom = "checking";
	const runtime = state([interrupted]);
	runtime.status = "paused";
	const lines = visible(workflowDashboardLines(snapshot(runtime), ctx, 80, 2, 0));
	assert.ok(lines.some((line) => line.includes("‖ → Stage 1 · delivery · Interrupted")));
	assert.ok(lines.some((line) => line.includes("‖ Checking interrupted · lost")));
	assert.equal(lines.some((line) => line.includes("Ready to integrate")), false);
});

test("matches live workflow children by durable slot beneath the active row", () => {
	const runtime = state([stage("delivery", "running", [task("one", "implementing")])]);
	const now = Date.parse("2026-01-01T00:00:15.000Z");
	const children: SubagentUiWorkflowProjection = {
		owner: { sessionId: "session", processInstanceId: "process", activationId: "activation" },
		storyId: runtime.storyId,
		agents: [{
			agentId: "implementer-one",
			agent: "implementer",
			state: "running",
			presentation: "background",
			provider: "openai",
			model: "gpt",
			effort: "high",
			tier: "medium",
			fast: false,
			startedAt: "2026-01-01T00:00:10.000Z",
			updatedAt: "2026-01-01T00:00:14.000Z",
			progress: { startedAt: "2026-01-01T00:00:10.000Z", processStartedAt: "2026-01-01T00:00:10.100Z", lastEventAt: "2026-01-01T00:00:14.000Z", turns: 2, toolCalls: 3, toolErrors: 0, inputTokens: 500, outputTokens: 1_200, reasoningTokens: 0, activeTool: "bash" },
			workflow: { storyId: runtime.storyId, slotId: "task:one", action: "task-launch", taskId: "one" },
		}, {
			agentId: "unmatched-reviewer",
			agent: "reviewer",
			state: "running",
			presentation: "background",
			provider: "other",
			model: "model",
			effort: "medium",
			fast: false,
			startedAt: "2026-01-01T00:00:11.000Z",
			updatedAt: "2026-01-01T00:00:14.000Z",
			workflow: { storyId: runtime.storyId, slotId: "stage:delivery:review", action: "review" },
		}],
	};
	const value = snapshot(runtime);
	const lines = visible(workflowDashboardLines(value, ctx, 120, 2, now, children));
	assert.equal(workflowDashboardNeedsAnimation({ snapshot: value, workflowChildren: children }, now), true, "a live workflow child runs the timer");
	const activeRow = lines.findIndex((line) => line.includes("Implementing · one"));
	assert.ok(activeRow >= 0);
	assert.match(lines[activeRow + 1]!, /implementer · Medium \(openai\/gpt#high\) · 2 turns · 3 tools · ↓ 1\.2k · 5s · bash/);
	assert.equal(lines.some((line) => line.includes("unmatched-reviewer") || line.includes("reviewer · Configured")), false);
	assert.ok(lines.every((line) => visibleWidth(line) <= 120));
});

test("allocates a left-authoritative pane with quarter-width metrics capped near forty columns", () => {
	const runtime = state([stage("delivery", "running", [task("one", "implementing")])]);
	runtime.metrics.open = { category: "verification", since: "2026-01-01T00:00:10.000Z" };
	const value = snapshot(runtime);
	const now = Date.parse("2026-01-01T00:00:15.000Z");

	const narrow = visible(workflowDashboardLines(value, ctx, 80, 0, now));
	assert.equal(narrow.some((line) => line.includes("│")), false);
	assert.match(narrow[1]!, /^ Time · 20s · Verification 8s/);

	const medium = visible(workflowDashboardLines(value, ctx, 100, 0, now));
	const mediumDivider = medium[0]!.indexOf("│");
	assert.ok(mediumDivider >= 70 && mediumDivider <= 74, `medium divider at ${mediumDivider}`);
	assert.match(medium[0]!, /Workflow time\s+20s$/);

	const wide = visible(workflowDashboardLines(value, ctx, 160, 0, now));
	const wideDivider = wide[0]!.indexOf("│");
	assert.ok(wideDivider >= 115 && wideDivider <= 119, `wide divider at ${wideDivider}`);

	const veryWide = visible(workflowDashboardLines(value, ctx, 240, 0, now));
	const veryWideDivider = veryWide[0]!.indexOf("│");
	assert.ok(veryWideDivider >= 194, `very-wide divider at ${veryWideDivider}`);
	assert.ok(visibleWidth(veryWide[0]!.slice(veryWideDivider)) <= 42, "metrics pane stays capped near forty columns");
});

test("Current loop projects E2E journey, fixes, and interruption", () => {
	const runtime = state([stage("delivery", "completed", [task("one", "completed")])]);
	runtime.finalReview.status = "completed";
	runtime.e2e.status = "testing";
	assert.equal(projectWorkflowDashboard(snapshot(runtime), 0).currentLoop, "E2E · journey");

	runtime.e2e = { status: "fixing", repairCount: 2, evidenceRefs: [] };
	assert.equal(projectWorkflowDashboard(snapshot(runtime), 0).currentLoop, "E2E · fix #3");

	runtime.e2e = { status: "interrupted", interruptedFrom: "fixing", repairCount: 2, evidenceRefs: [] };
	const value = snapshot(runtime);
	assert.equal(projectWorkflowDashboard(value, 0).currentLoop, "E2E · fix #3 interrupted");
	const lines = visible(workflowDashboardLines(value, ctx, 160, 0, 0));
	assert.ok(lines.some((line) => /Current loop\s+E2E · fix #3 interrupted$/.test(line)));
	assert.equal(lines.some((line) => line.includes("Review loop")), false);

	runtime.e2e.interruptedFrom = "testing";
	assert.equal(projectWorkflowDashboard(snapshot(runtime), 0).currentLoop, "E2E · journey interrupted");
});

test("is width-safe for every width from zero through two", () => {
	const value = snapshot(state([stage("delivery", "running", [task("one", "implementing")])]));
	for (const width of [0, 1, 2]) {
		const lines = workflowDashboardLines(value, ctx, width, 0, 0);
		if (width === 0) assert.deepEqual(lines, []);
		else {
			assert.ok(lines.length > 0);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width} overflowed`);
		}
	}
});

test("adds one live wall-clock interval and marks incomplete category time", () => {
	const runtime = state([stage("delivery", "running", [task("one", "implementing"), task("two", "implementing")])]);
	runtime.metrics.open = { category: "implementation", since: "2026-01-01T00:00:10.000Z" };
	let projection = projectWorkflowDashboard(snapshot(runtime), Date.parse("2026-01-01T00:00:15.000Z"));
	assert.equal(projection.metrics.workflowMs, 20_000);
	assert.equal(workflowDashboardNeedsAnimation({ snapshot: snapshot(runtime) }, Date.parse("2026-01-01T00:00:15.000Z")), true, "an open metric runs the timer");
	assert.equal(Object.values(projection.metrics.categories).reduce((sum, value) => sum + value, 0), projection.metrics.workflowMs);

	delete runtime.metrics.open;
	runtime.metrics.incompleteIntervals = 1;
	runtime.metrics.incompleteCategories = ["review"];
	projection = projectWorkflowDashboard(snapshot(runtime), 0);
	const lines = visible(workflowDashboardLines(snapshot(runtime), ctx, 120, 0, 0));
	assert.equal(projection.metrics.incomplete, true);
	assert.match(lines[0]!, /Workflow time\s+15s\+$/);
	assert.ok(lines.some((line) => /Review\s+4s\+$/.test(line)));
});
