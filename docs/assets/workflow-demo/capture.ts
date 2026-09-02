import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { workflowDashboardLines } from "../../../extensions/workflow-runtime/dashboard.js";
import type { WorkflowSnapshot } from "../../../extensions/workflow-runtime/api.js";
import type {
	ReviewRuntimeState,
	StageRuntimeState,
	StoryRuntimeState,
	StoryWorkflowMetrics,
	TaskRuntimeState,
} from "../../../extensions/workflow/story-runtime-store.js";

interface Run6Provenance {
	storyId: string;
	title: string;
	stages: Array<{
		id: string;
		mode: "sequential" | "concurrent";
		tasks: string[];
		review: { status: "skipped" | "completed"; iteration: number; repairCount: number };
	}>;
	checks: { passed: number; total: number };
	finalReview: { status: "completed"; iteration: number; repairCount: number };
	e2e: { passed: number; total: number; repairCount: number };
	metricsMs: {
		workflow: number;
		implementation: number;
		integration: number;
		verification: number;
		review: number;
		e2e: number;
	};
}

const IDEA = "Let's make a todo list app.";
const RUN6 = JSON.parse(readFileSync(new URL("./run6-provenance.json", import.meta.url), "utf8")) as Run6Provenance;
const STAGE_SPECS = RUN6.stages.map((stage) => [stage.id, stage.mode, stage.tasks] as const);
const FINAL_METRICS: StoryWorkflowMetrics = {
	workflowMs: RUN6.metricsMs.workflow,
	categories: {
		implementation: RUN6.metricsMs.implementation,
		integration: RUN6.metricsMs.integration,
		verification: RUN6.metricsMs.verification,
		review: RUN6.metricsMs.review,
		e2e: RUN6.metricsMs.e2e,
	},
	incompleteIntervals: 0,
	incompleteCategories: [],
};

interface DemoScene {
	kind: "intro" | "workflow";
	title?: string;
	kicker?: string;
	columns?: Array<{ title: string; lines: string[] }>;
	note?: string;
	snapshot?: WorkflowSnapshot;
}

const pendingReview = (): ReviewRuntimeState => ({
	status: "pending",
	iteration: 0,
	repairCount: 0,
	currentFindings: [],
});

const task = (id: string): TaskRuntimeState => ({ id, status: "pending", repairCount: 0, checks: [] });

function stage(id: string, taskIds: readonly string[], review: "pending" | "skipped"): StageRuntimeState {
	return {
		id,
		status: "pending",
		tasks: taskIds.map(task),
		integration: { status: "pending", repairCount: 0, contributionCommits: [] },
		verification: { status: "pending", repairCount: 0, checks: [] },
		review: review === "skipped" ? { ...pendingReview(), status: "skipped" } : pendingReview(),
	};
}

function baseState(): StoryRuntimeState {
	return {
		schemaVersion: 1,
		storyId: RUN6.storyId,
		status: "running",
		contracts: { story: "demo", plan: "demo", tasks: {} },
		git: { canonicalBranch: "feature/aero-todo-list", baseCommit: "demo" },
		stages: RUN6.stages.map((source) => stage(source.id, source.tasks, source.review.status === "skipped" ? "skipped" : "pending")),
		finalReview: pendingReview(),
		e2e: { status: "pending", repairCount: 0, evidenceRefs: [] },
		metrics: {
			workflowMs: 0,
			categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0 },
			incompleteIntervals: 0,
			incompleteCategories: [],
		},
	};
}

function markStageComplete(value: StageRuntimeState): void {
	value.status = "completed";
	for (const current of value.tasks) current.status = "completed";
	value.integration.status = "completed";
	value.verification.status = "completed";
	const source = RUN6.stages.find((stage) => stage.id === value.id);
	if (source?.review.status === "completed") {
		value.review.status = "completed";
		value.review.iteration = source.review.iteration;
		value.review.repairCount = source.review.repairCount;
	}
}

function applyMetrics(
	state: StoryRuntimeState,
	seconds: Partial<Record<keyof StoryWorkflowMetrics["categories"], number>>,
): void {
	const categories = {
		implementation: (seconds.implementation ?? 0) * 1_000,
		integration: (seconds.integration ?? 0) * 1_000,
		verification: (seconds.verification ?? 0) * 1_000,
		review: (seconds.review ?? 0) * 1_000,
		e2e: (seconds.e2e ?? 0) * 1_000,
	};
	state.metrics = {
		workflowMs: Object.values(categories).reduce((total, value) => total + value, 0),
		categories,
		incompleteIntervals: 0,
		incompleteCategories: [],
	};
}

