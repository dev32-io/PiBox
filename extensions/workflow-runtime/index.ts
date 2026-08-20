import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { inferDynamicSubagentTier, WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, WORKFLOW_FEEDBACK_EVENT, type DynamicSubagentRequest, type DynamicSubagentStarted, type SpawnableAgentDefinition, type WorkflowAdapter, type WorkflowAdapterDiscovery, type WorkflowControlEvent, type WorkflowFeedbackEvent, type WorkflowLifecycleUpdate, type WorkflowMetrics, type WorkflowRunResult, type WorkflowSnapshot, type WorkflowStep } from "./api.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { formatBackgroundSubagentStatus, SUBAGENT_PULSE_INTERVAL_MS, subagentPulseDot } from "./subagent-display.js";
import { activateWorkflowBypass, confirmWorkflowBypass } from "../permissions/runtime.js";
import { formatAgentProgress, initialAgentProgress, type AgentProgress } from "./agent-progress.js";
import { DEFAULT_SUBAGENT_STATUS_LIMIT, MAX_SUBAGENT_STATUS_LIMIT, projectSubagentStatus, subagentStatusEmptyText, type SubagentStatusFilters } from "./subagent-status.js";
import { renderWorkflowEventMessage } from "./workflow-event-display.js";

const TOOL_NAMES = ["workflow_start", "workflow_control", "workflow_checkpoint", "subagent_spawn", "subagent_status", "subagent_control", "subagent_respond"];
const RUNNING_FRAMES: Record<string, readonly string[]> = {
	task: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	merge: ["⇢", "→", "⇢", "⇒"],
	verification: ["◐", "◓", "◑", "◒"],
	evaluation: ["◐", "◓", "◑", "◒"],
};
const DEFAULT_RUNNING_FRAMES = RUNNING_FRAMES.task!;
const SUBAGENT_STATUS_KEY = "subagent-dashboard";

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

type WorkflowNotice = { workflowRef: string; title: string; detail?: string; attention: boolean; kind?: string; fromStatus?: string; toStatus?: string; nextAction?: string };
type RunningSubagentStatus = {
	agent: string;
	mode: "background" | "foreground";
	startedAt: number;
	tier?: string;
	resolved?: DynamicSubagentStarted;
	progress?: AgentProgress;
};

