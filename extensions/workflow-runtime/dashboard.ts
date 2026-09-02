import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderSubagentFooterProjection, subagentIndicatorFrame } from "../subagent/display.js";
import type { SubagentUiWorkflowAgentProjection, SubagentUiWorkflowProjection } from "../subagent/ui-projection.js";
import type {
	E2ERuntimeState,
	ReviewRuntimeState,
	StageRuntimeState,
	StoryWorkflowMetrics,
	WorkflowMetricCategory,
} from "../workflow/story-runtime-store.js";
import type { WorkflowSnapshot } from "./api.js";

export type DashboardStatus = "active" | "ready" | "queued" | "interrupted" | "attention" | "completed";
export type DashboardActivity = "implementing" | "checking" | "repairing" | "integrating" | "verifying" | "reviewing" | "fixing" | "testing" | "queued" | "interrupted" | "attention" | "completed";

export interface DashboardItem {
	label: string;
	status: DashboardStatus;
	activity: DashboardActivity;
	indent: 0 | 1;
	slotId?: string;
	liveAgent?: SubagentUiWorkflowAgentProjection;
}

export interface DashboardMetricProjection {
	workflowMs: number;
	categories: Record<WorkflowMetricCategory, number>;
	incomplete: boolean;
	incompleteCategories: WorkflowMetricCategory[];
	activeCategory?: WorkflowMetricCategory;
}

export interface WorkflowDashboardProjection {
	title: string;
	completedTasks: number;
	totalTasks: number;
	items: DashboardItem[];
	metrics: DashboardMetricProjection;
	currentLoop: string;
}

export interface WorkflowDashboardEntry {
	snapshot: WorkflowSnapshot;
	workflowChildren?: SubagentUiWorkflowProjection;
}

const CATEGORY_LABELS: Record<WorkflowMetricCategory, string> = {
	implementation: "Implementation",
	integration: "Integration",
	verification: "Verification",
	review: "Review",
	e2e: "E2E",
};

const ACTIVE_TASK_STATUSES = new Set(["implementing", "checking", "repairing"]);
const ACTIVE_INTEGRATION_STATUSES = new Set(["integrating", "repairing"]);
const ACTIVE_VERIFICATION_STATUSES = new Set(["checking", "repairing"]);
const ACTIVE_REVIEW_STATUSES = new Set(["reviewing", "fixing"]);
const ACTIVE_E2E_STATUSES = new Set(["testing", "fixing"]);

function projectedMetrics(metrics: StoryWorkflowMetrics, now: number): DashboardMetricProjection {
	const categories = { ...metrics.categories };
	let workflowMs = metrics.workflowMs;
	if (metrics.open) {
		const since = Date.parse(metrics.open.since);
		const elapsed = Number.isFinite(since) ? Math.max(0, now - since) : 0;
		workflowMs += elapsed;
		categories[metrics.open.category] += elapsed;
	}
	return {
		workflowMs,
		categories,
		incomplete: metrics.incompleteIntervals > 0,
		incompleteCategories: [...metrics.incompleteCategories],
		...(metrics.open ? { activeCategory: metrics.open.category } : {}),
	};
}

function latestLiveAgents(projection: SubagentUiWorkflowProjection | undefined): Map<string, SubagentUiWorkflowAgentProjection> {
	const result = new Map<string, SubagentUiWorkflowAgentProjection>();
	for (const agent of projection?.agents ?? []) {
		const slotId = agent.workflow.slotId;
		const current = result.get(slotId);
		if (!current || Date.parse(agent.updatedAt) >= Date.parse(current.updatedAt)) result.set(slotId, agent);
	}
	return result;
}

function item(
	label: string,
	status: DashboardStatus,
	activity: DashboardActivity,
	indent: 0 | 1,
	slotId: string | undefined,
	live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>,
): DashboardItem {
	const liveAgent = slotId ? live.get(slotId) : undefined;
	return { label, status, activity, indent, ...(slotId ? { slotId } : {}), ...(liveAgent ? { liveAgent } : {}) };
}

