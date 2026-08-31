import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentProgress } from "../subagent/agent-progress.js";
import type { WorkflowMetrics, WorkflowSnapshot, WorkflowStep } from "./api.js";

const RUNNING_FRAMES: Record<string, readonly string[]> = {
	task: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	merge: ["⇢", "→", "⇢", "⇒"],
	verification: ["◐", "◓", "◑", "◒"],
	evaluation: ["◐", "◓", "◑", "◒"],
};

const displayProgress = (step: WorkflowStep, status: WorkflowStep["status"]): string =>
	status === "running" ? formatAgentProgress(step.progress, Date.now(), { showStarting: step.kind === "task" || step.kind === "evaluation" }) : "";
const stateRank = (status: WorkflowStep["status"]): number => status === "attention" ? 5 : status === "running" ? 4 : status === "ready" ? 3 : status === "pending" ? 2 : status === "done" ? 1 : 5;
const stateIcon = (status: WorkflowStep["status"], kind: string, frame: number): string => {
	if (status === "running") { const frames = RUNNING_FRAMES[kind] ?? RUNNING_FRAMES.task!; return frames[frame % frames.length]!; }
	return status === "attention" ? "⚠" : status === "ready" ? "◆" : status === "pending" ? "·" : status === "done" ? "✓" : "–";
};
const visualStatus = (step: WorkflowStep): WorkflowStep["status"] =>
	step.status === "running" ? step.status : ["verification-failed", "candidate-ci-failed", "integration-conflict"].includes(step.phase ?? "") ? "attention" : step.phase === "contribution-ready" ? "ready" : step.status;
const stepLabel = (step: WorkflowStep): string => {
	if (step.kind === "task") return step.status === "done" ? "Implemented" : "Implementing";
	if (step.kind !== "merge") return step.kind;
	if (step.status === "done" || step.phase === "integrated") return "Integrated";
	if (step.status === "running") {
		if (step.phase === "verifying-candidate") return "Verifying candidate";
		if (step.phase === "repairing-candidate" || step.phase === "candidate-ci-failed") return "Repairing candidate CI";
		if (step.phase === "integration-conflict") return "Resolving candidate conflict";
		return "Assembling candidate";
	}
	if (step.phase === "integration-conflict") return "Candidate conflict";
	if (step.phase === "candidate-ci-failed") return "Candidate CI failed";
	if (step.phase === "verification-failed") return "Verification failed";
	if (step.detail === "waiting for stage merge barrier") return "Waiting for shared merge barrier";
	if (step.phase === "contribution-ready") return "Contribution ready";
	return "Ready to integrate";
};

function rawTaskLines(snapshot: WorkflowSnapshot, ctx: ExtensionContext, frame: number, includeProgress = true): string[] {
	const done = snapshot.steps.filter((step) => step.status === "done").length;
	const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
	for (const step of snapshot.steps) {
		const color = step.status === "done" ? "success" : step.status === "attention" ? "error" : step.status === "running" ? "accent" : "muted";
		const progress = includeProgress ? displayProgress(step, step.status) : "";
		const liveStatus = [step.fast ? "Fast" : "", progress].filter(Boolean).join(" · ");
		lines.push(`${ctx.ui.theme.fg(color, `${stateIcon(step.status, step.kind, frame)} `)}${step.title}`);
		if (liveStatus) lines.push(`  ${ctx.ui.theme.fg("dim", liveStatus)}`);
	}
	return lines;
}

