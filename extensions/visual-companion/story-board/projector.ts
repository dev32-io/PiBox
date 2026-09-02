import type { Diagnostic, DocumentGroup, DocumentSummary, ReportSummary, StorySummary, TaskCard, TaskColumn } from "./models.js";

export const TASK_STATUSES = [
	"draft", "blocked", "ready", "running", "paused", "submitted", "awaiting_ci", "contribution_complete", "reviewing", "changes_requested", "accepted", "merge_queued", "merging", "merged", "staged", "integrating", "integrated", "failed", "protocol_failed", "cancelled",
] as const;
const TODO = new Set<string>(["draft", "blocked", "ready", "pending"]);
const DONE = new Set<string>(["merged", "integrated", "cancelled", "completed"]);

/** Unknown historical statuses deliberately remain visible in the middle column. */
export function taskColumn(status: string): TaskColumn {
	if (TODO.has(status)) return "To do";
	if (DONE.has(status)) return "Done";
	return "In progress";
}
export const mapTaskStatus = taskColumn;

export interface StoryProjectionInput {
	id: string; title?: string | undefined; intentExcerpt?: string | undefined; kind?: string | undefined; phase?: string | undefined; state?: string | undefined; planningRevision?: number | undefined;
	taskCount?: number; reportCount?: number; diagnostics?: Diagnostic[];
}

export function projectStorySummary(input: StoryProjectionInput): StorySummary {
	return {
		id: input.id,
		title: input.title?.trim() || input.id,
		intentExcerpt: input.intentExcerpt?.trim() || "",
		kind: input.kind || "story",
		phase: input.phase || "unknown",
		state: input.state || "unknown",
		...(input.planningRevision !== undefined ? { planningRevision: input.planningRevision } : {}),
		taskCount: input.taskCount ?? 0,
		reportCount: input.reportCount ?? 0,
		degraded: Boolean(input.diagnostics?.length),
		diagnostics: input.diagnostics ?? [],
	};
}

export interface TaskProjectionInput {
	id: string; title?: string | undefined; status?: string | undefined; dependsOn?: string[]; stage?: string | undefined; relatedReportIds?: string[]; diagnostics?: Diagnostic[];
}

export function projectTaskCard(input: TaskProjectionInput): TaskCard {
	const status = input.status || "unknown";
	return {
		id: input.id, title: input.title?.trim() || input.id, status, column: taskColumn(status),
		dependsOn: [...(input.dependsOn ?? [])],
		...(input.stage ? { stage: input.stage } : {}),
		relatedReportIds: [...(input.relatedReportIds ?? [])].sort(),
		degraded: Boolean(input.diagnostics?.length), diagnostics: input.diagnostics ?? [],
	};
}

const GROUPS: Record<string, DocumentGroup> = {
	intent: "Intent and scope", spec: "Specifications", design: "Design", decision: "Decisions", "e2e-matrix": "Journey cases", outcome: "Outcome",
};
export function documentGroup(type: string): DocumentGroup | undefined { return GROUPS[type]; }

const completed = (story: StorySummary): boolean => story.phase === "complete" || story.state === "complete" || story.state === "archived";
export function orderStorySummaries(stories: readonly StorySummary[]): StorySummary[] {
	return [...stories].sort((a, b) => Number(completed(a)) - Number(completed(b)) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export function orderTaskCards(tasks: readonly TaskCard[]): TaskCard[] {
	return [...tasks].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export function orderDocuments(documents: readonly DocumentSummary[]): DocumentSummary[] {
	return [...documents].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}
export function orderReports(reports: readonly ReportSummary[]): ReportSummary[] {
	return [...reports].sort((a, b) => a.id.localeCompare(b.id));
}