function interruptedActivity(value: string | undefined): DashboardActivity {
	if (value === "implementing") return "implementing";
	if (value === "checking") return "checking";
	if (value === "integrating") return "integrating";
	if (value === "reviewing") return "reviewing";
	return value === "fixing" || value === "repairing" ? "repairing" : "interrupted";
}

function taskItem(task: StageRuntimeState["tasks"][number], live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>): DashboardItem {
	const slotId = `task:${task.id}`;
	if (task.status === "completed") return item(`Implemented · ${task.id}`, "completed", "completed", 1, slotId, live);
	if (task.status === "attention") return item(`Task attention · ${task.id}`, "attention", "attention", 1, slotId, live);
	if (task.status === "interrupted") {
		const activity = interruptedActivity(task.interruptedFrom);
		const label = task.interruptedFrom === "checking" ? "Checking interrupted" : task.interruptedFrom === "repairing" ? "Repair interrupted" : "Implementation interrupted";
		return item(`${label} · ${task.id}`, "interrupted", activity, 1, slotId, live);
	}
	if (task.status === "implementing") return item(`Implementing · ${task.id}`, "active", "implementing", 1, slotId, live);
	if (task.status === "check_pending") return item(`Checking · ${task.id}`, "ready", "checking", 1, slotId, live);
	if (task.status === "checking") return item(`Checking · ${task.id}`, "active", "checking", 1, slotId, live);
	if (task.status === "repair_pending") return item(`Repairing #${task.repairCount + 1} · ${task.id}`, "ready", "repairing", 1, slotId, live);
	if (task.status === "repairing") return item(`Repairing #${task.repairCount + 1} · ${task.id}`, "active", "repairing", 1, slotId, live);
	return item(`Queued · ${task.id}`, "queued", "queued", 1, slotId, live);
}

function integrationItem(stage: StageRuntimeState, live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>): DashboardItem {
	const value = stage.integration;
	const slotId = `stage:${stage.id}:integration`;
	if (value.status === "completed") return item("Integrated", "completed", "completed", 1, slotId, live);
	if (value.status === "attention") return item("Integration attention", "attention", "attention", 1, slotId, live);
	if (value.status === "interrupted") return item(value.interruptedFrom === "repairing" ? "Integration repair interrupted" : "Integration interrupted", "interrupted", interruptedActivity(value.interruptedFrom), 1, slotId, live);
	if (value.status === "integrating") return item("Integrating", "active", "integrating", 1, slotId, live);
	if (value.status === "repair_pending") return item(`Repairing integration #${value.repairCount + 1}`, "ready", "repairing", 1, slotId, live);
	if (value.status === "repairing") return item(`Repairing integration #${value.repairCount + 1}`, "active", "repairing", 1, slotId, live);
	return item("Ready to integrate", "ready", "integrating", 1, slotId, live);
}

function verificationItem(stage: StageRuntimeState, live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>): DashboardItem {
	const value = stage.verification;
	const slotId = `stage:${stage.id}:verification`;
	if (value.status === "completed") return item("Verified", "completed", "completed", 1, slotId, live);
	if (value.status === "attention") return item("Verification attention", "attention", "attention", 1, slotId, live);
	if (value.status === "interrupted") return item(value.interruptedFrom === "repairing" ? "Verification repair interrupted" : "Verification interrupted", "interrupted", interruptedActivity(value.interruptedFrom), 1, slotId, live);
	if (value.status === "checking") return item("Verifying", "active", "verifying", 1, slotId, live);
	if (value.status === "repair_pending") return item(`Repairing verification #${value.repairCount + 1}`, "ready", "repairing", 1, slotId, live);
	if (value.status === "repairing") return item(`Repairing verification #${value.repairCount + 1}`, "active", "repairing", 1, slotId, live);
	return item("Ready to verify", "ready", "verifying", 1, slotId, live);
}