export default function workflows(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pibox-workflow-event", renderWorkflowEventMessage);

	const adapters: WorkflowAdapter[] = [];
	const active = new Map<string, "running" | "paused">();
	const ownership = new Map<string, number>();
	const inFlight = new Map<string, number>();
	const inFlightProgress = new Map<string, AgentProgress>();
	let currentRef: string | undefined;
	let currentSnapshot: WorkflowSnapshot | undefined;
	let subagentPulseTimer: NodeJS.Timeout | undefined;
	let ticking = false;
	let frame = 0;
	let subagentPulseFrame = 0;
	let sessionCtx: ExtensionContext | undefined;
	let visualTimer: NodeJS.Timeout | undefined;
	let dashboardTui: { requestRender?: () => void } | undefined;
	let dashboardInvalidate: (() => void) | undefined;
	const runningSubagents = new Map<string, RunningSubagentStatus>();
	const lifecycleSubscriptions = new Map<string, { controller: AbortController; unsubscribe: (() => void) | undefined }>();
	let tickRequested = false;
	let runtimeEpoch = 0;
	let shuttingDown = false;

	const adapterFor = (ref: string): WorkflowAdapter => {
		// Discovery is deliberately repeatable: extensions may load after the
		// session-start hook (notably during reloads and tests).
		if (adapters.length === 0) pi.events.emit(WORKFLOW_ADAPTER_DISCOVERY_EVENT, { register(adapter: WorkflowAdapter) { if (!adapters.some((candidate) => candidate.id === adapter.id)) adapters.push(adapter); } } satisfies WorkflowAdapterDiscovery);
		const adapter = adapters.find((candidate) => candidate.canHandle(ref));
		if (!adapter) throw new Error(`No workflow adapter accepts ${ref}`);
		return adapter;
	};

	const dynamicAdapter = (): WorkflowAdapter => {
		const capable = adapters.filter((adapter) => adapter.spawnSubagent);
		if (capable.length === 0) throw new Error("No workflow adapter provides dynamic subagent spawning");
		if (capable.length > 1) throw new Error(`Dynamic subagent spawning is ambiguous across adapters: ${capable.map((adapter) => adapter.id).join(", ")}`);
		return capable[0]!;
	};

	const persist = (ref: string, state: "running" | "paused" | "stopped") => {
		try { pi.appendEntry("pibox-workflow", { ref, state, at: new Date().toISOString() }); }
		catch { /* Session replacement leaves adapter-owned durable state authoritative. */ }
	};

	const sendFeedback = (event: WorkflowFeedbackEvent) => {
		try { pi.events.emit(WORKFLOW_FEEDBACK_EVENT, event); }
		catch { /* Session replacement leaves durable workflow state authoritative. */ }
	};

	const pauseDurably = async (adapter: WorkflowAdapter, ref: string, operationId: string, ctx: ExtensionContext) => {
		if (active.get(ref) !== "running") return;
		const control = await adapter.controlExecution?.(ref, "pause", operationId, ctx).catch(() => undefined);
		if (control) ownership.set(ref, control.generation);
		active.set(ref, "paused");
		persist(ref, "paused");
	};

	const renderSubagentStatus = () => {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		if (runningSubagents.size === 0) {
			ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
			return;
		}
		const dot = subagentPulseDot(subagentPulseFrame);
		const lines = [...runningSubagents.values()].map((status) => {
			const liveStatus = formatBackgroundSubagentStatus(status);
			return `${ctx.ui.theme.fg("warning", dot)} ${ctx.ui.theme.fg("text", status.agent)} ${ctx.ui.theme.fg("dim", liveStatus)}`;
		});
		ctx.ui.setStatus(SUBAGENT_STATUS_KEY, lines.join("\n"));
	};

	const deliverBackgroundSubagentResult = (agent: string, settled: WorkflowRunResult) => {
		try {
			const summary = bounded(settled.summary || "The subagent returned no report.", 1200);
			const content = renderBuiltInPrompt("background-subagent-result", { agent: bounded(agent, 120), state: settled.state, summary });
			// Keep the canonical report in the adapter; the follow-up is deliberately a
			// small attention packet so a verbose child cannot consume the main context.
			pi.sendMessage({ customType: "pibox-subagent-result", content, display: false, details: { ref: settled.ref, state: settled.state, summary, attention: settled.attention === true } }, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			// The durable subagent record remains available after session replacement or shutdown.
		}
	};

	function bounded(value: unknown, limit = 700): string {
		return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);
	}
	const boundedNotice = (event: WorkflowNotice & { cause?: string; attempt?: number; iteration?: number; correlationId?: string }): WorkflowNotice & { cause?: string; attempt?: number; iteration?: number; correlationId?: string } => ({
		...event,
		title: bounded(event.title, 180),
		...(event.detail ? { detail: bounded(event.detail) } : {}),
		...(event.nextAction ? { nextAction: bounded(event.nextAction, 240) } : {}),
	});

	const sendEvent = (event: WorkflowNotice & { cause?: string; attempt?: number; iteration?: number; correlationId?: string }) => {
		const safe = boundedNotice(event);
		if (sessionCtx) renderDashboard(sessionCtx);
		// Routine lifecycle is a widget concern. Review completion is also a main-
		// session boundary: the orchestrator may need to honor a deferred user
		// instruction before the next stage, and must not remain stuck describing an
		// already-settled review.
		const reviewCompleted = !safe.attention && safe.kind === "evaluation" && safe.toStatus === "done";
		if (!safe.attention && !reviewCompleted) return;
		try {
			const detail = [safe.detail, safe.cause ? `Cause: ${bounded(safe.cause, 120)}` : undefined, safe.nextAction ? `Next: ${safe.nextAction}` : undefined].filter(Boolean).join("\n");
			pi.sendMessage({ customType: "pibox-workflow-event", content: `[${safe.attention ? "Workflow attention" : "Workflow progress"}]\n${safe.title}${detail ? `\n${detail}` : ""}`, display: true, details: safe }, { deliverAs: safe.attention ? "steer" : "followUp", triggerTurn: true });
		} catch {
			// A replacement or closing session will reconcile from durable adapter state.
		}
	};

	const displayStatus = (step: WorkflowStep): WorkflowStep["status"] => inFlight.has(step.ref) && step.status !== "done" ? "running" : step.status;
	const displayProgress = (step: WorkflowStep, status: WorkflowStep["status"]): string =>
		status === "running" ? formatAgentProgress(step.progress ?? inFlightProgress.get(step.ref)) : "";
	const stateRank = (status: WorkflowStep["status"]): number => status === "attention" ? 5 : status === "running" ? 4 : status === "ready" ? 3 : status === "pending" ? 2 : status === "done" ? 1 : 5;
	const stateIcon = (status: WorkflowStep["status"], kind: string): string => {
		if (status === "running") { const frames = RUNNING_FRAMES[kind] ?? DEFAULT_RUNNING_FRAMES; return frames[frame % frames.length]!; }
		return status === "attention" ? "⚠" : status === "ready" ? "◆" : status === "pending" ? "·" : status === "done" ? "✓" : "–";
	};
	const visualStatus = (step: WorkflowStep, status = displayStatus(step)): WorkflowStep["status"] =>
		status === "running" ? status : step.phase === "verification-failed" ? "attention" : step.phase === "contribution-ready" ? "ready" : status;
	const stepLabel = (step: WorkflowStep, status: WorkflowStep["status"]): string => {
		if (step.kind === "task") return status === "done" ? "Implemented" : "Implementing";
		if (step.kind !== "merge") return step.kind;
		if (status === "done" || step.phase === "integrated") return "Integrated";
		if (status === "running") return step.phase === "verifying-candidate" ? "Verifying candidate" : "Assembling candidate";
		if (step.phase === "verification-failed") return "Verification failed";
		if (step.phase === "contribution-ready") return "Contribution ready";
		return "Ready to integrate";
	};

	const rawTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, includeProgress = true): string[] => {
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const step of snapshot.steps) {
			const status = displayStatus(step);
			const icon = stateIcon(status, step.kind);
			const color: "success" | "warning" | "error" | "muted" | "accent" = status === "done" ? "success" : status === "attention" ? "error" : status === "running" ? "accent" : "muted";
			const progress = includeProgress ? displayProgress(step, status) : "";
			const liveSuffix = [progress, step.fast ? "Fast" : ""].filter(Boolean).join(" · ");
			lines.push(`${ctx.ui.theme.fg(color, `${icon} `)}${step.title}${liveSuffix ? ` · ${ctx.ui.theme.fg("dim", liveSuffix)}` : ""}`);
		}
		return lines;
	};

	const stageTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, includeProgress = true): string[] => {
		if (!snapshot.stages?.length) return rawTaskLines(snapshot, ctx, includeProgress);
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const stage of snapshot.stages) {
			const stageSteps = snapshot.steps.filter((step) => stage.nodes.some((node) => step.ref.endsWith(`/${node}`)));
			const primary = stageSteps.reduce<WorkflowStep | undefined>((best, step) => !best || stateRank(displayStatus(step)) > stateRank(displayStatus(best)) ? step : best, undefined);
			const stageStatus = primary ? displayStatus(primary) : "pending";
			const reviewSteps = stageSteps.filter((step) => step.kind === "evaluation");
			const mergeSteps = stageSteps.filter((step) => step.kind === "merge");
			const reviewActive = reviewSteps.some((step) => step.status === "running" || step.status === "ready" || step.status === "attention" || inFlight.has(step.ref));
			const implementationActive = !reviewActive && stageSteps.some((step) => step.kind === "task" && (step.status === "running" || step.status === "ready" || step.status === "attention" || inFlight.has(step.ref)));
			const integrationActive = !reviewActive && !implementationActive && mergeSteps.some((step) => !["done", "cancelled"].includes(step.status) || inFlight.has(step.ref));
			const runningMerge = mergeSteps.find((step) => displayStatus(step) === "running");
			const verificationFailed = !runningMerge && mergeSteps.some((step) => step.phase === "verification-failed");
			const verifying = runningMerge?.phase === "verifying-candidate";
			const stageVisualStatus = verificationFailed ? "attention" : stageStatus;
			const runtimeStage = stage.group === "runtime";
			const runtimeLoop = primary?.checkpoint === "final-e2e" ? "E2E journey/fix loop" : primary?.checkpoint === "final-review" ? "Whole-branch review/fix loop" : "Final validation queued";
			const lifecycle = runtimeStage
				? stageStatus === "done" ? "Validated" : `${runtimeLoop}${stageStatus === "attention" ? " needs attention" : ""}`
				: stageStatus === "attention" ? "Needs attention" : stageStatus === "done" ? "Integrated" : reviewActive ? "Reviewing" : implementationActive ? "Implementing" : verificationFailed ? "Verification failed" : verifying ? "Verifying candidate" : runningMerge ? "Assembling candidate" : integrationActive ? "Ready to integrate" : "Queued";
			const topology = stage.parallel ? "⇉" : "→";
			const stageColor: "error" | "accent" | "muted" | "success" = stageVisualStatus === "attention" ? "error" : implementationActive || integrationActive || reviewActive ? "accent" : stageStatus === "done" ? "success" : "muted";
			const title = runtimeStage ? "Final validation" : `Stage ${stage.index + 1} · ${stage.id}`;
			const unitCount = runtimeStage ? stageSteps.length : stageSteps.filter((step) => step.kind === "task" || step.kind === "merge").length;
			const unitName = runtimeStage ? "gate" : "task";
			lines.push(ctx.ui.theme.fg(stageColor, `${stateIcon(stageVisualStatus, verifying ? "verification" : primary?.kind ?? "task")} ${topology} ${title} · ${lifecycle} · ${unitCount} ${unitName}${unitCount === 1 ? "" : "s"}`));
			// Only the implementation slice is expanded. Reviews and repairs are a
			// compact sequence of explicit checkpoints, and a passed stage stays closed.
			if (implementationActive || integrationActive) {
				for (const step of stageSteps.filter((candidate) => candidate.kind !== "evaluation")) {
					const status = displayStatus(step);
					const shownStatus = visualStatus(step, status);
					const kind = stepLabel(step, status);
					const color: "success" | "error" | "muted" | "accent" = shownStatus === "done" ? "success" : shownStatus === "attention" ? "error" : shownStatus === "running" || shownStatus === "ready" ? "accent" : "muted";
					const progress = includeProgress ? displayProgress(step, status) : "";
					lines.push(`  ${ctx.ui.theme.fg(color, `${stateIcon(shownStatus, status === "running" && step.phase === "verifying-candidate" ? "verification" : step.kind)} `)}${kind} · ${step.title}${progress ? ` · ${ctx.ui.theme.fg("dim", progress)}` : ""}`);
				}
			} else if (reviewActive) {
				for (const step of reviewSteps) {
					const status = displayStatus(step);
					// The adapter's title is the canonical phase. Do not infer activity
					// from durable-state words here: queued re-review must not become a
					// generic Review #N (or an active re-review) in the dashboard.
					const phase = step.title.includes(" · ") ? step.title.split(" · ").pop()! : undefined;
					// Keep the established compact repair marker in the dashboard while
					// retaining the fuller canonical phase in step titles/events. The
					// detail fallback is only for legacy/third-party adapters without a
					// canonical phase title.
					const legacyFix = !phase && /fixing\s*·\s*iteration\s*(\d+)/i.exec(step.detail ?? "");
					const queuedFix = status === "running" && /fix requested/i.test(phase ?? step.detail ?? "")
						? /iteration\s+(\d+)\//i.exec(step.detail ?? "")
						: undefined;
					const label = (runtimeStage ? step.title : queuedFix ? `Fix #${Math.max(2, Number(queuedFix[1]) + 1)}` : phase ?? (legacyFix ? `Fix #${Math.max(2, Number(legacyFix[1]) + 1)}` : /fix requested/i.test(step.detail ?? "") ? "Fix requested" : step.title)).replace(/^Fixing (#[0-9]+)$/, "Fix $1");
					const progress = includeProgress ? displayProgress(step, status) : "";
					lines.push(`  ${ctx.ui.theme.fg(status === "attention" ? "error" : status === "done" ? "success" : "accent", `${stateIcon(status, step.kind)} `)}${label}${progress ? ` · ${ctx.ui.theme.fg("dim", progress)}` : ""}`);
				}
			}
		}
		return lines;
	};

	const metricDuration = (milliseconds: number): string => {
		const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
	};

	const metricRows = (metrics: WorkflowMetrics): Array<readonly [string, string]> => [
		["Elapsed", metricDuration(metrics.elapsedMs)],
		["Agent time", metricDuration(metrics.agentActiveMs)],
		["Verification", metricDuration(metrics.verificationMs)],
		["Fixes / retries", `${metrics.fixes} / ${metrics.retries}`],
	];

	const dashboardLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, width: number): string[] => {
		const innerWidth = Math.max(1, width - 2);
		const tasks = stageTaskLines(snapshot, ctx, true);
		const structuralTasks = stageTaskLines(snapshot, ctx, false);
		const separatorWidth = 3;
		// Volatile progress and detailed metric values must not move the divider.
		// Its position is controlled only by the workflow's structural left pane.
		const naturalTaskWidth = Math.max(...structuralTasks.map((task) => visibleWidth(task)));
		const maxTaskWidth = Math.max(28, Math.floor(innerWidth * 0.58));
		const compactTaskWidth = Math.min(naturalTaskWidth, maxTaskWidth);
		const availableMetricWidth = innerWidth - compactTaskWidth - separatorWidth;
		const showMetrics = Boolean(snapshot.metrics && innerWidth >= 72 && availableMetricWidth >= 24);
		const taskWidth = showMetrics ? compactTaskWidth : innerWidth;
		const metrics = showMetrics && snapshot.metrics ? metricRows(snapshot.metrics) : [];
		const metricWidth = showMetrics ? availableMetricWidth : 0;
		const separator = ctx.ui.theme.fg("borderMuted", " │ ");
		const rowCount = showMetrics ? Math.max(tasks.length, metrics.length) : tasks.length;
		return Array.from({ length: rowCount }, (_, index) => {
			const task = tasks[index] ?? "";
			const left = truncateToWidth(task, taskWidth, "…");
			let content = left;
			if (showMetrics) {
				const leftPane = `${left}${" ".repeat(Math.max(0, taskWidth - visibleWidth(left)))}`;
				const metric = metrics[index];
				let metricText = "";
				if (metric) {
					const [label, value] = metric;
					const shownValue = truncateToWidth(value, Math.max(1, metricWidth - visibleWidth(label) - 1), "…");
					const gap = " ".repeat(Math.max(1, metricWidth - visibleWidth(label) - visibleWidth(shownValue)));
					metricText = `${ctx.ui.theme.fg("dim", label)}${gap}${ctx.ui.theme.fg("text", shownValue)}`;
				}
				content = `${leftPane}${separator}${metricText}`;
			}
			const padded = `${content}${" ".repeat(Math.max(0, innerWidth - visibleWidth(content)))}`;
			return ctx.ui.theme.bg("customMessageBg", ` ${padded} `);
		});
	};

	const startVisualTimer = () => {
		if (visualTimer || !sessionCtx) return;
		visualTimer = setInterval(() => {
			const visibleActive = Boolean(currentRef && currentSnapshot && (active.has(currentRef) || currentSnapshot.steps.some((step) => step.status === "running" || inFlight.has(step.ref))));
			if (!visibleActive) { clearInterval(visualTimer); visualTimer = undefined; return; }
			frame++;
			dashboardInvalidate?.();
			dashboardTui?.requestRender?.();
		}, 90);
		visualTimer.unref();
	};

	const renderDashboard = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !currentSnapshot) { ctx.ui.setWidget("pibox-workflow", undefined); return; }
		startVisualTimer();
		ctx.ui.setWidget("pibox-workflow", (tui, _theme) => {
			dashboardTui = tui as unknown as { requestRender?: () => void };
			const component = { render(width: number) { return dashboardLines(currentSnapshot!, ctx, width); }, invalidate() {} };
			dashboardInvalidate = component.invalidate;
			return component;
		});
	};

	const settlementIsLive = (workflowRef: string | undefined, epoch: number) => Boolean(
		!shuttingDown && epoch === runtimeEpoch && sessionCtx && workflowRef && active.has(workflowRef),
	);
	const settlementIsCurrent = async (adapter: WorkflowAdapter, workflowRef: string | undefined, epoch: number, generation: number | undefined, ctx: ExtensionContext): Promise<boolean> => {
		if (!settlementIsLive(workflowRef, epoch)) return false;
		if (!workflowRef || generation === undefined || !adapter.assertExecutionCurrent) return true;
		try { await adapter.assertExecutionCurrent(workflowRef, generation, ctx); return settlementIsLive(workflowRef, epoch); }
		catch { return false; }
	};

	const settleStep = async (adapter: WorkflowAdapter, step: WorkflowStep, promise: Promise<WorkflowRunResult>, ctx: ExtensionContext, workflowRef: string | undefined, epoch: number, generation: number | undefined) => {
		try {
			const settled = await promise;
			if (!await settlementIsCurrent(adapter, workflowRef, epoch, generation, ctx)) return;
			const attention = Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed");
			const terminalSnapshot = workflowRef ? await adapter.snapshot(workflowRef, ctx).catch(() => undefined) : undefined;
			if (!await settlementIsCurrent(adapter, workflowRef, epoch, generation, ctx)) return;
			const terminalStep = terminalSnapshot?.steps.find((candidate) => candidate.ref === step.ref);
			sendEvent({ workflowRef: workflowRef ?? step.ref, title: `${terminalStep?.title ?? step.title} · ${settled.state}`, detail: settled.summary, attention, kind: step.kind, ...(terminalStep?.status ? { toStatus: terminalStep.status } : {}), cause: attention ? "step-settled-with-attention" : "step-settled" });
			// Completion feedback is reserved for the canonical merge barrier. A worker
			// handoff is useful progress, but is not task completion yet.
			const taskMerged = step.kind === "merge" && terminalStep?.status === "done";
			const reviewCompleted = step.kind === "evaluation" && terminalStep?.status === "done";
			if (workflowRef && settled.state === "completed" && !attention && (taskMerged || reviewCompleted)) {
				sendFeedback({ type: "task-completed", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, toStatus: taskMerged ? "merged" : "approved", terminal: true });
			}
			if (attention) {
				if (workflowRef) {
					await pauseDurably(adapter, workflowRef, `settlement:${step.ref}:${generation ?? epoch}:attention`, ctx);
					sendFeedback({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, cause: "step-attention", nextAction: "Resolve the step and resume or decide at its checkpoint." });
				}
			}
		} catch (error) {
			if (!await settlementIsCurrent(adapter, workflowRef, epoch, generation, ctx)) return;
			const detail = error instanceof Error ? error.message : String(error);
			if (workflowRef) {
				await pauseDurably(adapter, workflowRef, `settlement:${step.ref}:${generation ?? epoch}:exception`, ctx);
				sendFeedback({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
			}
			sendEvent({ workflowRef: workflowRef ?? step.ref, title: `${step.title} · failed`, detail, attention: true, kind: step.kind, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
		} finally {
			if (inFlight.get(step.ref) === epoch) {
				inFlight.delete(step.ref);
				inFlightProgress.delete(step.ref);
			}
			if (settlementIsLive(workflowRef, epoch)) requestTick(ctx, epoch);
		}
	};

	const startStep = (adapter: WorkflowAdapter, step: WorkflowStep, ctx: ExtensionContext, epoch: number, signal?: AbortSignal): Promise<WorkflowRunResult> => {
		if (inFlight.has(step.ref)) throw new Error(`Step is already running: ${step.ref}`);
		inFlight.set(step.ref, epoch);
		inFlightProgress.set(step.ref, initialAgentProgress(new Date().toISOString()));
		const startTitle = step.checkpoint ? `Starting ${step.title.split(" · ")[0]}` : step.kind === "merge" ? `Assembling integration candidate · ${step.title}` : `Starting ${step.title}`;
		sendEvent({ workflowRef: step.ref.split("/")[0]!, title: startTitle, attention: false, kind: step.kind, toStatus: "running" });
		return adapter.runStep(step.ref, ctx, signal);
	};

	const runnable = (snapshot: WorkflowSnapshot): WorkflowStep[] => {
		const ready = snapshot.steps.filter((step) => step.status === "ready" && !inFlight.has(step.ref));
		const running = snapshot.steps.filter((step) => step.status === "running" || inFlight.has(step.ref));
		if (running.some((step) => step.parallelism === "serial")) return [];
		const serial = ready.find((step) => step.parallelism === "serial");
		if (serial) return running.length === 0 ? [serial] : [];
		const claimed = new Set(running.flatMap((step) => step.resourceClaims));
		const selected: WorkflowStep[] = [];
		for (const step of ready) {
			if (step.resourceClaims.some((claim) => claimed.has(claim))) continue;
			selected.push(step);
			step.resourceClaims.forEach((claim) => claimed.add(claim));
		}
		return selected;
	};

	const requestTick = (ctx: ExtensionContext, epoch = runtimeEpoch) => {
		if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx || !currentRef || !active.has(currentRef)) return;
		void tick(ctx, epoch);
	};

	const tick = async (ctx: ExtensionContext, epoch = runtimeEpoch) => {
		if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx) return;
		if (ticking) { tickRequested = true; return; }
		ticking = true;
		try {
			frame++;
			for (const [ref, state] of active) {
				if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx) return;
				const adapter = adapterFor(ref);
				let snapshot: WorkflowSnapshot;
				try {
					await adapter.reconcileWorkflow?.(ref, ctx);
					snapshot = await adapter.snapshot(ref, ctx);
				}
				catch (error) {
					if (state === "running") {
						const detail = error instanceof Error ? error.message : String(error);
						await pauseDurably(adapter, ref, `snapshot:${ref}:${ownership.get(ref) ?? epoch}:failed`, ctx);
						sendFeedback({ type: "error", workflowRef: ref, title: ref, detail, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
						sendEvent({ workflowRef: ref, title: `${ref} · attention`, detail, attention: true, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
					}
					continue;
				}
				if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx) return;
				if (ref === currentRef) {
					currentSnapshot = { ...snapshot, steps: snapshot.steps.map((step) => inFlight.has(step.ref) && step.status !== "done" ? { ...step, status: "running" } : step) };
					renderDashboard(ctx);
				}
				if (state !== "running") continue;
				// An adapter snapshot can briefly observe canonical settlement between child exit
				// and runStep completion. The in-flight promise remains authoritative until it
				// settles; only attention with no active step should pause the workflow.
				const hasIndependentReadyWork = snapshot.steps.some((step) => step.status === "ready" && !inFlight.has(step.ref));
				const attentionSteps = snapshot.steps.filter((step) => step.status === "attention");
				const actionableAttentionSteps = attentionSteps.filter((step) => step.detail !== "result pending reconciliation");
				if (snapshot.status === "attention" && actionableAttentionSteps.length > 0 && !snapshot.steps.some((step) => inFlight.has(step.ref)) && !hasIndependentReadyWork) {
					const detail = actionableAttentionSteps.map((step) => `${step.ref}: ${step.detail ?? "needs intervention"}`).join("\n");
					await pauseDurably(adapter, ref, `attention:${actionableAttentionSteps.map((step) => step.ref).join(",")}:${ownership.get(ref) ?? epoch}`, ctx);
					const checkpoint = actionableAttentionSteps.find((step) => step.kind === "evaluation");
					const guidance = `${detail || "Workflow needs intervention."}${checkpoint ? `\nUse workflow_checkpoint on ${checkpoint.ref}: Approve (optionally naming accepted risks) or Request changes. Do not manipulate Git or task state manually.` : ""}`;
					sendFeedback({ type: "error", workflowRef: ref, ...(attentionSteps[0] ? { stepRef: attentionSteps[0].ref, kind: attentionSteps[0].kind } : {}), title: snapshot.title, detail: guidance, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
					sendEvent({ workflowRef: ref, title: `${snapshot.title} · attention`, detail: guidance, attention: true, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
					continue;
				}
				if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
					await adapter.controlExecution?.(ref, "complete", `complete:${ref}:${ownership.get(ref) ?? epoch}`, ctx).catch(() => undefined);
					active.delete(ref); ownership.delete(ref); persist(ref, "stopped"); sendEvent({ workflowRef: ref, title: `${snapshot.title} · complete`, detail: "Finished all workflow steps.", attention: false, toStatus: "integrated", cause: "workflow-terminal" });
					const prompt = await adapter.completionPrompt?.(ref, ctx) ?? renderBuiltInPrompt("default-workflow-completion", { workflowRef: ref });
					try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* session recovery can inspect canonical completion state */ }
					continue;
				}
				for (const step of runnable(snapshot)) {
					const promise = startStep(adapter, step, ctx, epoch);
					void settleStep(adapter, step, promise, ctx, ref, epoch, ownership.get(ref));
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (currentRef) sendFeedback({ type: "error", workflowRef: currentRef, title: "Workflow runner", detail, cause: "runner-exception" });
			sendEvent({ workflowRef: currentRef ?? "workflow", title: "Workflow runner · attention", detail, attention: true, cause: "runner-exception" });
		} finally {
			ticking = false;
			if (tickRequested) {
				tickRequested = false;
				if (!shuttingDown && epoch === runtimeEpoch) requestTick(ctx, epoch);
			}
		}
	};

	const watchLifecycle = (ref: string, adapter: WorkflowAdapter, ctx: ExtensionContext) => {
		if (!adapter.subscribeLifecycle) return;
		const previous = lifecycleSubscriptions.get(ref);
		previous?.controller.abort();
		previous?.unsubscribe?.();
		const controller = new AbortController();
		const subscription: { controller: AbortController; unsubscribe: (() => void) | undefined } = { controller, unsubscribe: undefined };
		lifecycleSubscriptions.set(ref, subscription);
		const epoch = runtimeEpoch;
		const listener = (update?: WorkflowLifecycleUpdate) => {
			if (update) sendEvent(update);
			requestTick(ctx, epoch);
		};
		void Promise.resolve(adapter.subscribeLifecycle(ref, ctx, listener, controller.signal)).then((unsubscribe) => {
			if (controller.signal.aborted || shuttingDown || epoch !== runtimeEpoch || lifecycleSubscriptions.get(ref) !== subscription) {
				if (typeof unsubscribe === "function") unsubscribe();
				return;
			}
			subscription.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : undefined;
		}).catch(() => undefined);
	};

	const stopLifecycle = (ref: string) => {
		const subscription = lifecycleSubscriptions.get(ref);
		if (!subscription) return;
		subscription.controller.abort();
		subscription.unsubscribe?.();
		lifecycleSubscriptions.delete(ref);
	};

	pi.registerTool({
		name: "workflow_start", label: "Start Workflow",
		description: "Start deterministic background execution for a reviewed workflow reference after the user explicitly asks to run it. Before launch, PiBox shows a user-owned TUI confirmation and switches the session and spawned subagents to permission bypass mode. The registered adapter refreshes current steps and advances routine ready work.",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, onUpdate, ctx) {
			const started = Date.now();
			const progress = (phase: string) => {
				const text = `${phase} · ${Date.now() - started}ms`;
				onUpdate?.(result(text, { ref: params.ref, phase, elapsedMs: Date.now() - started }));
				if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", text);
			};
			try {
				const confirmed = await confirmWorkflowBypass(ctx, params.ref);
				if (!confirmed) return result(`Workflow start cancelled. ${params.ref} was not launched and permission mode was not changed.`, { ref: params.ref, cancelled: true });
				const adapter = adapterFor(params.ref);
				progress("Validating prerequisites");
				const preflight = await adapter.preflightWorkflow?.(params.ref, ctx);
				if (preflight && !preflight.ok) {
					const detail = preflight.detail ?? "Workflow preflight failed. Resolve the declared prerequisites and retry.";
					sendFeedback({ type: "error", workflowRef: params.ref, title: "Workflow preflight · attention", detail, cause: "preflight-failed", nextAction: "Configure the declared prerequisites without guessing values, then retry workflow_start." });
					sendEvent({ workflowRef: params.ref, title: "Workflow preflight · attention", detail, attention: true, cause: "preflight-failed", nextAction: "Configure the declared prerequisites, then retry workflow_start." });
					return result(detail, { ref: params.ref, attention: true, preflight });
				}
				await adapter.prepareWorkflow?.(params.ref, ctx, (update) => {
					onUpdate?.(result(`${update.phase} · ${update.elapsedMs}ms`, { ref: params.ref, ...update }));
					if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", `${update.phase} · ${update.elapsedMs}ms`);
				});
				progress("Building execution snapshot");
				const snapshot = await adapter.snapshot(params.ref, ctx);
				progress("Starting workflow"); activateWorkflowBypass();
				const control = await adapter.controlExecution?.(params.ref, "start", `tool:${toolCallId}`, ctx);
				if (control) ownership.set(params.ref, control.generation);
				active.set(params.ref, "running"); currentRef = params.ref; currentSnapshot = snapshot; persist(params.ref, "running"); renderDashboard(ctx);
				watchLifecycle(params.ref, adapter, ctx);
				requestTick(ctx);
				if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", undefined);
				return result(`Started workflow ${params.ref} in background with ${snapshot.steps.length} step(s).`, snapshot);
			} catch (error) {
				active.delete(params.ref);
				ownership.delete(params.ref);
				if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", undefined);
				if (currentRef === params.ref) { currentRef = undefined; currentSnapshot = undefined; renderDashboard(ctx); }
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "workflow_control", label: "Control Workflow", description: "Pause, resume, or stop workflow execution. Stop terminates active attempts but preserves adapter-owned work; resume prepares incomplete stopped work and starts fresh attempts.",
		parameters: Type.Object({ ref: Type.String(), action: StringEnum(["pause", "resume", "stop"] as const) }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			const adapter = adapterFor(params.ref);
			// Resume preparation must succeed before publishing running intent. Pause
			// and stop fence first so late settlements cannot race their teardown.
			if (params.action === "resume") await adapter.controlWorkflow(params.ref, params.action, ctx);
			const control = await adapter.controlExecution?.(params.ref, params.action, `tool:${toolCallId}`, ctx);
			if (control) ownership.set(params.ref, control.generation);
			if (params.action === "stop") {
				runtimeEpoch++;
				tickRequested = false;
				stopLifecycle(params.ref);
				active.delete(params.ref);
				for (const stepRef of inFlight.keys()) if (stepRef === params.ref || stepRef.startsWith(`${params.ref}/`)) {
					inFlight.delete(stepRef);
					inFlightProgress.delete(stepRef);
				}
			}
			if (params.action !== "resume") await adapter.controlWorkflow(params.ref, params.action, ctx);
			if (params.action === "resume") active.set(params.ref, "running"); else if (params.action === "pause") active.set(params.ref, "paused"); else { active.delete(params.ref); ownership.delete(params.ref); }
			currentRef = params.ref; persist(params.ref, params.action === "stop" ? "stopped" : params.action === "resume" ? "running" : "paused");
			if (params.action === "stop") {
				currentSnapshot = undefined;
				renderDashboard(ctx);
			} else await tick(ctx, runtimeEpoch);
			return result(`${params.action} recorded for workflow ${params.ref}.`);
		},
	});

	pi.registerTool({
		name: "workflow_checkpoint", label: "Review checkpoint",
		description: "Choose the meaningful review outcome: approve (optionally with structured acceptedRisks) or request_changes. request_changes records the decision, returns immediately, and lets the runner own background repair and automatic re-review.",
		parameters: Type.Object({ ref: Type.String({ description: "Exact evaluation step ref" }), action: StringEnum(["approve", "request_changes"] as const), prompt: Type.Optional(Type.String()), acceptedRisks: Type.Optional(Type.Array(Type.Object({ findingId: Type.String(), rationale: Type.String() }))) }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			const adapter = adapterFor(params.ref);
			if (!adapter.controlCheckpoint) throw new Error(`Workflow adapter does not support checkpoint decisions: ${params.ref}`);
			let decision: unknown;
			try {
				decision = await adapter.controlCheckpoint(params.ref, params.action, { ...(params.prompt ? { prompt: params.prompt } : {}), ...(params.acceptedRisks ? { acceptedRisks: params.acceptedRisks } : {}) }, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("USER_DECISION_REQUIRED")) return result(message, { userDecisionRequired: true, ref: params.ref });
				throw error;
			}
			const workflowRef = params.ref.split("/evaluation:")[0]!;
			const existingMode = active.get(workflowRef);
			if (existingMode === "paused") {
				const control = await adapter.controlExecution?.(workflowRef, "resume", `checkpoint:${toolCallId}`, ctx);
				if (control) ownership.set(workflowRef, control.generation);
			}
			active.set(workflowRef, "running"); currentRef = workflowRef; persist(workflowRef, "running");
			await tick(ctx);
			return result(params.action === "request_changes" ? `Request changes recorded for ${params.ref}. Managed repair and automatic re-review are running in the background.` : `Approve recorded for ${params.ref}.`, decision);
		},
	});

	const registerSubagentSpawn = (catalog: SpawnableAgentDefinition[] = []) => {
		const available = catalog.length > 0
			? catalog.map((agent) => `${agent.name} (${agent.source}, ${agent.tier}) — ${agent.description}`).join("; ")
			: "The registered workflow adapter supplies the available definitions at session start.";
		pi.registerTool({
			name: "subagent_spawn", label: "Spawn Subagent",
			description: `Spawn a subagent from one configured agent definition and a complete task prompt. Available agents: ${available} Foreground is the default and waits for settlement; set mode to background to return immediately and receive automatic terminal delivery. Choose delegation only when it helps; managed workflow tasks remain internally scheduled by workflow_start/resume.`,
			parameters: Type.Object({
				agent: Type.String({ description: `Exact configured agent name. Available agents: ${catalog.length > 0 ? catalog.map((agent) => agent.name).join(", ") : "resolved at session start"}` }),
				task: Type.String({ description: "Complete assignment prompt for the child" }),
				mode: Type.Optional(StringEnum(["background", "foreground"] as const, { default: "foreground" })),
				tier: Type.Optional(StringEnum(["low", "medium", "high", "max", "local"] as const, { description: "Configured fallback list; use local for local-llm requests; defaults to medium" })),
				model: Type.Optional(Type.String({ description: "Exact configured model; accepts model, provider/model, or either form suffixed with #effort. Explicit model or effort failures return an error without fallback; local-llm models require tier local" })),
				effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Optional preferred-model effort override" })),
			}, { additionalProperties: false }),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const adapter = dynamicAdapter();
				const mode = params.mode ?? "foreground";
				const tier = inferDynamicSubagentTier(params.tier, params.model);
				const request: DynamicSubagentRequest = {
					operationId: toolCallId, agent: params.agent, task: params.task, tier,
					...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}),
				};
				let resolvedStatus: DynamicSubagentStarted | undefined;
				if (mode === "background") {
					runningSubagents.set(toolCallId, { agent: params.agent, mode, startedAt: Date.now(), ...(tier ? { tier } : {}) });
					renderSubagentStatus();
				}
				let progressStatus: AgentProgress | undefined;
				const runningDetails = () => ({ agent: params.agent, state: "running", tier, resolved: resolvedStatus, progress: progressStatus });
				const promise = adapter.spawnSubagent!(
					request,
					ctx,
					mode === "foreground" ? signal : undefined,
					mode === "foreground" && onUpdate ? (text) => onUpdate(result(text, runningDetails())) : undefined,
					(resolved) => {
						resolvedStatus = resolved;
						if (mode === "background") {
							const current = runningSubagents.get(toolCallId);
							if (current) runningSubagents.set(toolCallId, { ...current, resolved });
							renderSubagentStatus();
						} else if (onUpdate) {
							onUpdate(result("", runningDetails()));
						}
					},
					(progress) => {
						progressStatus = progress;
						if (mode === "background") {
							const current = runningSubagents.get(toolCallId);
							if (current) runningSubagents.set(toolCallId, { ...current, progress });
							renderSubagentStatus();
						} else if (onUpdate) onUpdate(result("", runningDetails()));
					},
				);
				if (mode === "foreground") {
					try {
						const settled = await promise;
						if (settled.state === "failed") throw new Error(settled.summary);
						return result(settled.summary, settled);
					} finally {
						runningSubagents.delete(toolCallId);
						renderSubagentStatus();
					}
				}
				void promise
					.then((settled) => deliverBackgroundSubagentResult(params.agent, settled))
					.catch((error) => deliverBackgroundSubagentResult(params.agent, {
						ref: `agent:${params.agent}`,
						state: "failed",
						summary: error instanceof Error ? error.message : String(error),
						attention: true,
					}))
					.finally(() => {
						runningSubagents.delete(toolCallId);
						renderSubagentStatus();
					});
				return result(`Spawned ${params.agent} in background. Its terminal report will be returned to this session and trigger a response.`, { agent: params.agent, state: "starting" });
			},
		});
	};

	pi.registerTool({
		name: "subagent_status", label: "Subagent Status",
		description: "Inspect subagents for point-in-time diagnostics and recovery; this is not a polling mechanism. By default it lists actionable non-settled agents, failures, and agents owning open messages with attention/active records first and newest first. Use includeSettled for explicit history inspection, or filters to narrow one recovery query. Do not repeatedly call this while waiting: rely on automatic terminal reports, lifecycle events, or a new user request.",
		parameters: Type.Object({
			agentId: Type.Optional(Type.String({ description: "Exact logical subagent ID" })),
			workflowRef: Type.Optional(Type.String({ description: "Exact workflow reference, such as work-item:example" })),
			state: Type.Optional(Type.String({ description: "Exact logical agent state to inspect" })),
			includeSettled: Type.Optional(Type.Boolean({ default: false, description: "Include completed, failed, protocol-failed, and cancelled history" })),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SUBAGENT_STATUS_LIMIT, default: DEFAULT_SUBAGENT_STATUS_LIMIT, description: `Maximum records in each bounded result list (at most ${MAX_SUBAGENT_STATUS_LIMIT})` })),
		}, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const agents = (await Promise.all(adapters.map((adapter) => adapter.listSubagents(ctx)))).flat();
			const messages = (await Promise.all(adapters.map((adapter) => adapter.listMessages(ctx)))).flat();
			const filters: SubagentStatusFilters = {
				...(params.agentId ? { agentId: params.agentId } : {}),
				...(params.workflowRef ? { workflowRef: params.workflowRef } : {}),
				...(params.state ? { state: params.state } : {}),
				...(params.includeSettled !== undefined ? { includeSettled: params.includeSettled } : {}),
				...(params.limit !== undefined ? { limit: params.limit } : {}),
			};
			const payload = projectSubagentStatus(agents, messages, filters);
			const emptyText = subagentStatusEmptyText(payload, filters);
			return result(emptyText || JSON.stringify(payload, null, 2), payload);
		},
	});

	pi.registerTool({
		name: "subagent_control", label: "Control Subagent", description: "Pause or stop a logical subagent.",
		parameters: Type.Object({ agentId: Type.String(), action: StringEnum(["pause", "stop"] as const) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			for (const adapter of adapters) {
				const agents = await adapter.listSubagents(ctx) as Array<{ id?: string }>;
				if (agents.some((agent) => agent.id === params.agentId)) return result(`${params.action} requested for ${params.agentId}.`, await adapter.controlSubagent(params.agentId, params.action, ctx));
			}
			throw new Error(`Unknown subagent: ${params.agentId}`);
		},
	});

	pi.registerTool({
		name: "subagent_respond", label: "Respond to Subagent", description: "Persist an orchestrator response to an open subagent request.",
		parameters: Type.Object({ agentId: Type.String(), messageId: Type.String(), response: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			for (const adapter of adapters) {
				const agents = await adapter.listSubagents(ctx) as Array<{ id?: string }>;
				if (agents.some((agent) => agent.id === params.agentId)) {
					const recorded = await adapter.respondSubagent(params.agentId, params.messageId, params.response, ctx) as { workflowRef?: string };
					if (recorded.workflowRef && active.has(recorded.workflowRef)) { active.set(recorded.workflowRef, "running"); persist(recorded.workflowRef, "running"); requestTick(ctx); }
					return result(`Response recorded for ${params.messageId}.`, recorded);
				}
			}
			throw new Error(`Unknown subagent: ${params.agentId}`);
		},
	});

	pi.events.on(WORKFLOW_CONTROL_EVENT, (event: unknown) => {
		const command = event as WorkflowControlEvent;
		if (!sessionCtx || !active.has(command.ref) || !adapters.some((adapter) => adapter.canHandle(command.ref))) return;
		if (command.action === "resume") active.set(command.ref, "running");
		else if (command.action === "pause") active.set(command.ref, "paused");
		else active.delete(command.ref);
		currentRef = command.ref;
		persist(command.ref, command.action === "stop" ? "stopped" : command.action === "resume" ? "running" : "paused");
		requestTick(sessionCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
		runtimeEpoch++;
		shuttingDown = false;
		if (process.env.PIBOX_SUBAGENT_ID) { pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name))); return; }
		adapters.length = 0;
		pi.events.emit(WORKFLOW_ADAPTER_DISCOVERY_EVENT, { register(adapter: WorkflowAdapter) { if (!adapters.some((candidate) => candidate.id === adapter.id)) adapters.push(adapter); } } satisfies WorkflowAdapterDiscovery);
		const catalogAdapter = adapters.find((adapter) => adapter.spawnSubagent && adapter.listSpawnableAgents);
		const catalog = catalogAdapter ? await catalogAdapter.listSpawnableAgents!(ctx).catch(() => []) : [];
		registerSubagentSpawn(catalog);
		sessionCtx = ctx;
		const entries = ctx.sessionManager.getEntries();
		const states = new Map<string, "running" | "paused" | "stopped">();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "pibox-workflow") continue;
			const data = entry.data as { ref?: string; state?: "running" | "paused" | "stopped" };
			if (data.ref && data.state) states.set(data.ref, data.state);
		}
		const controlled = new Set<string>();
		for (const adapter of adapters) {
			const records = adapter.listExecutionControls ? await adapter.listExecutionControls(ctx).catch(() => []) : [];
			for (const record of records) {
				controlled.add(record.workflowRef);
				if (record.mode !== "running" && record.mode !== "paused") continue;
				if (record.ownerSessionId && record.ownerSessionId !== ctx.sessionManager.getSessionId()) continue;
				const attached = await adapter.controlExecution?.(record.workflowRef, "attach", `session:${ctx.sessionManager.getSessionId()}:attach:${record.generation}`, ctx).catch(() => undefined);
				if (attached) ownership.set(record.workflowRef, attached.generation);
				active.set(record.workflowRef, record.mode);
				currentRef = record.workflowRef;
			}
		}
		// Compatibility for workflows started before durable control records existed.
		// Establish fence 1 during attach so an automatic post-reload tick never runs
		// outside durable ownership while waiting for an explicit resume command.
		for (const [ref, state] of states) {
			if (state === "stopped" || controlled.has(ref)) continue;
			const adapter = adapterFor(ref);
			const migrated = await adapter.controlExecution?.(ref, state === "running" ? "resume" : "pause", `session:${ctx.sessionManager.getSessionId()}:migrate:${state}`, ctx).catch(() => undefined);
			if (migrated) ownership.set(ref, migrated.generation);
			active.set(ref, state);
			currentRef = ref;
		}
		if (currentRef) {
			const adapter = adapterFor(currentRef);
			currentSnapshot = await adapter.snapshot(currentRef, ctx).catch(() => undefined);
			watchLifecycle(currentRef, adapter, ctx);
		}
		renderDashboard(ctx);
		renderSubagentStatus();
		if (currentRef) requestTick(ctx);
		startVisualTimer();
		subagentPulseTimer = setInterval(() => {
			if (runningSubagents.size === 0) return;
			subagentPulseFrame++;
			renderSubagentStatus();
		}, SUBAGENT_PULSE_INTERVAL_MS);
		subagentPulseTimer.unref();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const ref of active.keys()) {
			const adapter = adapters.find((candidate) => candidate.canHandle(ref));
			if (adapter?.controlExecution && ownership.has(ref)) await adapter.controlExecution(ref, "detach", `session:${ctx.sessionManager.getSessionId()}:detach:${ownership.get(ref)}`, ctx).catch(() => undefined);
		}
		if (subagentPulseTimer) clearInterval(subagentPulseTimer);
		if (visualTimer) clearInterval(visualTimer);
		visualTimer = undefined;
		subagentPulseTimer = undefined;
		runningSubagents.clear();
		runtimeEpoch++;
		shuttingDown = true;
		tickRequested = false;
		for (const ref of lifecycleSubscriptions.keys()) stopLifecycle(ref);
		active.clear();
		ownership.clear();
		inFlight.clear();
		inFlightProgress.clear();
		currentRef = undefined;
		currentSnapshot = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		sessionCtx = undefined;
		dashboardInvalidate = undefined;
		dashboardTui = undefined;
		ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