function snapshot(name: "start" | "foundations" | "features" | "stage-fix" | "app" | "final-fix" | "e2e" | "done"): WorkflowSnapshot {
	const state = baseState();
	if (name === "start") {
		state.stages[0]!.status = "running";
		state.stages[0]!.tasks[0]!.status = "implementing";
		applyMetrics(state, { implementation: 82 });
	} else if (name === "foundations") {
		markStageComplete(state.stages[0]!);
		const current = state.stages[1]!;
		current.status = "running";
		current.tasks.forEach((value, index) => { value.status = index < 2 ? "completed" : "implementing"; });
		applyMetrics(state, { implementation: 633, verification: 9 });
	} else if (name === "features") {
		markStageComplete(state.stages[0]!);
		markStageComplete(state.stages[1]!);
		const current = state.stages[2]!;
		current.status = "running";
		current.tasks.forEach((value, index) => { value.status = index < 2 ? "completed" : "implementing"; });
		applyMetrics(state, { implementation: 860, verification: 50, review: 200 });
	} else if (name === "stage-fix") {
		markStageComplete(state.stages[0]!);
		markStageComplete(state.stages[1]!);
		const current = state.stages[2]!;
		current.status = "running";
		current.tasks.forEach((value) => { value.status = "completed"; });
		current.integration.status = "completed";
		current.verification.status = "completed";
		current.review = { status: "fixing", iteration: 1, repairCount: 0, currentFindings: [] };
		applyMetrics(state, { implementation: 870, integration: 1, verification: 65, review: 414 });
	} else if (name === "app") {
		markStageComplete(state.stages[0]!);
		markStageComplete(state.stages[1]!);
		markStageComplete(state.stages[2]!);
		const current = state.stages[3]!;
		current.status = "running";
		current.tasks[0]!.status = "implementing";
		applyMetrics(state, { implementation: 1_030, integration: 1, verification: 80, review: 479 });
	} else if (name === "final-fix") {
		for (const current of state.stages) markStageComplete(current);
		state.finalReview = { status: "fixing", iteration: 1, repairCount: 0, currentFindings: [] };
		applyMetrics(state, { implementation: 1_076, integration: 1, verification: 102, review: 546 });
	} else if (name === "e2e") {
		for (const current of state.stages) markStageComplete(current);
		state.finalReview = { ...RUN6.finalReview, currentFindings: [] };
		state.e2e.status = "testing";
		applyMetrics(state, { implementation: 1_076, integration: 1, verification: 102, review: 598, e2e: 170 });
	} else {
		for (const current of state.stages) markStageComplete(current);
		state.status = "completed";
		state.finalReview = { ...RUN6.finalReview, currentFindings: [] };
		state.e2e = {
			status: "completed",
			repairCount: RUN6.e2e.repairCount,
			evidenceRefs: ["evidence/result.json"],
			result: { code: "passed", summary: `Complete E2E contract passed. All ${RUN6.e2e.passed} journeys passed.` },
		};
		state.metrics = structuredClone(FINAL_METRICS);
		state.outcomeStatus = "written";
	}
	return {
		ref: "work-item:aero-todo-list",
		title: RUN6.title,
		status: name === "done" ? "done" : "running",
		runtime: state,
		stageTopology: STAGE_SPECS.map(([id, mode]) => ({ id, mode })),
	};
}

const SCENES: DemoScene[] = [
	{
		kind: "intro",
		kicker: "PRODUCT DISCUSSION",
		title: "Turn a loose idea into an observable outcome",
		columns: [
			{ title: "Intent", lines: ["Fast capture", "Calm daily flow"] },
			{ title: "Behavior", lines: ["Create · complete · filter", "Recover safely"] },
			{ title: "Quality", lines: ["Accessible", "Responsive · persistent"] },
		],
		note: "Clarify the outcome before choosing implementation details.",
	},
	{
		kind: "intro",
		kicker: "SHAPE STORY",
		title: "A durable product contract",
		columns: [
			{ title: "Specification", lines: ["Outcome + scope", "Rules + edge cases"] },
			{ title: "Design", lines: ["Boundaries + flow", "Failure + recovery"] },
			{ title: "E2E contract", lines: ["5 user journeys", "Observable proof"] },
		],
		note: "Reviewed before planning begins.",
	},
	{
		kind: "intro",
		kicker: "IMPLEMENTATION PLAN",
		title: "13 self-contained tasks · 4 ordered stages",
		columns: [
			{ title: "→ Foundation", lines: ["1 sequential task", "5 focused checks"] },
			{ title: "⇉ Parallel slices", lines: ["6 + 5 concurrent tasks", "Isolated worktrees"] },
			{ title: "→ Integration", lines: ["1 assembly task", "Review + final E2E"] },
		],
		note: "Compiled and reviewed. Execution still requires explicit user authority.",
	},
	{ kind: "workflow", snapshot: snapshot("start") },
	{ kind: "workflow", snapshot: snapshot("foundations") },
	{ kind: "workflow", snapshot: snapshot("features") },
	{ kind: "workflow", snapshot: snapshot("stage-fix") },
	{ kind: "workflow", snapshot: snapshot("app") },
	{ kind: "workflow", snapshot: snapshot("final-fix") },
	{ kind: "workflow", snapshot: snapshot("e2e") },
	{ kind: "workflow", snapshot: snapshot("done") },
];