function stageTaskLines(snapshot: WorkflowSnapshot, ctx: ExtensionContext, frame: number, includeProgress = true): string[] {
	if (!snapshot.stages?.length) return rawTaskLines(snapshot, ctx, frame, includeProgress);
	const done = snapshot.steps.filter((step) => step.status === "done").length;
	const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
	for (const stage of snapshot.stages) {
		const stageSteps = snapshot.steps.filter((step) => stage.nodes.some((node) => step.ref.endsWith(`/${node}`)));
		const primary = stageSteps.reduce<WorkflowStep | undefined>((best, step) => !best || stateRank(step.status) > stateRank(best.status) ? step : best, undefined);
		const stageStatus = primary?.status ?? "pending";
		const reviewSteps = stageSteps.filter((step) => step.kind === "evaluation");
		const mergeSteps = stageSteps.filter((step) => step.kind === "merge");
		const reviewActive = reviewSteps.some((step) => ["running", "ready", "attention"].includes(step.status));
		const implementationActive = !reviewActive && stageSteps.some((step) => step.kind === "task" && ["running", "ready", "attention"].includes(step.status));
		const integrationActive = !reviewActive && !implementationActive && mergeSteps.some((step) => !["done", "cancelled"].includes(step.status));
		const runningMerge = mergeSteps.find((step) => step.status === "running");
		const failedMerge = !runningMerge ? mergeSteps.find((step) => ["verification-failed", "candidate-ci-failed", "integration-conflict"].includes(step.phase ?? "")) : undefined;
		const failureLabel = failedMerge?.phase === "integration-conflict" ? "Candidate conflict" : failedMerge?.phase === "candidate-ci-failed" ? "Candidate CI failed" : "Verification failed";
		const verifying = runningMerge?.phase === "verifying-candidate";
		const runtimeStage = stage.group === "runtime";
		const runtimeLoop = primary?.checkpoint === "final-e2e" ? "E2E journey/fix loop" : primary?.checkpoint === "final-review" ? "Whole-branch review/fix loop" : "Final validation queued";
		const lifecycle = runtimeStage
			? stageStatus === "done" ? "Validated" : `${runtimeLoop}${stageStatus === "attention" ? " needs attention" : ""}`
			: stageStatus === "attention" ? "Needs attention" : stageStatus === "done" ? "Integrated" : reviewActive ? "Reviewing" : implementationActive ? "Implementing" : failedMerge ? failureLabel : verifying ? "Verifying candidate" : runningMerge ? "Assembling / repairing candidate" : integrationActive ? "Ready to integrate" : "Queued";
		const stageVisualStatus = failedMerge ? "attention" : stageStatus;
		const stageColor = stageVisualStatus === "attention" ? "error" : implementationActive || integrationActive || reviewActive ? "accent" : stageStatus === "done" ? "success" : "muted";
		const title = runtimeStage ? "Final validation" : `Stage ${stage.index + 1} · ${stage.id}`;
		const unitCount = runtimeStage ? stageSteps.length : stageSteps.filter((step) => step.kind === "task" || step.kind === "merge").length;
		const unitName = runtimeStage ? "gate" : "task";
		lines.push(ctx.ui.theme.fg(stageColor, `${stateIcon(stageVisualStatus, verifying ? "verification" : primary?.kind ?? "task", frame)} ${stage.parallel ? "⇉" : "→"} ${title} · ${lifecycle} · ${unitCount} ${unitName}${unitCount === 1 ? "" : "s"}`));
		if (implementationActive || integrationActive) {
			for (const step of stageSteps.filter((candidate) => candidate.kind !== "evaluation")) {
				const waitingOnActiveBarrier = step.detail === "waiting for stage merge barrier" && Boolean(runningMerge);
				const shownStatus = waitingOnActiveBarrier ? "running" : visualStatus(step);
				const color = shownStatus === "done" ? "success" : shownStatus === "attention" ? "error" : shownStatus === "running" || shownStatus === "ready" ? "accent" : "muted";
				const progress = includeProgress ? displayProgress(step, step.status) : "";
				const liveStatus = [step.fast ? "Fast" : "", progress].filter(Boolean).join(" · ");
				lines.push(`  ${ctx.ui.theme.fg(color, `${stateIcon(shownStatus, step.status === "running" && step.phase === "verifying-candidate" ? "verification" : step.kind, frame)} `)}${stepLabel(step)} · ${step.title}`);
				if (liveStatus) lines.push(`    ${ctx.ui.theme.fg("dim", liveStatus)}`);
			}
		} else if (reviewActive) {
			for (const step of reviewSteps) {
				const phase = step.title.includes(" · ") ? step.title.split(" · ").pop()! : undefined;
				const legacyFix = !phase && /fixing\s*·\s*iteration\s*(\d+)/i.exec(step.detail ?? "");
				const queuedFix = step.status === "running" && /fix requested/i.test(phase ?? step.detail ?? "") ? /iteration\s+(\d+)\//i.exec(step.detail ?? "") : undefined;
				const label = (runtimeStage ? step.title : queuedFix ? `Fix #${Math.max(2, Number(queuedFix[1]) + 1)}` : phase ?? (legacyFix ? `Fix #${Math.max(2, Number(legacyFix[1]) + 1)}` : /fix requested/i.test(step.detail ?? "") ? "Fix requested" : step.title)).replace(/^Fixing (#[0-9]+)$/, "Fix $1");
				const progress = includeProgress ? displayProgress(step, step.status) : "";
				const liveStatus = [step.fast ? "Fast" : "", progress].filter(Boolean).join(" · ");
				lines.push(`  ${ctx.ui.theme.fg(step.status === "attention" ? "error" : step.status === "done" ? "success" : "accent", `${stateIcon(step.status, step.kind, frame)} `)}${label}`);
				if (liveStatus) lines.push(`    ${ctx.ui.theme.fg("dim", liveStatus)}`);
			}
		}
	}
	return lines;
}

const metricDuration = (milliseconds: number): string => {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${seconds % 60}s`;
};
const projectedMetric = (metrics: WorkflowMetrics, base: number, activeIntervals: number, now = Date.now()): number =>
	!metrics.live || activeIntervals <= 0 ? base : base + Math.max(0, now - metrics.live.sampledAtMs) * activeIntervals;
const metricRows = (snapshot: WorkflowSnapshot): Array<readonly [string, string]> => {
	const metrics = snapshot.metrics!;
	return [
		["Total time", metricDuration(projectedMetric(metrics, metrics.runningMs, metrics.live?.running ? 1 : 0))],
		["Implementer", metricDuration(projectedMetric(metrics, metrics.implementerMs ?? 0, metrics.live?.activeImplementers ?? 0))],
		["Reviewer", metricDuration(projectedMetric(metrics, metrics.reviewerMs ?? 0, metrics.live?.activeReviewers ?? 0))],
		["Fixer", metricDuration(projectedMetric(metrics, metrics.fixerMs ?? 0, metrics.live?.activeFixers ?? 0))],
		["E2E", metricDuration(projectedMetric(metrics, metrics.e2eAgentMs ?? 0, metrics.live?.activeE2e ?? 0))],
		["Deterministic steps", metricDuration(projectedMetric(metrics, metrics.deterministicMs ?? metrics.verificationMs, metrics.live?.activeVerifications ?? 0))],
		["Orchestrator", metricDuration(projectedMetric(metrics, metrics.orchestrationMs ?? 0, metrics.live?.orchestrator ? 1 : 0))],
		["Harness scheduling", metricDuration(projectedMetric(metrics, metrics.harnessSchedulingMs ?? 0, metrics.live?.activeScheduling ?? 0))],
		[snapshot.repairLoop?.label ?? "Current fix loop", snapshot.repairLoop ? `${snapshot.repairLoop.iteration} / ${snapshot.repairLoop.maxIterations}` : "—"],
	];
};

/** Pure TUI projection of a runner-owned snapshot. */
export function workflowDashboardLines(snapshot: WorkflowSnapshot, ctx: ExtensionContext, width: number, frame = 0): string[] {
	const innerWidth = Math.max(1, width - 2);
	const tasks = stageTaskLines(snapshot, ctx, frame, true);
	const structuralTasks = stageTaskLines(snapshot, ctx, frame, false);
	const naturalTaskWidth = Math.max(...structuralTasks.map((task) => visibleWidth(task)));
	const compactTaskWidth = Math.min(naturalTaskWidth, Math.max(28, Math.floor(innerWidth * 0.58)));
	const metricWidth = innerWidth - compactTaskWidth - 3;
	const showMetrics = Boolean(snapshot.metrics && innerWidth >= 72 && metricWidth >= 24);
	const taskWidth = showMetrics ? compactTaskWidth : innerWidth;
	const metrics = showMetrics ? metricRows(snapshot) : [];
	const rowCount = showMetrics ? Math.max(tasks.length, metrics.length) : tasks.length;
	return Array.from({ length: rowCount }, (_, index) => {
		const left = truncateToWidth(tasks[index] ?? "", taskWidth, "…");
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
		return ctx.ui.theme.bg("customMessageBg", ` ${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))} `);
	});
}