function reviewIteration(review: ReviewRuntimeState): number {
	return review.status === "pending" && review.iteration > 0 ? review.iteration + 1 : Math.max(1, review.iteration);
}

function reviewItem(review: ReviewRuntimeState, slotId: string, prefix: string, live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>): DashboardItem {
	if (review.status === "completed") return item(`${prefix} reviewed`, "completed", "completed", 1, slotId, live);
	if (review.status === "skipped") return item(`${prefix} review skipped`, "completed", "completed", 1, slotId, live);
	if (review.status === "attention") return item(`${prefix} review attention`, "attention", "attention", 1, slotId, live);
	const fixNumber = review.repairCount + 1;
	if (review.status === "interrupted") {
		const fixing = review.interruptedFrom === "fixing";
		return item(`${prefix} ${fixing ? `fix #${fixNumber}` : `review #${reviewIteration(review)}`} interrupted`, "interrupted", fixing ? "fixing" : "reviewing", 1, slotId, live);
	}
	if (review.status === "reviewing") return item(`${prefix} review #${reviewIteration(review)}`, "active", "reviewing", 1, slotId, live);
	if (review.status === "fix_pending") return item(`${prefix} fix #${fixNumber}`, "ready", "fixing", 1, slotId, live);
	if (review.status === "fixing") return item(`${prefix} fix #${fixNumber}`, "active", "fixing", 1, slotId, live);
	return item(`Ready for ${prefix.toLowerCase()} review #${reviewIteration(review)}`, "ready", "reviewing", 1, slotId, live);
}

function e2eItem(e2e: E2ERuntimeState, live: ReadonlyMap<string, SubagentUiWorkflowAgentProjection>): DashboardItem {
	const slotId = "e2e";
	if (e2e.status === "completed") return item("E2E journey completed", "completed", "completed", 1, slotId, live);
	if (e2e.status === "attention") return item("E2E attention", "attention", "attention", 1, slotId, live);
	if (e2e.status === "interrupted") {
		const fixing = e2e.interruptedFrom === "fixing";
		return item(fixing ? `E2E fix #${e2e.repairCount + 1} interrupted` : "E2E journey interrupted", "interrupted", fixing ? "fixing" : "testing", 1, slotId, live);
	}
	if (e2e.status === "testing") return item("E2E journey", "active", "testing", 1, slotId, live);
	if (e2e.status === "fix_pending") return item(`E2E fix #${e2e.repairCount + 1}`, "ready", "fixing", 1, slotId, live);
	if (e2e.status === "fixing") return item(`E2E fix #${e2e.repairCount + 1}`, "active", "fixing", 1, slotId, live);
	return item("E2E journey queued", "queued", "queued", 1, slotId, live);
}

function stageAttention(stage: StageRuntimeState): boolean {
	return stage.status === "attention" || stage.tasks.some((task) => task.status === "attention")
		|| stage.integration.status === "attention" || stage.verification.status === "attention" || stage.review.status === "attention";
}

function stageInterrupted(stage: StageRuntimeState): boolean {
	return stage.tasks.some((task) => task.status === "interrupted") || stage.integration.status === "interrupted"
		|| stage.verification.status === "interrupted" || stage.review.status === "interrupted";
}

function stageWaitingForCapacity(stage: StageRuntimeState): boolean {
	return stage.status === "running" && stage.tasks.length > 0 && stage.tasks.every((task) => task.status === "pending");
}

function stageHasActiveWork(stage: StageRuntimeState): boolean {
	return stage.tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status))
		|| ACTIVE_INTEGRATION_STATUSES.has(stage.integration.status)
		|| ACTIVE_VERIFICATION_STATUSES.has(stage.verification.status)
		|| ACTIVE_REVIEW_STATUSES.has(stage.review.status);
}