function padLine(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

export default function workflowCapture(pi: ExtensionAPI): void {
	let ctx: ExtensionContext | undefined;
	let requestRender: (() => void) | undefined;
	let sceneIndex = -1;
	let frame = 0;
	let started = false;
	const timers = new Set<NodeJS.Timeout>();

	const clearTimers = () => {
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
	};
	const schedule = (delay: number, callback: () => void) => {
		const timer = setTimeout(() => {
			timers.delete(timer);
			callback();
		}, delay);
		timers.add(timer);
		timer.unref();
	};
	const rerender = () => requestRender?.();

	pi.on("session_start", (_event, sessionCtx) => {
		ctx = sessionCtx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setTitle("PiBox Workflow · accelerated reenactment");
		ctx.ui.setWorkingVisible(false);
		ctx.ui.setHeader((_tui, theme) => new Text(
			`${theme.fg("accent", theme.bold("PiBox Workflow"))}\n${theme.fg("dim", "Idea → reviewed contract → managed execution → working product")}`,
			1,
			1,
		));
		ctx.ui.setFooter((_tui, theme) => ({
			render(width: number): string[] {
				const rule = theme.fg("borderMuted", "─".repeat(width));
				const left = theme.fg("accent", "π  PiBox");
				const right = theme.fg("dim", "Accelerated reenactment · real completed run topology");
				return ["", rule, padLine(left, right, width)];
			},
			invalidate() {},
		}));
		ctx.ui.setWidget("pibox-workflow-demo", (tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				render(width: number): string[] {
					if (sceneIndex < 0) {
						return [
							theme.fg("dim", "Type an idea to begin the real Pi TUI reenactment."),
							theme.fg("muted", "The workflow will advance through compressed snapshots of the completed Aero Todo run."),
						];
					}
					const scene = SCENES[Math.min(sceneIndex, SCENES.length - 1)]!;
					if (scene.kind === "workflow" && scene.snapshot && ctx) {
						const lines = workflowDashboardLines(scene.snapshot, ctx, width, frame, Date.now());
						if (scene.snapshot.status === "done") {
							lines.push(theme.fg("success", `✓ Deterministic checks · ${RUN6.checks.passed}/${RUN6.checks.total} passed`));
							lines.push(theme.fg("success", `✓ E2E contract · ${RUN6.e2e.passed}/${RUN6.e2e.total} user journeys passed`));
						}
						return lines;
					}
					const lines = [
						theme.fg("accent", theme.bold(`Idea · ${IDEA}`)),
						"",
						theme.fg("muted", scene.kicker ?? ""),
						theme.fg("text", theme.bold(scene.title ?? "")),
						"",
					];
					for (const column of scene.columns ?? []) {
						lines.push(`${theme.fg("success", "✓")} ${theme.fg("accent", theme.bold(column.title))}  ${theme.fg("muted", column.lines.join("  ·  "))}`);
					}
					if (scene.note) lines.push("", theme.fg("dim", scene.note));
					return lines.map((line) => truncateToWidth(line, width, "…"));
				},
				invalidate() {},
			};
		});
	});

	pi.on("input", (event) => {
		if (event.source !== "interactive" || event.text.trim() !== IDEA || started) return undefined;
		started = true;
		sceneIndex = 0;
		rerender();
		// Three shaping scenes, then representative states grounded in sanitized Run 6 provenance.
		const sceneTimes = [1_250, 2_500, 3_750, 5_000, 6_150, 7_300, 8_450, 9_600, 10_750, 11_900];
		for (const [index, delay] of sceneTimes.entries()) schedule(delay, () => { sceneIndex = index + 1; rerender(); });
		const animate = () => {
			if (sceneIndex < 3 || sceneIndex >= SCENES.length - 1) return;
			frame += 1;
			rerender();
			schedule(90, animate);
		};
		schedule(3_760, animate);
		return { action: "handled" as const };
	});

	pi.on("session_shutdown", () => {
		clearTimers();
		ctx = undefined;
		requestRender = undefined;
	});
}
