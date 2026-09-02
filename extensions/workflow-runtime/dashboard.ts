import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	E2ERuntimeState,
	ReviewRuntimeState,
	StageRuntimeState,
	StoryRuntimeState,
	StoryWorkflowMetrics,
	WorkflowMetricCategory,
} from "../workflow/story-runtime-store.js";

export type DashboardStatus = "active" | "queued" | "interrupted" | "attention" | "completed";

export interface DashboardItem {
	label: string;
	status: DashboardStatus;
	detail?: string;
	indent: 0 | 1;
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
	reviewPosition: string;
}

const CATEGORY_LABELS: Record<WorkflowMetricCategory, string> = {
	implementation: "Implementation",
	integration: "Integration",
	verification: "Verification",
	review: "Review",
	e2e: "E2E",
};

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

function taskStatus(status: StageRuntimeState["tasks"][number]["status"]): DashboardStatus {
	if (status === "completed") return "completed";
	if (status === "interrupted") return "interrupted";
	if (status === "attention") return "attention";
	if (status === "implementing" || status === "checking" || status === "repairing") return "active";
	return "queued";
}

function integrationStatus(status: StageRuntimeState["integration"]["status"]): DashboardStatus {
	if (status === "completed") return "completed";
	if (status === "interrupted") return "interrupted";
	if (status === "attention") return "attention";
	if (status === "integrating" || status === "repairing") return "active";
	return "queued";
}

function verificationStatus(status: StageRuntimeState["verification"]["status"]): DashboardStatus {
	if (status === "completed") return "completed";
	if (status === "interrupted") return "interrupted";
	if (status === "attention") return "attention";
	if (status === "checking" || status === "repairing") return "active";
	return "queued";
}

function reviewStatus(status: ReviewRuntimeState["status"]): DashboardStatus {
	if (status === "completed" || status === "skipped") return "completed";
	if (status === "interrupted") return "interrupted";
	if (status === "attention") return "attention";
	if (status === "reviewing" || status === "fixing") return "active";
	return "queued";
}

function e2eStatus(status: E2ERuntimeState["status"]): DashboardStatus {
	if (status === "completed") return "completed";
	if (status === "interrupted") return "interrupted";
	if (status === "attention") return "attention";
	if (status === "testing" || status === "fixing") return "active";
	return "queued";
}

function taskDetail(status: StageRuntimeState["tasks"][number]["status"]): string | undefined {
	if (status === "check_pending" || status === "checking") return "checks";
	if (status === "repair_pending" || status === "repairing") return "repair";
	if (status === "implementing") return "implementation";
	return undefined;
}

function integrationDetail(status: StageRuntimeState["integration"]["status"]): string | undefined {
	return status === "repair_pending" || status === "repairing" ? "repair" : undefined;
}

function verificationDetail(status: StageRuntimeState["verification"]["status"]): string | undefined {
	return status === "repair_pending" || status === "repairing" ? "repair" : undefined;
}

function reviewDetail(review: ReviewRuntimeState): string {
	if (review.status === "skipped") return "skipped";
	if (review.status === "fix_pending" || review.status === "fixing" || (review.status === "interrupted" && review.interruptedFrom === "fixing")) {
		return `fix #${review.repairCount + 1}`;
	}
	const iteration = review.status === "pending" && review.iteration > 0 ? review.iteration + 1 : Math.max(1, review.iteration);
	return `review #${iteration}`;
}

function e2eDetail(e2e: E2ERuntimeState): string {
	return e2e.status === "fix_pending" || e2e.status === "fixing" || (e2e.status === "interrupted" && e2e.interruptedFrom === "fixing")
		? `fix #${e2e.repairCount + 1}`
		: "journey";
}

function stageDashboardStatus(stage: StageRuntimeState): DashboardStatus {
	if (stage.status === "completed") return "completed";
	if (stage.status === "attention") return "attention";
	const childStatuses: DashboardStatus[] = [
		...stage.tasks.map((task) => taskStatus(task.status)),
		integrationStatus(stage.integration.status),
		verificationStatus(stage.verification.status),
		reviewStatus(stage.review.status),
	];
	if (childStatuses.includes("attention")) return "attention";
	if (childStatuses.includes("interrupted")) return "interrupted";
	return stage.status === "running" || childStatuses.includes("active") ? "active" : "queued";
}

function currentReviewPosition(state: StoryRuntimeState): string {
	for (const [index, stage] of state.stages.entries()) {
		if (stage.integration.status !== "completed" || stage.verification.status !== "completed") continue;
		if (stage.review.status !== "completed" && stage.review.status !== "skipped") {
			return `Stage ${index + 1} · ${reviewDetail(stage.review)} · ${reviewStatus(stage.review.status)}`;
		}
	}
	if (state.stages.every((stage) => stage.status === "completed") && state.finalReview.status !== "completed") {
		return `Final · ${reviewDetail(state.finalReview)} · ${reviewStatus(state.finalReview.status)}`;
	}
	return "—";
}