function stageActivity(stage: StageRuntimeState): DashboardActivity {
	const task = stage.tasks.find((candidate) => ACTIVE_TASK_STATUSES.has(candidate.status) || candidate.status === "check_pending" || candidate.status === "repair_pending");
	if (task?.status === "checking" || task?.status === "check_pending") return "checking";
	if (task?.status === "repairing" || task?.status === "repair_pending") return "repairing";
	if (task) return "implementing";
	if (ACTIVE_INTEGRATION_STATUSES.has(stage.integration.status) || stage.integration.status === "repair_pending") return stage.integration.status === "integrating" ? "integrating" : "repairing";
	if (ACTIVE_VERIFICATION_STATUSES.has(stage.verification.status) || stage.verification.status === "repair_pending") return stage.verification.status === "checking" ? "verifying" : "repairing";
	if (ACTIVE_REVIEW_STATUSES.has(stage.review.status) || stage.review.status === "fix_pending") return stage.review.status === "reviewing" ? "reviewing" : "fixing";
	if (stage.status === "completed") return "completed";
	if (stage.status === "pending") return "queued";
	if (stage.tasks.some((candidate) => candidate.status !== "completed")) return "implementing";
	if (stage.integration.status !== "completed") return "integrating";
	if (stage.verification.status !== "completed") return "verifying";
	if (stage.review.status !== "completed" && stage.review.status !== "skipped") return "reviewing";
	return "queued";
}

function activityLabel(activity: DashboardActivity): string {
	if (activity === "implementing") return "Implementing";
	if (activity === "checking") return "Checking";
	if (activity === "repairing") return "Repairing";
	if (activity === "integrating") return "Integrating";
	if (activity === "verifying") return "Verifying";
	if (activity === "reviewing") return "Reviewing";
	if (activity === "fixing") return "Fixing";
	if (activity === "testing") return "E2E journey";
	if (activity === "completed") return "Completed";
	return "Queued";
}

function reviewLoop(review: ReviewRuntimeState): string {
	const phase = review.status === "fix_pending" || review.status === "fixing" || (review.status === "interrupted" && review.interruptedFrom === "fixing")
		? `fix #${review.repairCount + 1}` : `review #${reviewIteration(review)}`;
	return review.status === "interrupted" ? `${phase} interrupted` : phase;
}

function currentLoop(snapshot: WorkflowSnapshot): string {
	const state = snapshot.runtime;
	for (const [index, stage] of state.stages.entries()) {
		if (stage.integration.status !== "completed" || stage.verification.status !== "completed") continue;
		if (stage.review.status !== "completed" && stage.review.status !== "skipped") return `Stage ${index + 1} · ${reviewLoop(stage.review)}`;
	}
	if (state.stages.every((stage) => stage.status === "completed") && state.finalReview.status !== "completed") {
		return `Final · ${reviewLoop(state.finalReview)}`;
	}
	if (state.finalReview.status === "completed") {
		if (state.e2e.status === "testing") return "E2E · journey";
		if (state.e2e.status === "fix_pending" || state.e2e.status === "fixing") return `E2E · fix #${state.e2e.repairCount + 1}`;
		if (state.e2e.status === "interrupted") {
			return state.e2e.interruptedFrom === "fixing" ? `E2E · fix #${state.e2e.repairCount + 1} interrupted` : "E2E · journey interrupted";
		}
		if (state.e2e.status === "attention") return "E2E · attention";
	}
	return "—";
}

function stageModeIndicators(snapshot: WorkflowSnapshot): string[] {
	const topology = snapshot.stageTopology;
	const stages = snapshot.runtime.stages;
	const matches = topology?.length === stages.length && topology.every((entry, index) => entry.id === stages[index]?.id);
	if (!matches) return stages.map(() => "?");
	return topology.map((entry) => entry.mode === "concurrent" ? "⇉" : "→");
}

