import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { parseStoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { E2ERuntimeState, IntegrationRuntimeState, ReviewRuntimeState, StoryRuntimeState, TaskRuntimeState, VerificationRuntimeState, WorkflowMetricCategory } from "../../workflow/story-runtime-store.js";
import { parseAuthoredTaskDocument, parseStoryDocument, parseStoryPlanDocument } from "../../workflow/work-items.js";
import type { AuthoredTaskDocument, StoryDocument, StoryPlanDocument } from "../../workflow/types.js";
import { readBoundedCurrentRuntimeState, readCurrentEvidenceMetadata } from "./evidence.js";
import type { CheckAggregate, Diagnostic, DocumentDetail, DocumentGroup, DocumentSummary, Finding, FindingCounts, ReportDetail, ReportSummary, RuntimeSummaryProjection, StageOperationProjection, StageProjection, StageTimingProjection, StorySummary, StoryWorkspace, TaskCard, TaskDetail, WorkflowMetricsProjection, WorkflowOverview } from "./models.js";
import { orderDocuments, orderReports, orderTaskCards, projectStorySummary, projectTaskCard } from "./projector.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ACTIVE_TASK_STATUSES = new Set(["implementing", "check_pending", "checking", "repair_pending", "repairing", "interrupted"]);
function diagnostic(path: string, message: string): Diagnostic { return { path, message }; }
function inside(root: string, path: string): boolean { const rel = relative(root, path); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); }
function excerpt(markdown: string): string { return markdown.replace(/<!--[^]*?-->/g, "").replace(/^#{1,6}\s+.*$/gm, "").split(/\r?\n/).map((line) => line.replace(/^[-*>]\s*/, "").trim()).filter(Boolean).slice(0, 3).join(" ").replace(/[*_`[\]]/g, "").slice(0, 280); }
function titleFromMarkdown(markdown: string, fallback: string): string { return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallback; }
function publicRuntimeText(value: string): string {
	const quoted = value.replace(/(["'`])((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*)\1/g, (_match, quote: string) => `${quote}[private path]${quote}`);
	return quoted.replace(/(^|[\s=(\[\]{},;])((?:[A-Za-z]:[\\/]|\/)[^\s"'`),;\]}]*)/g, "$1[private path]");
}
function contractDigest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

async function regularFile(path: string, root: string, repositoryRoot: string): Promise<boolean> {
	const info = await lstat(path).catch(() => undefined); if (!info?.isFile() || info.isSymbolicLink()) return false;
	const [actual, actualRoot, repository] = await Promise.all([realpath(path).catch(() => undefined), realpath(root).catch(() => undefined), realpath(repositoryRoot).catch(() => undefined)]);
	return Boolean(actual && actualRoot && repository && inside(repository, actualRoot) && inside(actualRoot, actual));
}

interface SafeCheck { id: string; status: string; failure?: { code: string; summary: string } }
interface SafeOperation { status: string; repairCount: number; checks?: SafeCheck[]; result?: { code: string; summary: string }; failure?: { code: string; summary: string }; integratedCommit?: string }
interface SafeTaskState extends SafeOperation { id: string; checks: SafeCheck[]; contributionCommit?: string }
interface SafeReview extends SafeOperation { iteration: number; currentFindings: Finding[]; acceptedRisks: Array<{ findingId: string; rationale: string }> }
interface SafeStageState { id: string; status: string; tasks: SafeTaskState[]; integration: SafeOperation; verification: SafeOperation; review: SafeReview }
interface SafeState {
	status: StoryRuntimeState["status"];
	contracts: StoryRuntimeState["contracts"];
	outcomeStatus?: "pending" | "written" | "failed";
	attention?: RuntimeSummaryProjection;
	stages: SafeStageState[];
	finalReview: SafeReview;
	e2e: SafeOperation & { evidenceRefs: string[] };
	metrics: WorkflowMetricsProjection;
}
interface CurrentBundle { story?: StoryDocument; plan?: StoryPlanDocument; tasks: AuthoredTaskDocument[]; state?: SafeState; diagnostics: Diagnostic[] }

/** Internal state signal. The version seed must never be returned directly to a viewer. */
export interface CurrentStateObservation {
	versionSeed: string;
	status: StoryRuntimeState["status"];
	outcomeStatus?: StoryRuntimeState["outcomeStatus"];
}

type RuntimeOperation = TaskRuntimeState | IntegrationRuntimeState | VerificationRuntimeState | ReviewRuntimeState | E2ERuntimeState;
function publicSummary(value: RuntimeOperation["result"]): { code: string; summary: string } | undefined {
	return value ? { code: value.code, summary: publicRuntimeText(value.summary) } : undefined;
}
function publicChecks(value: TaskRuntimeState["checks"] | VerificationRuntimeState["checks"]): SafeCheck[] {
	return value.map((check) => ({ id: check.id, status: check.status, ...(check.failure ? { failure: { code: check.failure.code, summary: publicRuntimeText(check.failure.summary) } } : {}) }));
}
function publicOperation(value: RuntimeOperation): SafeOperation {
	const result = publicSummary(value.result); const failure = publicSummary(value.failure);
	return { status: value.status, repairCount: value.repairCount, ...("checks" in value ? { checks: publicChecks(value.checks) } : {}), ...(result ? { result } : {}), ...(failure ? { failure } : {}), ...("integratedCommit" in value && /^[a-f0-9]{7,64}$/i.test(value.integratedCommit ?? "") ? { integratedCommit: value.integratedCommit } : {}) };
}
function publicReview(value: ReviewRuntimeState): SafeReview {
	const currentFindings = value.currentFindings.map((finding): Finding => { const safePath = finding.path && !isAbsolute(finding.path) && !/^[A-Za-z]:[\\/]/.test(finding.path) && !finding.path.split(/[\\/]/).includes("..") ? finding.path : undefined; return { id: finding.id, severity: finding.severity, status: "open", summary: publicRuntimeText(finding.summary), ...(safePath ? { location: `${safePath}${finding.line === undefined ? "" : `:${finding.line}`}` } : {}) }; });
	return { ...publicOperation(value), iteration: value.iteration, currentFindings, acceptedRisks: (value.acceptedRisks ?? []).map((risk) => ({ findingId: risk.findingId, rationale: publicRuntimeText(risk.rationale) })) };
}
function publicTask(value: TaskRuntimeState): SafeTaskState {
	return { ...publicOperation(value), id: value.id, checks: publicChecks(value.checks), ...(value.contributionCommit && /^[a-f0-9]{7,64}$/i.test(value.contributionCommit) ? { contributionCommit: value.contributionCommit } : {}) };
}
function publicTiming(value: StoryRuntimeState["metrics"], stageId?: string): StageTimingProjection {
	const source = stageId ? value.stageBreakdown?.[stageId] : value;
	const timing: StageTimingProjection = source ? {
		workflowMs: source.workflowMs,
		categories: { ...source.categories },
		incompleteIntervals: source.incompleteIntervals,
		incompleteCategories: [...source.incompleteCategories],
	} : {
		workflowMs: 0,
		categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	};
	if (value.open && (!stageId || value.open.stageId === stageId)) {
		timing.activeCategory = value.open.category;
		timing.activeSince = value.open.since;
	}
	return timing;
}
function stateDocument(value: unknown, storyId: string): SafeState {
	const state: StoryRuntimeState = parseStoryRuntimeState(value, storyId);
	const metrics: WorkflowMetricsProjection = {
		...publicTiming(state.metrics),
		...(state.metrics.open?.stageId ? { activeStageId: state.metrics.open.stageId } : {}),
		...(state.metrics.stageBreakdown ? { stageBreakdown: Object.fromEntries(Object.keys(state.metrics.stageBreakdown).map((stageId) => [stageId, publicTiming(state.metrics, stageId)])) } : {}),
	};
	return {
		status: state.status, contracts: { story: state.contracts.story, plan: state.contracts.plan, tasks: { ...state.contracts.tasks } },
		...(state.outcomeStatus ? { outcomeStatus: state.outcomeStatus } : {}),
		...(state.attention ? { attention: { code: state.attention.code, summary: publicRuntimeText(state.attention.summary) } } : {}),
		stages: state.stages.map((stage) => ({ id: stage.id, status: stage.status, tasks: stage.tasks.map(publicTask), integration: publicOperation(stage.integration), verification: publicOperation(stage.verification), review: publicReview(stage.review) })),
		finalReview: publicReview(state.finalReview), e2e: { ...publicOperation(state.e2e), evidenceRefs: [...state.e2e.evidenceRefs] }, metrics,
	};
}

export class CurrentStoryReader {
	readonly repositoryRoot: string;
	constructor(repositoryRoot: string) { this.repositoryRoot = resolve(repositoryRoot); }

	async isCurrent(root: string): Promise<boolean> { return Boolean(await lstat(join(root, "story.yaml")).catch(() => undefined)); }

	async observeWorkspace(storyId: string): Promise<CurrentStateObservation | undefined> {
		if (!ID.test(storyId)) return undefined;
		const artifactRoot = join(this.repositoryRoot, "agent-artifacts"); const root = join(artifactRoot, storyId);
		const [repository, artifacts, story, artifactInfo, storyInfo] = await Promise.all([
			realpath(this.repositoryRoot).catch(() => undefined), realpath(artifactRoot).catch(() => undefined), realpath(root).catch(() => undefined),
			lstat(artifactRoot).catch(() => undefined), lstat(root).catch(() => undefined),
		]);
		if (!repository || !artifacts || !story || !artifactInfo?.isDirectory() || artifactInfo.isSymbolicLink() || !storyInfo?.isDirectory() || storyInfo.isSymbolicLink()
			|| !inside(repository, artifacts) || !inside(artifacts, story) || !(await regularFile(join(root, "story.yaml"), root, this.repositoryRoot))) return undefined;
		return this.observeState(storyId, root);
	}

	private boundedState(storyId: string, root: string): Promise<{ bytes: Buffer; state: StoryRuntimeState }> { return readBoundedCurrentRuntimeState(this.repositoryRoot, storyId, root); }

	async observeState(storyId: string, root: string): Promise<CurrentStateObservation | undefined> {
		try {
			const { bytes, state } = await this.boundedState(storyId, root);
			return {
				versionSeed: createHash("sha256").update(bytes).digest("hex"),
				status: state.status,
				...(state.outcomeStatus ? { outcomeStatus: state.outcomeStatus } : {}),
			};
		} catch {
			return undefined;
		}
	}

	private async readStory(storyId: string, root: string, diagnostics: Diagnostic[]): Promise<StoryDocument | undefined> {
		const display = `agent-artifacts/${storyId}/story.yaml`; const path = join(root, "story.yaml");
		if (!(await regularFile(path, root, this.repositoryRoot))) { diagnostics.push(diagnostic(display, "Current story is not a contained regular file")); return undefined; }
		const content = await readFile(path, "utf8").catch(() => undefined); if (content === undefined) { diagnostics.push(diagnostic(display, "Current story is unreadable")); return undefined; }
		try { const story = parseStoryDocument(content, display); if (story.id !== storyId) throw new Error("identity mismatch"); return story; }
		catch { diagnostics.push(diagnostic(display, "Current story is malformed or does not match its canonical directory")); return undefined; }
	}
	private async readPlan(storyId: string, root: string, diagnostics: Diagnostic[]): Promise<StoryPlanDocument | undefined> {
		const display = `agent-artifacts/${storyId}/plan.yaml`; const path = join(root, "plan.yaml"); const info = await lstat(path).catch(() => undefined); if (!info) return undefined;
		if (!(await regularFile(path, root, this.repositoryRoot))) { diagnostics.push(diagnostic(display, "Plan is not a contained regular file")); return undefined; }
		try { return parseStoryPlanDocument(await readFile(path, "utf8"), display, { draft: true }); } catch { diagnostics.push(diagnostic(display, "Plan is malformed")); return undefined; }
	}
	private async readTask(storyId: string, root: string, taskId: string, diagnostics: Diagnostic[]): Promise<AuthoredTaskDocument | undefined> {
		if (!ID.test(taskId)) return undefined; const display = `agent-artifacts/${storyId}/tasks/${taskId}.yaml`; const path = join(root, "tasks", `${taskId}.yaml`);
		if (!(await regularFile(path, root, this.repositoryRoot))) { diagnostics.push(diagnostic(display, "Task is missing or is not a contained canonical YAML file")); return undefined; }
		try { const task = parseAuthoredTaskDocument(await readFile(path, "utf8"), display); if (task.id !== taskId) throw new Error("identity mismatch"); return task; } catch { diagnostics.push(diagnostic(display, "Task is malformed or has a mismatched identity")); return undefined; }
	}
	private async readTasks(storyId: string, root: string, diagnostics: Diagnostic[]): Promise<AuthoredTaskDocument[]> {
		const taskRoot = join(root, "tasks"); const rootInfo = await lstat(taskRoot).catch(() => undefined); if (!rootInfo) return [];
		if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) { diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks`, "Tasks root is not a contained directory")); return []; }
		const entries = await readdir(taskRoot, { withFileTypes: true }).catch(() => []); const tasks: AuthoredTaskDocument[] = [];
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (!entry.name.endsWith(".yaml")) continue; const id = entry.name.slice(0, -5); if (!ID.test(id)) { diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks/${entry.name}`, "Task is not a contained canonical YAML file")); continue; } const task = await this.readTask(storyId, root, id, diagnostics); if (task) tasks.push(task);
		}
		return tasks;
	}
	private async readState(storyId: string, root: string, diagnostics: Diagnostic[]): Promise<SafeState | undefined> {
		const display = `agent-artifacts/${storyId}/state.yaml`; const path = join(root, "state.yaml"); const info = await lstat(path).catch(() => undefined); if (!info) return undefined;
		try { return stateDocument((await this.boundedState(storyId, root)).state, storyId); }
		catch { diagnostics.push(diagnostic(display, "Runtime state is malformed, unsupported, oversized, or not a contained regular file")); return undefined; }
	}
	private async bundle(storyId: string, root: string): Promise<CurrentBundle> {
		const diagnostics: Diagnostic[] = []; const story = await this.readStory(storyId, root, diagnostics); const plan = await this.readPlan(storyId, root, diagnostics); const tasks = await this.readTasks(storyId, root, diagnostics); const state = await this.readState(storyId, root, diagnostics);
		const runtimeTaskIds = new Set(state?.stages.flatMap((stage) => stage.tasks.map((task) => task.id)) ?? []); const expectedTaskIds = state ? runtimeTaskIds : new Set(plan?.stages.flatMap((stage) => stage.tasks) ?? []); const found = new Set(tasks.map((task) => task.id));
		for (const taskId of expectedTaskIds) if (!found.has(taskId) && !diagnostics.some((item) => item.path.endsWith(`/tasks/${taskId}.yaml`))) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks/${taskId}.yaml`, "Authoritative task is missing"));
		if (state) for (const task of tasks) if (!runtimeTaskIds.has(task.id)) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks/${task.id}.yaml`, "Task is outside authoritative runtime membership and is omitted"));
		if (plan && state) {
			const planned = plan.stages.map((stage) => `${stage.id}:${stage.tasks.join(",")}`); const runtime = state.stages.map((stage) => `${stage.id}:${stage.tasks.map((task) => task.id).join(",")}`);
			if (planned.length !== runtime.length || planned.some((value, index) => value !== runtime[index])) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/plan.yaml`, "Plan topology differs from authoritative runtime state; runtime stage order and task membership are shown"));
		}
		if (state && story && contractDigest(story) !== state.contracts.story) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/story.yaml`, "Story content differs from the authoritative runtime contract"));
		if (state && plan && contractDigest(plan) !== state.contracts.plan) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/plan.yaml`, "Plan content differs from the authoritative runtime contract"));
		if (state) for (const task of tasks) if (state.contracts.tasks[task.id] && contractDigest(task) !== state.contracts.tasks[task.id]) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks/${task.id}.yaml`, "Task content differs from the authoritative runtime contract"));
		return { ...(story ? { story } : {}), ...(plan ? { plan } : {}), tasks, ...(state ? { state } : {}), diagnostics };
	}
	private reportCount(state?: SafeState): number { return state ? state.stages.reduce((count, stage) => count + stage.tasks.length + 3, 0) + 2 : 0; }
	async summary(storyId: string, root: string): Promise<StorySummary> {
		const diagnostics: Diagnostic[] = []; const story = await this.readStory(storyId, root, diagnostics); const plan = await this.readPlan(storyId, root, diagnostics); const state = await this.readState(storyId, root, diagnostics); const taskCount = new Set(state?.stages.flatMap((stage) => stage.tasks.map((task) => task.id)) ?? plan?.stages.flatMap((stage) => stage.tasks) ?? []).size;
		if (state && story && contractDigest(story) !== state.contracts.story) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/story.yaml`, "Story content differs from the authoritative runtime contract"));
		if (state && plan && contractDigest(plan) !== state.contracts.plan) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/plan.yaml`, "Plan content differs from the authoritative runtime contract"));
		return { ...projectStorySummary({ id: storyId, title: story?.title, intentExcerpt: story ? excerpt(story.spec) : "", kind: story?.kind, phase: state?.status === "completed" ? "complete" : state ? "execution" : plan ? "planning" : "shaping", state: state?.status ?? "authored", taskCount, reportCount: this.reportCount(state), diagnostics }), format: "current" };
	}
	private taskStage(taskId: string, plan?: StoryPlanDocument, state?: SafeState): string | undefined { return state?.stages.find((stage) => stage.tasks.some((task) => task.id === taskId))?.id ?? plan?.stages.find((stage) => stage.tasks.includes(taskId))?.id; }
	private taskStatus(taskId: string, state?: SafeState): string { return state?.stages.flatMap((stage) => stage.tasks).find((task) => task.id === taskId)?.status ?? "pending"; }
	private reportId(kind: "task" | "integration" | "verification" | "review", id: string): string { return kind === "task" ? `task-${id}` : `stage-${id}-${kind}`; }
	private reportMetadata(value: SafeOperation): { attempt?: number; verdict?: string } {
		const iteration = (value as Partial<SafeReview>).iteration; const attempt = typeof iteration === "number" ? (iteration > 0 ? iteration : undefined) : value.status === "pending" ? undefined : value.repairCount + 1; const verdict = value.result?.code ?? value.failure?.code;
		return { ...(attempt === undefined ? {} : { attempt }), ...(verdict ? { verdict } : {}) };
	}
	private reports(state?: SafeState): ReportSummary[] {
		if (!state) return [];
		const reports: ReportSummary[] = [];
		for (const stage of state.stages) {
			for (const task of stage.tasks) reports.push({ id: this.reportId("task", task.id), type: "task", status: task.status, scope: { kind: "task", id: task.id }, taskId: task.id, ...this.reportMetadata(task), findingCount: 0, hasRiskAcceptance: false, available: true, diagnostics: [] });
			for (const [kind, value] of [["integration", stage.integration], ["verification", stage.verification], ["review", stage.review]] as const) reports.push({ id: this.reportId(kind, stage.id), type: `stage-${kind}`, status: value.status, scope: { kind: "stage", id: stage.id }, ...this.reportMetadata(value), findingCount: kind === "review" ? value.currentFindings.length : 0, hasRiskAcceptance: kind === "review" && value.acceptedRisks.length > 0, available: true, diagnostics: [] });
		}
		reports.push({ id: "final-review", type: "final-review", status: state.finalReview.status, scope: { kind: "final" }, ...this.reportMetadata(state.finalReview), findingCount: state.finalReview.currentFindings.length, hasRiskAcceptance: state.finalReview.acceptedRisks.length > 0, available: true, diagnostics: [] });
		reports.push({ id: "final-e2e", type: "final-e2e", status: state.e2e.status, scope: { kind: "e2e" }, ...this.reportMetadata(state.e2e), findingCount: 0, hasRiskAcceptance: false, available: true, diagnostics: [] });
		return orderReports(reports);
	}
	private checkAggregate(checks: SafeCheck[] = [], pendingTotal = 0): CheckAggregate {
		return {
			passed: checks.filter((check) => check.status === "passed").length,
			failed: checks.filter((check) => check.status === "failed").length,
			running: checks.filter((check) => check.status === "running").length,
			total: checks.length || pendingTotal,
		};
	}
	private findingCounts(reviews: SafeReview[]): FindingCounts {
		const counts: FindingCounts = { critical: 0, major: 0, minor: 0, total: 0 };
		for (const finding of reviews.flatMap((review) => review.currentFindings)) {
			if (finding.severity === "critical" || finding.severity === "major" || finding.severity === "minor") counts[finding.severity] += 1;
			counts.total += 1;
		}
		return counts;
	}
	private operation(value: SafeOperation | undefined, reportId?: string, pendingChecks = 0): StageOperationProjection {
		return {
			status: value?.status ?? "pending", repairCount: value?.repairCount ?? 0,
			...(value?.checks || pendingChecks ? { checks: this.checkAggregate(value?.checks, pendingChecks) } : {}),
			...(value?.result ? { result: value.result } : {}), ...(value?.failure ? { failure: value.failure } : {}), ...(reportId ? { reportId } : {}),
		};
	}
	private reviewOperation(value: SafeReview | undefined, status: string, reportId?: string): StageOperationProjection {
		return { ...this.operation(value, reportId), status: value?.status ?? status, findings: this.findingCounts(value ? [value] : []) };
	}
	private stages(plan: StoryPlanDocument | undefined, state: SafeState | undefined, authoredTasks: AuthoredTaskDocument[]): StageProjection[] {
		const plannedById = new Map(plan?.stages.map((stage) => [stage.id, stage]) ?? []);
		const ordered = state?.stages.map((stage) => { const planned = plannedById.get(stage.id); const mode: StageProjection["mode"] = planned?.mode ?? "unknown"; return { id: stage.id, mode, tasks: stage.tasks.map((task) => task.id), checks: planned?.checks ?? [], ...(planned && "review" in planned ? { review: planned.review } : {}) }; }) ?? plan?.stages ?? [];
		const authored = new Map(authoredTasks.map((task) => [task.id, task]));
		const runtimeTasks = new Map(state?.stages.flatMap((stage) => stage.tasks.map((task) => [task.id, task] as const)) ?? []);
		const completed = new Set([...runtimeTasks.values()].filter((task) => task.status === "completed").map((task) => task.id));
		return ordered.map((planned) => {
			const runtime = state?.stages.find((stage) => stage.id === planned.id); const taskIds = runtime?.tasks.map((task) => task.id) ?? planned.tasks;
			const tasks = taskIds.map((id) => {
				const task = runtimeTasks.get(id); const source = authored.get(id); const dependsOn = source?.dependsOn ?? [];
				return {
					id, title: source?.title ?? id, status: task?.status ?? "pending", dependsOn,
					incompleteDependencyCount: dependsOn.filter((dependency) => !completed.has(dependency)).length,
					repairCount: task?.repairCount ?? 0, checks: this.checkAggregate(task?.checks, source?.checks.length ?? 0),
					...(task?.result ? { result: task.result } : {}), ...(task?.failure ? { failure: task.failure } : {}),
					...(task ? { reportId: this.reportId("task", id) } : {}),
				};
			});
			return {
				id: planned.id, mode: planned.mode, status: runtime?.status ?? "pending", taskIds, tasks,
				progress: { completed: tasks.filter((task) => task.status === "completed").length, total: tasks.length },
				integration: this.operation(runtime?.integration, runtime ? this.reportId("integration", planned.id) : undefined),
				verification: this.operation(runtime?.verification, runtime ? this.reportId("verification", planned.id) : undefined, planned.checks.length),
				review: this.reviewOperation(runtime?.review, "review" in planned && planned.review?.mode === "skip" ? "skipped" : "pending", runtime ? this.reportId("review", planned.id) : undefined),
				...(state?.metrics.stageBreakdown?.[planned.id] ? { timing: state.metrics.stageBreakdown[planned.id] } : {}),
			};
		});
	}
	private overview(state: SafeState): WorkflowOverview {
		const stages = state.stages; const tasks = stages.flatMap((stage) => stage.tasks);
		const operations: SafeOperation[] = stages.flatMap((stage) => [...stage.tasks, stage.integration, stage.verification, stage.review]);
		operations.push(state.finalReview, state.e2e);
		const current = stages.find((stage) => stage.status === "running" || stage.status === "attention");
		let currentPhase: WorkflowMetricCategory | undefined;
		if (current?.tasks.some((task) => !["pending", "completed"].includes(task.status))) currentPhase = "implementation";
		else if (current && !["pending", "completed"].includes(current.integration.status)) currentPhase = "integration";
		else if (current && !["pending", "completed"].includes(current.verification.status)) currentPhase = "verification";
		else if (current && !["pending", "completed", "skipped"].includes(current.review.status)) currentPhase = "review";
		else if (!["pending", "completed", "skipped"].includes(state.finalReview.status)) currentPhase = "review";
		else if (!["pending", "completed"].includes(state.e2e.status)) currentPhase = "e2e";
		else currentPhase = state.metrics.activeCategory;
		const attentionOperation = operations.find((operation) => operation.status === "attention");
		const attention = state.attention ?? attentionOperation?.failure ?? attentionOperation?.result;
		const checks = operations.flatMap((operation) => operation.checks ?? []);
		const taskTotals = { completed: tasks.filter((task) => task.status === "completed").length, total: tasks.length, active: tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status)).length, attention: tasks.filter((task) => task.status === "attention").length };
		const checkTotals = this.checkAggregate(checks); const findingTotals = this.findingCounts([...stages.map((stage) => stage.review), state.finalReview]);
		const attentionCounts = { tasks: taskTotals.attention, checks: checkTotals.failed, findings: findingTotals.total, total: taskTotals.attention + checkTotals.failed + findingTotals.total };
		return {
			status: state.status, ...(state.outcomeStatus ? { outcomeStatus: state.outcomeStatus } : {}),
			totals: { tasks: taskTotals, repairs: operations.reduce((total, operation) => total + operation.repairCount, 0), checks: checkTotals, findings: findingTotals }, attention: attentionCounts,
			...(current ? { currentStageId: current.id } : {}), ...(currentPhase ? { currentPhase } : {}), evidenceCount: state.e2e.evidenceRefs.length,
			metrics: state.metrics, ...(attention ? { topAttention: attention } : {}),
		};
	}
	private documents(storyId: string, bundle: CurrentBundle, outcomeAvailable: boolean): DocumentSummary[] {
		const base = `agent-artifacts/${storyId}`; const docs: DocumentSummary[] = bundle.story ? [
			{ id: "story-spec", title: "Story specification", type: "spec", group: "Specifications", path: `${base}/story.yaml`, status: "authored", available: true, diagnostics: [] },
			{ id: "story-design", title: "Story design", type: "design", group: "Design", path: `${base}/story.yaml`, status: "authored", available: true, diagnostics: [] },
			{ id: "story-e2e", title: "E2E contract", type: "e2e-matrix", group: "Journey cases", path: `${base}/story.yaml`, status: "authored", available: true, diagnostics: [] },
		] : [];
		if (outcomeAvailable) docs.push({ id: "outcome", title: "Outcome", type: "outcome", group: "Outcome", path: `${base}/outcome.md`, status: "written", available: true, diagnostics: [] });
		return orderDocuments(docs);
	}
	async readWorkspace(storyId: string, root: string): Promise<StoryWorkspace> {
		const bundle = await this.bundle(storyId, root); const outcomePath = join(root, "outcome.md"); const outcomeAuthorized = bundle.state?.outcomeStatus === "written"; const outcomeAvailable = outcomeAuthorized && await regularFile(outcomePath, root, this.repositoryRoot); if (outcomeAuthorized && !outcomeAvailable) bundle.diagnostics.push(diagnostic(`agent-artifacts/${storyId}/outcome.md`, "Written outcome is missing or is not a contained regular file")); const story = await this.summaryFromBundle(storyId, bundle); const reports = this.reports(bundle.state); const taskReports = new Map(reports.filter((report) => report.taskId).map((report) => [report.taskId!, [report.id]]));
		const runtimeTaskIds = new Set(bundle.state?.stages.flatMap((stage) => stage.tasks.map((task) => task.id)) ?? []); const visibleTasks = bundle.state ? bundle.tasks.filter((task) => runtimeTaskIds.has(task.id)) : bundle.tasks;
		const tasks = orderTaskCards(visibleTasks.map((task) => { const stage = this.taskStage(task.id, bundle.plan, bundle.state); const relatedReportIds = taskReports.get(task.id); const taskPath = `agent-artifacts/${storyId}/tasks/${task.id}.yaml`; const taskDiagnostics = bundle.diagnostics.filter((item) => item.path === taskPath); return projectTaskCard({ id: task.id, title: task.title, status: this.taskStatus(task.id, bundle.state), dependsOn: task.dependsOn, ...(stage ? { stage } : {}), ...(relatedReportIds ? { relatedReportIds } : {}), diagnostics: taskDiagnostics }); }));
		const columns = { "To do": [] as TaskCard[], "In progress": [] as TaskCard[], Done: [] as TaskCard[] }; for (const task of tasks) columns[task.column].push(task);
		const documents = this.documents(storyId, bundle, outcomeAvailable); const groups = new Map<DocumentGroup, DocumentSummary[]>(); for (const document of documents) groups.set(document.group, [...(groups.get(document.group) ?? []), document]);
		const documentGroups = (["Intent and scope", "Specifications", "Design", "Decisions", "Journey cases", "Outcome"] as DocumentGroup[]).flatMap((group) => groups.has(group) ? [{ group, documents: groups.get(group)! }] : []);
		return {
			story, ...(bundle.state ? { workflow: this.overview(bundle.state) } : {}), stages: this.stages(bundle.plan, bundle.state, bundle.tasks),
			...(bundle.state ? { finalReview: this.reviewOperation(bundle.state.finalReview, "pending", "final-review"), finalE2E: this.operation(bundle.state.e2e, "final-e2e") } : {}),
			columns, tasks, documentGroups, reports, diagnostics: bundle.diagnostics,
		};
	}
	private async summaryFromBundle(storyId: string, bundle: CurrentBundle): Promise<StorySummary> { const taskCount = bundle.state ? new Set(bundle.state.stages.flatMap((stage) => stage.tasks.map((task) => task.id))).size : bundle.tasks.length; return { ...projectStorySummary({ id: storyId, title: bundle.story?.title, intentExcerpt: bundle.story ? excerpt(bundle.story.spec) : "", kind: bundle.story?.kind, phase: bundle.state?.status === "completed" ? "complete" : bundle.state ? "execution" : bundle.plan ? "planning" : "shaping", state: bundle.state?.status ?? "authored", taskCount, reportCount: this.reportCount(bundle.state), diagnostics: bundle.diagnostics }), format: "current" }; }
	async readTaskDetail(storyId: string, root: string, taskId: string): Promise<TaskDetail | undefined> {
		const diagnostics: Diagnostic[] = []; const task = await this.readTask(storyId, root, taskId, diagnostics); const plan = await this.readPlan(storyId, root, diagnostics); const state = await this.readState(storyId, root, diagnostics); if (!task) return undefined; const runtimeTask = state?.stages.flatMap((item) => item.tasks).find((item) => item.id === task.id); if (state && !runtimeTask) return undefined;
		if (state?.contracts.tasks[task.id] && contractDigest(task) !== state.contracts.tasks[task.id]) diagnostics.push(diagnostic(`agent-artifacts/${storyId}/tasks/${task.id}.yaml`, "Task content differs from the authoritative runtime contract"));
		const status = this.taskStatus(task.id, state); const stage = this.taskStage(task.id, plan, state); const card = projectTaskCard({ id: task.id, title: task.title, status, dependsOn: task.dependsOn, stage, relatedReportIds: runtimeTask ? [this.reportId("task", task.id)] : [], diagnostics });
		const runtimeStage = state?.stages.find((item) => item.tasks.some((candidate) => candidate.id === task.id)); const completedCommit = runtimeTask?.contributionCommit; const mergedCommit = runtimeStage?.integration.integratedCommit;
		return { ...card, brief: task.description, scope: task.scope, delivery: task.delivery, assignment: { agent: task.assignment.agent, tier: task.assignment.tier, rationale: task.assignment.rationale }, verification: { methods: [], taskChecks: task.checks.map((check) => typeof check === "string" ? check : check.command) }, ...(completedCommit || mergedCommit ? { deliveryHistory: { ...(completedCommit ? { completedCommit } : {}), ...(mergedCommit ? { mergedCommit } : {}) } } : {}) };
	}
	async readDocumentDetail(storyId: string, root: string, documentId: string): Promise<DocumentDetail | undefined> {
		const diagnostics: Diagnostic[] = []; const story = await this.readStory(storyId, root, diagnostics); if (story) {
			const values: Record<string, { title: string; type: string; group: DocumentGroup; body: string }> = { "story-spec": { title: "Story specification", type: "spec", group: "Specifications", body: story.spec }, "story-design": { title: "Story design", type: "design", group: "Design", body: story.design }, "story-e2e": { title: "E2E contract", type: "e2e-matrix", group: "Journey cases", body: story.e2e } }; const value = values[documentId]; if (value) return { id: documentId, ...value, path: `agent-artifacts/${storyId}/story.yaml`, status: "authored", available: true, diagnostics: [], title: titleFromMarkdown(value.body, value.title) };
		}
		if (documentId !== "outcome") return undefined; const stateDiagnostics: Diagnostic[] = []; const state = await this.readState(storyId, root, stateDiagnostics); if (state?.outcomeStatus !== "written") return undefined; const path = join(root, "outcome.md"); if (!(await regularFile(path, root, this.repositoryRoot))) return undefined; const body = await readFile(path, "utf8"); return { id: "outcome", title: titleFromMarkdown(body, "Outcome"), type: "outcome", group: "Outcome", path: `agent-artifacts/${storyId}/outcome.md`, status: "written", available: true, diagnostics: [], body };
	}
	private body(title: string, status: string, value: SafeOperation): string {
		const lines = [`# ${title}`, "", `Status: **${status}**.`]; const result = value.result ?? value.failure; if (result) lines.push("", `**${result.code}:** ${result.summary}`); if (value.checks?.length) lines.push("", "## Checks", ...value.checks.map((check) => `- ${check.id}: ${check.status}${check.failure ? ` — ${check.failure.summary}` : ""}`)); return lines.join("\n");
	}
	async readReportDetail(storyId: string, root: string, reportId: string): Promise<ReportDetail | undefined> {
		const diagnostics: Diagnostic[] = []; const state = await this.readState(storyId, root, diagnostics); if (!state) return undefined; let summaryReport = this.reports(state).find((report) => report.id === reportId); if (!summaryReport) return undefined;
		let value: SafeOperation; let title = reportId; let findings: Finding[] = []; let acceptedRisks: SafeReview["acceptedRisks"] = [];
		if (reportId === "final-review") { value = state.finalReview; title = "Whole-branch review"; findings = state.finalReview.currentFindings; acceptedRisks = state.finalReview.acceptedRisks; }
		else if (reportId === "final-e2e") { value = state.e2e; title = "Final E2E"; }
		else if (summaryReport.scope.kind === "task" && summaryReport.taskId) { const task = state.stages.flatMap((stage) => stage.tasks).find((item) => item.id === summaryReport.taskId); if (!task) return undefined; value = task; title = `Task ${task.id}`; }
		else { const stage = state.stages.find((item) => item.id === summaryReport.scope.id); if (!stage) return undefined; if (reportId.endsWith("-integration")) { value = stage.integration; title = `Stage ${stage.id} integration`; } else if (reportId.endsWith("-verification")) { value = stage.verification; title = `Stage ${stage.id} verification`; } else { value = stage.review; title = `Stage ${stage.id} review`; findings = stage.review.currentFindings; acceptedRisks = stage.review.acceptedRisks; } }
		const evidence = reportId === "final-e2e" ? await readCurrentEvidenceMetadata(this.repositoryRoot, storyId, state.e2e.evidenceRefs) : [];
		const riskAcceptance = acceptedRisks.length ? ["# Accepted risks", "", ...acceptedRisks.map((risk) => `- ${risk.findingId}: ${risk.rationale}`)].join("\n") : undefined;
		return { ...summaryReport, body: this.body(title, value.status, value), findings, ...(riskAcceptance ? { riskAcceptance } : {}), history: [], evidence };
	}
}