/** Pure stage-centric projection of authoritative runtime state. */
export function projectWorkflowDashboard(state: StoryRuntimeState, now: number): WorkflowDashboardProjection {
	const items: DashboardItem[] = [];
	for (const [index, stage] of state.stages.entries()) {
		const completed = stage.tasks.filter((task) => task.status === "completed").length;
		items.push({ label: `Stage ${index + 1} · ${stage.id} · ${completed}/${stage.tasks.length} tasks`, status: stageDashboardStatus(stage), indent: 0 });
		for (const task of stage.tasks) {
			const detail = taskDetail(task.status);
			items.push({ label: `Task · ${task.id}`, status: taskStatus(task.status), ...(detail ? { detail } : {}), indent: 1 });
		}
		const integrationDetailText = integrationDetail(stage.integration.status);
		items.push({ label: "Integration", status: integrationStatus(stage.integration.status), ...(integrationDetailText ? { detail: integrationDetailText } : {}), indent: 1 });
		const verificationDetailText = verificationDetail(stage.verification.status);
		items.push({ label: "Verification", status: verificationStatus(stage.verification.status), ...(verificationDetailText ? { detail: verificationDetailText } : {}), indent: 1 });
		items.push({ label: "Review", status: reviewStatus(stage.review.status), detail: reviewDetail(stage.review), indent: 1 });
	}
	items.push({ label: "Final review", status: reviewStatus(state.finalReview.status), detail: reviewDetail(state.finalReview), indent: 0 });
	items.push({ label: "E2E", status: e2eStatus(state.e2e.status), detail: e2eDetail(state.e2e), indent: 0 });
	return {
		title: state.storyId,
		completedTasks: state.stages.flatMap((stage) => stage.tasks).filter((task) => task.status === "completed").length,
		totalTasks: state.stages.reduce((total, stage) => total + stage.tasks.length, 0),
		items,
		metrics: projectedMetrics(state.metrics, now),
		reviewPosition: currentReviewPosition(state),
	};
}

const ACTIVE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

function icon(status: DashboardStatus, frame: number): string {
	if (status === "active") return ACTIVE_FRAMES[frame % ACTIVE_FRAMES.length]!;
	if (status === "completed") return "✓";
	if (status === "attention") return "⚠";
	if (status === "interrupted") return "‖";
	return "·";
}

function tone(status: DashboardStatus): "accent" | "success" | "error" | "warning" | "muted" {
	if (status === "active") return "accent";
	if (status === "completed") return "success";
	if (status === "attention") return "error";
	if (status === "interrupted") return "warning";
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

function itemLines(projection: WorkflowDashboardProjection, ctx: ExtensionContext, frame: number): string[] {
	const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${projection.title} · ${projection.completedTasks}/${projection.totalTasks} tasks`))];
	for (const item of projection.items) {
		const detail = item.detail ? ` · ${item.detail}` : "";
		lines.push(`${item.indent ? "  " : ""}${ctx.ui.theme.fg(tone(item.status), `${icon(item.status, frame)} ${item.label} · ${item.status}${detail}`)}`);
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
		["Review loop", projection.reviewPosition],
	];
}

function narrowMetricLine(projection: WorkflowDashboardProjection): string {
	const workflow = duration(projection.metrics.workflowMs, projection.metrics.incomplete);
	if (!projection.metrics.activeCategory) return `Time · ${workflow}`;
	const category = projection.metrics.activeCategory;
	return `Time · ${workflow} · ${CATEGORY_LABELS[category]} ${duration(projection.metrics.categories[category], projection.metrics.incompleteCategories.includes(category))}`;
}

/** TUI renderer; all workflow semantics come from the pure state projection above. */
export function workflowDashboardLines(state: StoryRuntimeState, ctx: ExtensionContext, width: number, frame?: number, now?: number): string[];
/** Temporary broad overload until workflow-runtime/index.ts supplies StoryRuntimeState directly. */
export function workflowDashboardLines(state: unknown, ctx: ExtensionContext, width: number, frame?: number, now?: number): string[];
export function workflowDashboardLines(state: unknown, ctx: ExtensionContext, width: number, frame = 0, now = Date.now()): string[] {
	const projection = projectWorkflowDashboard(state as StoryRuntimeState, now);
	const innerWidth = Math.max(1, width - 2);
	const items = itemLines(projection, ctx, frame);
	const naturalItemWidth = Math.max(...items.map((item) => visibleWidth(item)));
	const compactItemWidth = Math.min(naturalItemWidth, Math.max(28, Math.floor(innerWidth * 0.58)));
	const metricWidth = innerWidth - compactItemWidth - 3;
	const showWideMetrics = innerWidth >= 72 && metricWidth >= 24;
	const leftWidth = showWideMetrics ? compactItemWidth : innerWidth;
	const metrics = showWideMetrics ? metricRows(projection) : [];
	const leftLines = showWideMetrics ? items : [items[0]!, ctx.ui.theme.fg("dim", narrowMetricLine(projection)), ...items.slice(1)];
	const rowCount = showWideMetrics ? Math.max(leftLines.length, metrics.length) : leftLines.length;
	return Array.from({ length: rowCount }, (_, index) => {
		const left = truncateToWidth(leftLines[index] ?? "", leftWidth, "…");
		let content = left;
		if (showWideMetrics) {
			const leftPane = `${left}${" ".repeat(Math.max(0, leftWidth - visibleWidth(left)))}`;
			const metric = metrics[index];
			let metricText = "";
			if (metric) {
				const [label, value] = metric;
				const shownValue = truncateToWidth(value, Math.max(1, metricWidth - visibleWidth(label) - 1), "…");
				metricText = `${ctx.ui.theme.fg("dim", label)}${" ".repeat(Math.max(1, metricWidth - visibleWidth(label) - visibleWidth(shownValue)))}${ctx.ui.theme.fg("text", shownValue)}`;
			}
			content = `${leftPane}${ctx.ui.theme.fg("borderMuted", " │ ")}${metricText}`;
		}
		return ctx.ui.theme.bg("customMessageBg", ` ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} `);
	});
}