/** Pure progressive-disclosure projection of authoritative stage state plus authored display topology. */
export function projectWorkflowDashboard(snapshot: WorkflowSnapshot, now: number, workflowChildren?: SubagentUiWorkflowProjection): WorkflowDashboardProjection {
	const state = snapshot.runtime;
	const live = latestLiveAgents(workflowChildren);
	const modeIndicators = stageModeIndicators(snapshot);
	const items: DashboardItem[] = [];
	for (const [index, stage] of state.stages.entries()) {
		const completed = stage.tasks.filter((task) => task.status === "completed").length;
		const attention = stageAttention(stage);
		const interrupted = stageInterrupted(stage);
		const waitingForCapacity = !attention && !interrupted && stageWaitingForCapacity(stage);
		const active = stageHasActiveWork(stage);
		const expanded = (stage.status === "running" && !waitingForCapacity) || attention || interrupted;
		const status: DashboardStatus = attention ? "attention" : interrupted ? "interrupted" : stage.status === "completed" ? "completed"
			: waitingForCapacity || stage.status === "pending" ? "queued" : active ? "active" : "ready";
		const activity: DashboardActivity = attention ? "attention" : interrupted ? "interrupted" : waitingForCapacity ? "queued" : stageActivity(stage);
		const lifecycle = attention ? "Needs attention" : interrupted ? "Interrupted" : waitingForCapacity ? "Waiting for capacity" : activityLabel(activity);
		items.push(item(`${modeIndicators[index]} Stage ${index + 1} · ${stage.id} · ${lifecycle} · ${completed}/${stage.tasks.length} tasks`, status, activity, 0, undefined, live));
		if (!expanded) continue;

		const integrationReached = stage.tasks.every((task) => task.status === "completed") || stage.integration.status !== "pending";
		const verificationReached = stage.integration.status === "completed" || stage.verification.status !== "pending";
		const reviewReached = stage.review.status !== "skipped" && (stage.verification.status === "completed" || stage.review.status !== "pending");
		if (!integrationReached) for (const task of stage.tasks) items.push(taskItem(task, live));
		if (integrationReached) items.push(integrationItem(stage, live));
		if (verificationReached) items.push(verificationItem(stage, live));
		if (reviewReached) items.push(reviewItem(stage.review, `stage:${stage.id}:review`, "Stage", live));
	}

	const finalAttention = state.finalReview.status === "attention" || state.e2e.status === "attention";
	const finalInterrupted = state.finalReview.status === "interrupted" || state.e2e.status === "interrupted";
	const finalReviewActive = ACTIVE_REVIEW_STATUSES.has(state.finalReview.status);
	const finalReviewReached = finalReviewActive || state.finalReview.status === "fix_pending";
	const e2eActive = ACTIVE_E2E_STATUSES.has(state.e2e.status);
	const e2eReached = e2eActive || state.e2e.status === "fix_pending";
	const finalReady = state.finalReview.status === "fix_pending" || state.e2e.status === "fix_pending";
	const finalCompleted = state.finalReview.status === "completed" && state.e2e.status === "completed";
	const finalStatus: DashboardStatus = finalAttention ? "attention" : finalInterrupted ? "interrupted" : finalCompleted ? "completed" : finalReady ? "ready" : finalReviewActive || e2eActive ? "active" : "queued";
	const finalActivity: DashboardActivity = finalAttention ? "attention" : finalInterrupted ? "interrupted"
		: e2eReached ? (state.e2e.status === "testing" ? "testing" : "fixing")
			: finalReviewReached ? (state.finalReview.status === "reviewing" ? "reviewing" : "fixing")
				: finalCompleted ? "completed" : "queued";
	const finalLifecycle = finalAttention ? "Needs attention" : finalInterrupted ? "Interrupted" : finalCompleted ? "Completed"
		: e2eReached ? (state.e2e.status === "testing" ? "E2E journey" : "E2E fix")
			: finalReviewReached ? (state.finalReview.status === "reviewing" ? "Whole-branch review" : "Whole-branch fix") : "Queued";
	items.push(item(`→ Final validation · ${finalLifecycle}`, finalStatus, finalActivity, 0, undefined, live));
	if (finalReviewReached || state.finalReview.status === "interrupted" || state.finalReview.status === "attention") {
		items.push(reviewItem(state.finalReview, "final-review", "Whole-branch", live));
	} else if (e2eReached || state.e2e.status === "interrupted" || state.e2e.status === "attention") {
		items.push(e2eItem(state.e2e, live));
	}

	return {
		title: snapshot.title,
		completedTasks: state.stages.flatMap((stage) => stage.tasks).filter((task) => task.status === "completed").length,
		totalTasks: state.stages.reduce((total, stage) => total + stage.tasks.length, 0),
		items,
		metrics: projectedMetrics(state.metrics, now),
		currentLoop: currentLoop(snapshot),
	};
}

const TASK_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const INTEGRATION_FRAMES = ["⇢", "→", "⇢", "⇒"] as const;
const VERIFICATION_FRAMES = ["◐", "◓", "◑", "◒"] as const;

function icon(value: DashboardItem, frame: number): string {
	if (value.status === "completed") return "✓";
	if (value.status === "attention") return "⚠";
	if (value.status === "interrupted") return "‖";
	if (value.liveAgent) {
		const lifecycle = value.liveAgent.state === "launching" ? "starting" : value.liveAgent.state === "stopping" ? "stopping" : "running";
		return subagentIndicatorFrame(lifecycle, frame);
	}
	if (value.status === "ready") return "◆";
	if (value.status === "queued") return "·";
	if (value.activity === "integrating") return INTEGRATION_FRAMES[frame % INTEGRATION_FRAMES.length]!;
	if (value.activity === "checking" || value.activity === "verifying") return VERIFICATION_FRAMES[frame % VERIFICATION_FRAMES.length]!;
	return TASK_FRAMES[frame % TASK_FRAMES.length]!;
}

function tone(value: DashboardItem): "accent" | "success" | "error" | "warning" | "muted" {
	if (value.status === "completed") return "success";
	if (value.status === "attention") return "error";
	if (value.status === "interrupted") return "warning";
	if (value.liveAgent) return value.liveAgent.state === "stopping" ? "warning" : value.liveAgent.state === "launching" ? "muted" : "accent";
	if (value.status === "active" || value.status === "ready") return "accent";
	return "muted";
}

function duration(milliseconds: number, incomplete = false): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	let value: string;
	if (seconds < 60) value = `${seconds}s`;
	else {
		const minutes = Math.floor(seconds / 60);
		value = minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
	}
	return `${value}${incomplete ? "+" : ""}`;
}

function itemLines(projection: WorkflowDashboardProjection, ctx: ExtensionContext, frame: number, now: number): string[] {
	const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${projection.title} · ${projection.completedTasks}/${projection.totalTasks} tasks`))];
	for (const value of projection.items) {
		lines.push(`${value.indent ? "  " : ""}${ctx.ui.theme.fg(tone(value), `${icon(value, frame)} ${value.label}`)}`);
		if (value.liveAgent) lines.push(`    ${renderSubagentFooterProjection(value.liveAgent, ctx.ui.theme, now)}`);
	}
	return lines;
}

function metricRows(projection: WorkflowDashboardProjection): Array<readonly [string, string]> {
	return [
		["Workflow time", duration(projection.metrics.workflowMs, projection.metrics.incomplete)],
		...Object.entries(CATEGORY_LABELS).map(([category, label]) => {
			const metricCategory = category as WorkflowMetricCategory;
			return [label, duration(projection.metrics.categories[metricCategory], projection.metrics.incompleteCategories.includes(metricCategory))] as const;
		}),
		["Current loop", projection.currentLoop],
	];
}

function narrowMetricLine(projection: WorkflowDashboardProjection): string {
	const workflow = duration(projection.metrics.workflowMs, projection.metrics.incomplete);
	if (!projection.metrics.activeCategory) return `Time · ${workflow}`;
	const category = projection.metrics.activeCategory;
	return `Time · ${workflow} · ${CATEGORY_LABELS[category]} ${duration(projection.metrics.categories[category], projection.metrics.incompleteCategories.includes(category))}`;
}

function projectionLines(projection: WorkflowDashboardProjection, ctx: ExtensionContext, width: number, frame: number, now: number): string[] {
	if (width <= 0) return [];
	const padding = width >= 3 ? 1 : 0;
	const innerWidth = width - (padding * 2);
	const tasks = itemLines(projection, ctx, frame, now);
	const desiredMetricWidth = Math.min(40, Math.floor(innerWidth * 0.25));
	const showMetrics = innerWidth >= 96 && desiredMetricWidth >= 24;
	const metricWidth = showMetrics ? desiredMetricWidth : 0;
	const taskWidth = showMetrics ? innerWidth - metricWidth - 3 : innerWidth;
	const metrics = showMetrics ? metricRows(projection) : [];
	const leftLines = showMetrics ? tasks : [tasks[0]!, ctx.ui.theme.fg("dim", narrowMetricLine(projection)), ...tasks.slice(1)];
	const rowCount = showMetrics ? Math.max(leftLines.length, metrics.length) : leftLines.length;
	const side = " ".repeat(padding);
	return Array.from({ length: rowCount }, (_, index) => {
		const left = truncateToWidth(leftLines[index] ?? "", taskWidth, "…");
		let content = left;
		if (showMetrics) {
			const leftPane = `${left}${" ".repeat(Math.max(0, taskWidth - visibleWidth(left)))}`;
			const metric = metrics[index];
			let metricText = "";
			if (metric) {
				const [label, value] = metric;
				const shownValue = truncateToWidth(value, Math.max(1, metricWidth - visibleWidth(label) - 1), "…");
				metricText = `${ctx.ui.theme.fg("dim", label)}${" ".repeat(Math.max(1, metricWidth - visibleWidth(label) - visibleWidth(shownValue)))}${ctx.ui.theme.fg("text", shownValue)}`;
			}
			content = `${leftPane}${ctx.ui.theme.fg("borderMuted", " │ ")}${metricText}`;
		}
		const boundedContent = truncateToWidth(content, innerWidth, "…");
		return ctx.ui.theme.bg("customMessageBg", `${side}${boundedContent}${" ".repeat(Math.max(0, innerWidth - visibleWidth(boundedContent)))}${side}`);
	});
}

/** True only while this projection has elapsed or active visuals to advance. */
export function workflowDashboardNeedsAnimation(entry: WorkflowDashboardEntry, now = Date.now()): boolean {
	const projection = projectWorkflowDashboard(entry.snapshot, now, entry.workflowChildren);
	return Boolean(projection.metrics.activeCategory || entry.workflowChildren?.agents.length || projection.items.some((value) => value.status === "active"));
}

/** TUI renderer; timers may advance only frame/elapsed visuals, never workflow state. */
export function workflowDashboardLines(snapshot: WorkflowSnapshot, ctx: ExtensionContext, width: number, frame = 0, now = Date.now(), workflowChildren?: SubagentUiWorkflowProjection): string[] {
	return projectionLines(projectWorkflowDashboard(snapshot, now, workflowChildren), ctx, width, frame, now);
}

/** Renders every attached workflow into one widget without sharing child rows between stories. */
export function workflowDashboardsLines(entries: readonly WorkflowDashboardEntry[], ctx: ExtensionContext, width: number, frame = 0, now = Date.now()): string[] {
	return entries.flatMap((entry) => projectionLines(projectWorkflowDashboard(entry.snapshot, now, entry.workflowChildren), ctx, width, frame, now));
}
