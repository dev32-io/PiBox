import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { inferDynamicSubagentTier, WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, WORKFLOW_LIFECYCLE_EVENT, type DynamicSubagentRequest, type SpawnableAgentDefinition, type WorkflowAdapter, type WorkflowAdapterDiscovery, type WorkflowControlEvent, type WorkflowLifecycleEvent, type WorkflowLifecycleUpdate, type WorkflowMetrics, type WorkflowRunResult, type WorkflowSnapshot, type WorkflowStep } from "./api.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { formatBackgroundSubagentStatus, SUBAGENT_PULSE_INTERVAL_MS, subagentPulseDot } from "./subagent-display.js";
import { activateWorkflowBypass, confirmWorkflowBypass } from "../permissions/runtime.js";
import { formatAgentProgress } from "./agent-progress.js";
import { agentLiveProcessStatus, type AgentLiveProjection } from "./agent-live-projection.js";
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
type DynamicSubagentView = {
	agent: string;
	mode: "background" | "foreground";
	tier?: string;
	onUpdate?: (update: ReturnType<typeof result>) => void;
};

export default function workflows(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("pibox-workflow-event", renderWorkflowEventMessage);

	const adapters: WorkflowAdapter[] = [];
	const active = new Map<string, "running" | "paused">();
	const ownership = new Map<string, number>();
	const inFlight = new Map<string, number>();
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
	const agentLive = new Map<string, AgentLiveProjection>();
	const dynamicViews = new Map<string, DynamicSubagentView>();
	let agentLiveSubscription: { controller: AbortController; unsubscribe?: () => void; epoch: number } | undefined;
	let agentLiveAuthoritative = false;
	let agentLiveReady = false;
	const lifecycleSubscriptions = new Map<string, { controller: AbortController; unsubscribe: (() => void) | undefined }>();
	let tickRequestedEpoch: number | undefined;
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

	const observedStageCompletions = new Map<string, Set<string>>();
	const sendLifecycle = (event: WorkflowLifecycleEvent) => {
		try { pi.events.emit(WORKFLOW_LIFECYCLE_EVENT, event); }
		catch { /* Session replacement leaves durable workflow state authoritative. */ }
	};
	const observeStageCompletions = (snapshot: WorkflowSnapshot) => {
		if (!snapshot.stages) return;
		const stepByNode = new Map(snapshot.steps.map((step) => {
			const match = /\/(task|evaluation):([^/]+)$/.exec(step.ref);
			return [match ? `${match[1]}:${match[2]}` : step.ref, step] as const;
		}));
		const complete = snapshot.stages.filter((stage) => stage.nodes.length > 0 && stage.nodes.every((node) => stepByNode.get(node)?.status === "done"));
		const observed = observedStageCompletions.get(snapshot.ref);
		if (!observed) {
			observedStageCompletions.set(snapshot.ref, new Set(complete.map((stage) => stage.id)));
			return;
		}
		for (const stage of complete) {
			if (observed.has(stage.id)) continue;
			observed.add(stage.id);
			const terminalStep = stepByNode.get(stage.nodes.at(-1)!);
			const correlationId = `${snapshot.ref}:${stage.id}`;
			sendLifecycle({
				type: "stage-completed", workflowRef: snapshot.ref, ...(terminalStep ? { stepRef: terminalStep.ref, kind: terminalStep.kind } : {}),
				stageId: stage.id, stageIndex: stage.index, title: `Stage ${stage.index + 1} · ${stage.id}`, ...(terminalStep?.detail ? { detail: terminalStep.detail } : {}),
				toStatus: "done", cause: "stage-settled", correlationId,
			});
		}
	};

	const pauseDurably = async (adapter: WorkflowAdapter, ref: string, operationId: string, ctx: ExtensionContext) => {
		if (active.get(ref) !== "running") return;
		const control = await adapter.controlExecution?.(ref, "pause", operationId, ctx).catch(() => undefined);
		if (control) ownership.set(ref, control.generation);
		active.set(ref, "paused");
		persist(ref, "paused");
	};

	const liveDetails = (projection: AgentLiveProjection, tier?: string) => ({
		agent: projection.role,
		state: projection.state,
		...(tier ? { tier } : {}),
		resolved: { agentId: projection.agentId, provider: projection.provider, model: projection.model, effort: projection.effort, fast: projection.fast === true, startedAt: projection.startedAt },
		...(agentLiveProcessStatus(projection) ? { processStatus: agentLiveProcessStatus(projection) } : {}),
		...(projection.progress ? { progress: projection.progress } : {}),
	});

	const backgroundAgents = () => [...agentLive.values()].filter((projection) => {
		if (!projection.active || projection.workItemId || projection.taskId || projection.evaluationId) return false;
		return dynamicViews.get(projection.operationId)?.mode !== "foreground";
	});

	const renderSubagentStatus = () => {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		const agents = backgroundAgents();
		if (agents.length === 0) {
			ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
			return;
		}
		const dot = subagentPulseDot(subagentPulseFrame);
		const lines = agents.map((projection) => {
			const view = dynamicViews.get(projection.operationId);
			const processStatus = agentLiveProcessStatus(projection);
			const liveStatus = formatBackgroundSubagentStatus({
				...(view?.tier ? { tier: view.tier } : {}),
				resolved: { provider: projection.provider, model: projection.model, effort: projection.effort, fast: projection.fast === true },
				...(projection.progress ? { progress: projection.progress } : {}),
				...(processStatus ? { processStatus } : {}),
				startedAt: projection.startedAt,
			});
			return `${ctx.ui.theme.fg("warning", dot)} ${ctx.ui.theme.fg("text", view?.agent ?? projection.role)} ${ctx.ui.theme.fg("dim", liveStatus)}`;
		});
		ctx.ui.setStatus(SUBAGENT_STATUS_KEY, lines.join("\n"));
	};

	const stopAgentLive = () => {
		agentLiveSubscription?.controller.abort();
		agentLiveSubscription?.unsubscribe?.();
		agentLiveSubscription = undefined;
		agentLiveAuthoritative = false;
		agentLiveReady = false;
	};

	const acceptAgentLive = (projection: AgentLiveProjection, epoch: number) => {
		if (shuttingDown || epoch !== runtimeEpoch) return;
		const previous = agentLive.get(projection.agentId);
		const view = dynamicViews.get(projection.operationId);
		if (projection.active || view) agentLive.set(projection.agentId, projection);
		else agentLive.delete(projection.agentId);
		if (view?.mode === "foreground" && view.onUpdate) view.onUpdate(result("", liveDetails(projection, view.tier)));
		renderSubagentStatus();
		dashboardInvalidate?.();
		dashboardTui?.requestRender?.();
		const lifecycleChanged = !previous || previous.active !== projection.active || previous.state !== projection.state ||
			previous.attemptId !== projection.attemptId || previous.attemptState !== projection.attemptState;
		const belongsToCurrentWorkflow = projection.workItemId && currentRef === `work-item:${projection.workItemId}`;
		// The left row and right-side rate clocks consume one lifecycle state. Rebase
		// immediately at the event boundary; the ensuing durable snapshot refresh
		// replaces totals, but can no longer leave an old rate attached to them.
		if (lifecycleChanged && (projection.active || previous?.active) && belongsToCurrentWorkflow) {
			if (currentSnapshot) currentSnapshot = reconcileAgentMetricRates(currentSnapshot, true);
			if (sessionCtx && active.get(currentRef!) === "running") requestTick(sessionCtx, epoch);
		}
	};

	const watchAgentLive = (ctx: ExtensionContext) => {
		stopAgentLive();
		agentLive.clear();
		const adapter = adapters.find((candidate) => candidate.subscribeAgentLive);
		if (!adapter) return;
		const epoch = runtimeEpoch;
		const controller = new AbortController();
		const subscription: { controller: AbortController; unsubscribe?: () => void; epoch: number } = { controller, epoch };
		agentLiveSubscription = subscription;
		agentLiveAuthoritative = true;
		agentLiveReady = false;
		void Promise.resolve(adapter.subscribeAgentLive!(ctx, (projection) => acceptAgentLive(projection, epoch), controller.signal)).then((unsubscribe) => {
			if (controller.signal.aborted || shuttingDown || epoch !== runtimeEpoch || agentLiveSubscription !== subscription) {
				if (typeof unsubscribe === "function") unsubscribe();
				return;
			}
			if (typeof unsubscribe === "function") subscription.unsubscribe = unsubscribe;
			agentLiveReady = true;
			if (currentSnapshot) currentSnapshot = reconcileAgentMetricRates(currentSnapshot);
			dashboardInvalidate?.();
			dashboardTui?.requestRender?.();
		}).catch(() => {
			if (agentLiveSubscription === subscription) {
				agentLiveSubscription = undefined;
				agentLiveAuthoritative = false;
				agentLiveReady = false;
			}
		});
	};

	const releaseDynamicView = (operationId: string) => {
		dynamicViews.delete(operationId);
		for (const [agentId, projection] of agentLive) if (projection.operationId === operationId && !projection.active) agentLive.delete(agentId);
		renderSubagentStatus();
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

	const isCurrentInFlight = (ref: string): boolean => inFlight.get(ref) === runtimeEpoch;
	const displayStatus = (step: WorkflowStep): WorkflowStep["status"] => isCurrentInFlight(step.ref) && step.status !== "done" ? "running" : step.status;
	const liveAgentForStep = (step: WorkflowStep): AgentLiveProjection | undefined => {
		const workItemId = /^work-item:([^/]+)/.exec(step.ref)?.[1];
		if (!workItemId) return undefined;
		const taskId = /\/task:([^/]+)$/.exec(step.ref)?.[1];
		const evaluationId = /\/evaluation:([^/]+)$/.exec(step.ref)?.[1];
		if (!taskId && !evaluationId) return undefined;
		return [...agentLive.values()].find((projection) => projection.active && projection.workItemId === workItemId &&
			(taskId ? projection.taskId === taskId : projection.evaluationId === evaluationId));
	};
	const displayProgress = (step: WorkflowStep, status: WorkflowStep["status"]): string => {
		if (status !== "running") return "";
		const live = liveAgentForStep(step);
		if (live) {
			const processStatus = agentLiveProcessStatus(live);
			return formatAgentProgress(live.progress, Date.now(), { fallbackStartedAt: live.startedAt, ...(processStatus ? { processStatus } : {}), showStarting: true });
		}
		return agentLiveAuthoritative ? "" : formatAgentProgress(step.progress);
	};
	const displayFast = (step: WorkflowStep): boolean => liveAgentForStep(step)?.fast === true || (!agentLiveAuthoritative && step.fast === true);
	const stateRank = (status: WorkflowStep["status"]): number => status === "attention" ? 5 : status === "running" ? 4 : status === "ready" ? 3 : status === "pending" ? 2 : status === "done" ? 1 : 5;
	const stateIcon = (status: WorkflowStep["status"], kind: string): string => {
		if (status === "running") { const frames = RUNNING_FRAMES[kind] ?? DEFAULT_RUNNING_FRAMES; return frames[frame % frames.length]!; }
		return status === "attention" ? "⚠" : status === "ready" ? "◆" : status === "pending" ? "·" : status === "done" ? "✓" : "–";
	};
	const visualStatus = (step: WorkflowStep, status = displayStatus(step)): WorkflowStep["status"] =>
		status === "running" ? status : ["verification-failed", "candidate-ci-failed", "integration-conflict"].includes(step.phase ?? "") ? "attention" : step.phase === "contribution-ready" ? "ready" : status;
	const stepLabel = (step: WorkflowStep, status: WorkflowStep["status"]): string => {
		if (step.kind === "task") return status === "done" ? "Implemented" : "Implementing";
		if (step.kind !== "merge") return step.kind;
		if (status === "done" || step.phase === "integrated") return "Integrated";
		if (status === "running") {
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

	const rawTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, includeProgress = true): string[] => {
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const step of snapshot.steps) {
			const status = displayStatus(step);
			const icon = stateIcon(status, step.kind);
			const color: "success" | "warning" | "error" | "muted" | "accent" = status === "done" ? "success" : status === "attention" ? "error" : status === "running" ? "accent" : "muted";
			const progress = includeProgress ? displayProgress(step, status) : "";
			const liveStatus = [displayFast(step) ? "Fast" : "", progress].filter(Boolean).join(" · ");
			lines.push(`${ctx.ui.theme.fg(color, `${icon} `)}${step.title}`);
			if (liveStatus) lines.push(`  ${ctx.ui.theme.fg("dim", liveStatus)}`);
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
			const reviewActive = reviewSteps.some((step) => step.status === "running" || step.status === "ready" || step.status === "attention" || isCurrentInFlight(step.ref));
			const implementationActive = !reviewActive && stageSteps.some((step) => step.kind === "task" && (step.status === "running" || step.status === "ready" || step.status === "attention" || isCurrentInFlight(step.ref)));
			const integrationActive = !reviewActive && !implementationActive && mergeSteps.some((step) => !["done", "cancelled"].includes(step.status) || isCurrentInFlight(step.ref));
			const runningMerge = mergeSteps.find((step) => displayStatus(step) === "running");
			const failedMerge = !runningMerge ? mergeSteps.find((step) => ["verification-failed", "candidate-ci-failed", "integration-conflict"].includes(step.phase ?? "")) : undefined;
			const verificationFailed = Boolean(failedMerge);
			const failureLabel = failedMerge?.phase === "integration-conflict" ? "Candidate conflict" : failedMerge?.phase === "candidate-ci-failed" ? "Candidate CI failed" : "Verification failed";
			const verifying = runningMerge?.phase === "verifying-candidate";
			const stageVisualStatus = verificationFailed ? "attention" : stageStatus;
			const runtimeStage = stage.group === "runtime";
			const runtimeLoop = primary?.checkpoint === "final-e2e" ? "E2E journey/fix loop" : primary?.checkpoint === "final-review" ? "Whole-branch review/fix loop" : "Final validation queued";
			const lifecycle = runtimeStage
				? stageStatus === "done" ? "Validated" : `${runtimeLoop}${stageStatus === "attention" ? " needs attention" : ""}`
				: stageStatus === "attention" ? "Needs attention" : stageStatus === "done" ? "Integrated" : reviewActive ? "Reviewing" : implementationActive ? "Implementing" : verificationFailed ? failureLabel : verifying ? "Verifying candidate" : runningMerge ? "Assembling / repairing candidate" : integrationActive ? "Ready to integrate" : "Queued";
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
					const waitingOnActiveBarrier = step.detail === "waiting for stage merge barrier" && Boolean(runningMerge);
					const shownStatus = waitingOnActiveBarrier ? "running" : visualStatus(step, status);
					const kind = stepLabel(step, status);
					const color: "success" | "error" | "muted" | "accent" = shownStatus === "done" ? "success" : shownStatus === "attention" ? "error" : shownStatus === "running" || shownStatus === "ready" ? "accent" : "muted";
					const progress = includeProgress ? displayProgress(step, status) : "";
					const liveStatus = [displayFast(step) ? "Fast" : "", progress].filter(Boolean).join(" · ");
					lines.push(`  ${ctx.ui.theme.fg(color, `${stateIcon(shownStatus, status === "running" && step.phase === "verifying-candidate" ? "verification" : step.kind)} `)}${kind} · ${step.title}`);
					if (liveStatus) lines.push(`    ${ctx.ui.theme.fg("dim", liveStatus)}`);
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
					const liveStatus = [displayFast(step) ? "Fast" : "", progress].filter(Boolean).join(" · ");
					lines.push(`  ${ctx.ui.theme.fg(status === "attention" ? "error" : status === "done" ? "success" : "accent", `${stateIcon(status, step.kind)} `)}${label}`);
					if (liveStatus) lines.push(`    ${ctx.ui.theme.fg("dim", liveStatus)}`);
				}
			}
		}
		return lines;
	};

	const metricDuration = (milliseconds: number): string => {
		const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		const shownSeconds = seconds % 60;
		if (minutes < 60) return `${minutes}m ${shownSeconds}s`;
		return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${shownSeconds}s`;
	};

	const projectedMetric = (metrics: WorkflowMetrics, base: number, activeIntervals: number, now = Date.now()): number => {
		if (!metrics.live || activeIntervals <= 0) return base;
		return base + Math.max(0, now - metrics.live.sampledAtMs) * activeIntervals;
	};

	const phaseMetric = (metrics: WorkflowMetrics, category: NonNullable<WorkflowMetrics["live"]>["activeCategory"], base: number | undefined, now = Date.now()): number => {
		const hasPhaseProjection = [metrics.implementationMs, metrics.integrationMs, metrics.reviewMs, metrics.e2eMs, metrics.orchestrationMs].some((value) => value !== undefined);
		const compatibleBase = hasPhaseProjection ? (base ?? 0) : category === "orchestration" ? metrics.runningMs : 0;
		const activeCategory = metrics.live?.activeCategory ?? (!hasPhaseProjection && metrics.live?.running ? "orchestration" : undefined);
		return projectedMetric(metrics, compatibleBase, metrics.live?.running && activeCategory === category ? 1 : 0, now);
	};

	const freezeMetricProjection = (metrics: WorkflowMetrics, now = Date.now()): WorkflowMetrics => {
		if (!metrics.live) return metrics;
		return {
			...metrics,
			elapsedMs: projectedMetric(metrics, metrics.elapsedMs, metrics.live.elapsed ? 1 : 0, now),
			runningMs: projectedMetric(metrics, metrics.runningMs, metrics.live.running ? 1 : 0, now),
			agentActiveMs: projectedMetric(metrics, metrics.agentActiveMs, metrics.live.activeAgents, now),
			implementerMs: projectedMetric(metrics, metrics.implementerMs ?? 0, metrics.live.activeImplementers ?? 0, now),
			reviewerMs: projectedMetric(metrics, metrics.reviewerMs ?? 0, metrics.live.activeReviewers ?? 0, now),
			fixerMs: projectedMetric(metrics, metrics.fixerMs ?? 0, metrics.live.activeFixers ?? 0, now),
			e2eAgentMs: projectedMetric(metrics, metrics.e2eAgentMs ?? 0, metrics.live.activeE2e ?? 0, now),
			deterministicMs: projectedMetric(metrics, metrics.deterministicMs ?? metrics.verificationMs, metrics.live.activeVerifications, now),
			harnessSchedulingMs: projectedMetric(metrics, metrics.harnessSchedulingMs ?? 0, metrics.live.activeScheduling ?? 0, now),
			implementationMs: phaseMetric(metrics, "implementation", metrics.implementationMs, now),
			integrationMs: phaseMetric(metrics, "integration", metrics.integrationMs, now),
			verificationMs: phaseMetric(metrics, "verification", metrics.verificationMs, now),
			reviewMs: phaseMetric(metrics, "review", metrics.reviewMs, now),
			e2eMs: phaseMetric(metrics, "e2e", metrics.e2eMs, now),
			orchestrationMs: projectedMetric(metrics, metrics.orchestrationMs ?? 0, metrics.live.orchestrator ? 1 : 0, now),
			live: { sampledAtMs: now, elapsed: false, running: false, activeAgents: 0, activeVerifications: 0, activeImplementers: 0, activeReviewers: 0, activeFixers: 0, activeE2e: 0, activeScheduling: 0, orchestrator: false },
		};
	};

	const reconcileAgentMetricRates = (snapshot: WorkflowSnapshot, force = false, now = Date.now()): WorkflowSnapshot => {
		const metrics = snapshot.metrics;
		if (!metrics?.live || (!force && !agentLiveReady)) return snapshot;
		const workItemId = snapshot.ref.startsWith("work-item:") ? snapshot.ref.slice("work-item:".length) : undefined;
		if (!workItemId) return snapshot;
		const managed = [...agentLive.values()].filter((projection) => projection.workItemId === workItemId && projection.active);
		const processActive = managed.filter((projection) => agentLiveProcessStatus(projection) === "active");
		const activeScheduling = managed.filter((projection) => projection.attemptState === "launching").length;
		const counts = { implementer: 0, reviewer: 0, fixer: 0, e2e: 0 };
		for (const projection of processActive) {
			if (projection.activity?.kind === "repair" || projection.role === "repair-implementer") counts.fixer++;
			else if (projection.role === "e2e-tester") counts.e2e++;
			else if (projection.activity?.kind === "review" || projection.role === "code-reviewer") counts.reviewer++;
			else if (projection.taskId || projection.role === "implementer") counts.implementer++;
		}
		const activeVerifications = metrics.live.activeVerifications;
		const running = metrics.live.running;
		const activeCategory = counts.e2e > 0 ? "e2e"
			: counts.reviewer > 0 ? "review"
				: activeVerifications > 0 ? "verification"
					: counts.fixer > 0 ? "integration"
						: counts.implementer > 0 ? "implementation"
							: running ? "orchestration" : undefined;
		const frozen = freezeMetricProjection(metrics, now);
		return {
			...snapshot,
			metrics: {
				...frozen,
				live: {
					sampledAtMs: now,
					elapsed: metrics.live.elapsed,
					running,
					...(activeCategory ? { activeCategory } : {}),
					activeAgents: processActive.length,
					activeVerifications,
					activeImplementers: counts.implementer,
					activeReviewers: counts.reviewer,
					activeFixers: counts.fixer,
					activeE2e: counts.e2e,
					activeScheduling,
					orchestrator: running && activeScheduling === 0 && processActive.length === 0 && activeVerifications === 0,
				},
			},
		};
	};

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
		const metrics = showMetrics && snapshot.metrics ? metricRows(snapshot) : [];
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
		const schedule = () => {
			if (!currentSnapshot) return;
			const animated = currentSnapshot.steps.some((step) => step.status === "running" || isCurrentInFlight(step.ref));
			const live = currentSnapshot.metrics?.live;
			const timing = Boolean(live && (live.running || live.activeAgents > 0 || live.activeVerifications > 0));
			if (!animated && !timing) return;
			const delay = animated ? 90 : Math.max(50, 1_000 - (Date.now() % 1_000));
			visualTimer = setTimeout(() => {
				visualTimer = undefined;
				if (animated) frame++;
				dashboardInvalidate?.();
				dashboardTui?.requestRender?.();
				schedule();
			}, delay);
			visualTimer.unref();
		};
		schedule();
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
		!shuttingDown && epoch === runtimeEpoch && sessionCtx && workflowRef && active.get(workflowRef) === "running",
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
			// Observe the stage projection, not a process or merge result. This also keeps
			// completion tied to the stage boundary when approval happens out of band.
			if (terminalSnapshot) observeStageCompletions(terminalSnapshot);
			if (attention) {
				if (workflowRef) {
					await pauseDurably(adapter, workflowRef, `settlement:${step.ref}:${generation ?? epoch}:attention`, ctx);
					sendLifecycle({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, cause: "step-attention", nextAction: "Resolve the step and resume or decide at its checkpoint." });
				}
			}
		} catch (error) {
			if (!await settlementIsCurrent(adapter, workflowRef, epoch, generation, ctx)) return;
			const detail = error instanceof Error ? error.message : String(error);
			if (workflowRef) {
				await pauseDurably(adapter, workflowRef, `settlement:${step.ref}:${generation ?? epoch}:exception`, ctx);
				sendLifecycle({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
			}
			sendEvent({ workflowRef: workflowRef ?? step.ref, title: `${step.title} · failed`, detail, attention: true, kind: step.kind, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
		} finally {
			if (inFlight.get(step.ref) === epoch) inFlight.delete(step.ref);
			if (settlementIsLive(workflowRef, epoch)) requestTick(ctx, epoch);
		}
	};

	const startStep = (adapter: WorkflowAdapter, step: WorkflowStep, ctx: ExtensionContext, epoch: number, signal?: AbortSignal): Promise<WorkflowRunResult> => {
		if (inFlight.has(step.ref)) throw new Error(`Step is already running: ${step.ref}`);
		inFlight.set(step.ref, epoch);
		const startTitle = step.checkpoint ? `Starting ${step.title.split(" · ")[0]}` : step.kind === "merge" ? `Assembling integration candidate · ${step.title}` : `Starting ${step.title}`;
		sendEvent({ workflowRef: step.ref.split("/")[0]!, title: startTitle, attention: false, kind: step.kind, toStatus: "running" });
		return adapter.runStep(step.ref, ctx, signal);
	};

	const runnable = (snapshot: WorkflowSnapshot): WorkflowStep[] => {
		const ready = snapshot.steps.filter((step) => step.status === "ready" && !isCurrentInFlight(step.ref));
		const running = snapshot.steps.filter((step) => step.status === "running" || isCurrentInFlight(step.ref));
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
		if (ticking) { tickRequestedEpoch = epoch; return; }
		ticking = true;
		try {
			frame++;
			for (const [ref] of active) {
				if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx) return;
				const adapter = adapterFor(ref);
				let snapshot: WorkflowSnapshot;
				try {
					await adapter.reconcileWorkflow?.(ref, ctx);
					snapshot = await adapter.snapshot(ref, ctx);
				}
				catch (error) {
					if (active.get(ref) === "running") {
						const detail = error instanceof Error ? error.message : String(error);
						await pauseDurably(adapter, ref, `snapshot:${ref}:${ownership.get(ref) ?? epoch}:failed`, ctx);
						sendLifecycle({ type: "error", workflowRef: ref, title: ref, detail, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
						sendEvent({ workflowRef: ref, title: `${ref} · attention`, detail, attention: true, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
					}
					continue;
				}
				if (shuttingDown || epoch !== runtimeEpoch || !sessionCtx) return;
				observeStageCompletions(snapshot);
				if (ref === currentRef) {
					currentSnapshot = reconcileAgentMetricRates({ ...snapshot, steps: snapshot.steps.map((step) => isCurrentInFlight(step.ref) && step.status !== "done" ? { ...step, status: "running" } : step) });
					renderDashboard(ctx);
				}
				// Reconciliation and snapshot reads cross asynchronous boundaries. Never
				// launch from the stale map value captured before a concurrent pause.
				if (active.get(ref) !== "running") continue;
				// An adapter snapshot can briefly observe canonical settlement between child exit
				// and runStep completion. The in-flight promise remains authoritative until it
				// settles; only attention with no active step should pause the workflow.
				const hasIndependentReadyWork = snapshot.steps.some((step) => step.status === "ready" && !isCurrentInFlight(step.ref));
				const attentionSteps = snapshot.steps.filter((step) => step.status === "attention");
				const actionableAttentionSteps = attentionSteps.filter((step) => step.detail !== "result pending reconciliation");
				if (snapshot.status === "attention" && actionableAttentionSteps.length > 0 && !snapshot.steps.some((step) => isCurrentInFlight(step.ref)) && !hasIndependentReadyWork) {
					const detail = actionableAttentionSteps.map((step) => `${step.ref}: ${step.detail ?? "needs intervention"}`).join("\n");
					await pauseDurably(adapter, ref, `attention:${actionableAttentionSteps.map((step) => step.ref).join(",")}:${ownership.get(ref) ?? epoch}`, ctx);
					const checkpoint = actionableAttentionSteps.find((step) => step.kind === "evaluation");
					const guidance = `${detail || "Workflow needs intervention."}${checkpoint ? `\nUse workflow_checkpoint on ${checkpoint.ref}: Approve (optionally naming accepted risks) or Request changes. Do not manipulate Git or task state manually.` : ""}`;
					sendLifecycle({ type: "error", workflowRef: ref, ...(attentionSteps[0] ? { stepRef: attentionSteps[0].ref, kind: attentionSteps[0].kind } : {}), title: snapshot.title, detail: guidance, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
					sendEvent({ workflowRef: ref, title: `${snapshot.title} · attention`, detail: guidance, attention: true, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
					continue;
				}
				if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
					// Persist the terminal boundary before claiming completion. A failed control
					// write must remain visible as runner attention rather than leaving the
					// durable elapsed interval open behind a successful dashboard state.
					await adapter.controlExecution?.(ref, "complete", `complete:${ref}:${ownership.get(ref) ?? epoch}`, ctx);
					const completedAt = Date.now();
					// The snapshot used to detect completion predates workflow.completed and its
					// live rates. Refresh it so durable metrics use the exact event timestamp;
					// if that read fails, freeze the known projection at the terminal boundary.
					const refreshed = await adapter.snapshot(ref, ctx).catch(() => snapshot);
					const terminalSnapshot = refreshed.metrics ? { ...refreshed, metrics: freezeMetricProjection(refreshed.metrics, completedAt) } : refreshed;
					if (ref === currentRef) {
						currentSnapshot = terminalSnapshot;
						renderDashboard(ctx);
					}
					active.delete(ref); ownership.delete(ref); persist(ref, "stopped"); sendEvent({ workflowRef: ref, title: `${snapshot.title} · complete`, detail: "Finished all workflow steps.", attention: false, toStatus: "integrated", cause: "workflow-terminal" });
					const prompt = await adapter.completionPrompt?.(ref, ctx) ?? renderBuiltInPrompt("default-workflow-completion", { workflowRef: ref });
					try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* session recovery can inspect canonical completion state */ }
					continue;
				}
				for (const step of runnable(snapshot)) {
					if (active.get(ref) !== "running") break;
					const generation = ownership.get(ref);
					if (generation !== undefined && adapter.assertExecutionCurrent) {
						try { await adapter.assertExecutionCurrent(ref, generation, ctx); }
						catch {
							await pauseDurably(adapter, ref, `launch:${step.ref}:${generation}:stale`, ctx);
							break;
						}
					}
					if (active.get(ref) !== "running") break;
					const promise = startStep(adapter, step, ctx, epoch);
					void settleStep(adapter, step, promise, ctx, ref, epoch, generation);
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (currentRef) sendLifecycle({ type: "error", workflowRef: currentRef, title: "Workflow runner", detail, cause: "runner-exception" });
			sendEvent({ workflowRef: currentRef ?? "workflow", title: "Workflow runner · attention", detail, attention: true, cause: "runner-exception" });
		} finally {
			ticking = false;
			const requestedEpoch = tickRequestedEpoch;
			tickRequestedEpoch = undefined;
			// A session replacement can request a new-epoch tick while the old tick is
			// unwinding. Always hand that request to the current session context rather
			// than dropping it with the stale tick's epoch.
			if (!shuttingDown && requestedEpoch === runtimeEpoch && sessionCtx) requestTick(sessionCtx, requestedEpoch);
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
			// Close the subscribe-after-snapshot race. Agent activity may become durable
			// while a replacement extension is still installing its watcher; one
			// immediate catch-up snapshot gives live status a recovery path even when no
			// later lifecycle event arrives.
			listener();
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
					sendLifecycle({ type: "error", workflowRef: params.ref, title: "Workflow preflight · attention", detail, cause: "preflight-failed", nextAction: "Configure the declared prerequisites without guessing values, then retry workflow_start." });
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
				active.set(params.ref, "running"); currentRef = params.ref; currentSnapshot = reconcileAgentMetricRates(snapshot); persist(params.ref, "running"); renderDashboard(ctx);
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
				tickRequestedEpoch = undefined;
				stopLifecycle(params.ref);
				active.delete(params.ref);
				for (const stepRef of inFlight.keys()) if (stepRef === params.ref || stepRef.startsWith(`${params.ref}/`)) inFlight.delete(stepRef);
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
			description: `Spawn a subagent from one configured agent definition with a detailed, self-contained assignment. Available agents: ${available} Prefer focused delegation: when a request has materially independent topics or dimensions, spawn multiple narrowly scoped subagents—one contribution per child—instead of assigning one child a large multi-part task. Keep tightly coupled work together, and do small directly tractable work yourself. Each assignment should state its objective, relevant context, included and excluded scope, expected evidence or deliverable, constraints, and stop conditions. Foreground is the default and waits for settlement; set mode to background when independent work can proceed concurrently and return through automatic terminal delivery. Managed workflow tasks remain internally scheduled by workflow_start/resume.`,
			parameters: Type.Object({
				agent: Type.String({ description: `Exact configured agent name. Available agents: ${catalog.length > 0 ? catalog.map((agent) => agent.name).join(", ") : "resolved at session start"}` }),
				task: Type.String({ description: "Detailed, self-contained assignment for one bounded contribution. Include its objective, relevant context, scope boundaries, expected evidence or deliverable, constraints, and stop conditions." }),
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
					operationId: toolCallId, agent: params.agent, task: params.task, tier, presentation: mode,
					...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}),
				};
				dynamicViews.set(toolCallId, { agent: params.agent, mode, tier, ...(mode === "foreground" && onUpdate ? { onUpdate } : {}) });
				const projection = () => [...agentLive.values()].find((candidate) => candidate.operationId === toolCallId);
				const startingDetails = () => ({ agent: params.agent, state: "starting", tier });
				const promise = adapter.spawnSubagent!(
					request,
					ctx,
					mode === "foreground" ? signal : undefined,
					mode === "foreground" && onUpdate ? (text) => {
						const live = projection();
						onUpdate(result(text, live ? liveDetails(live, tier) : startingDetails()));
					} : undefined,
				);
				if (mode === "foreground") {
					try {
						const settled = await promise;
						if (settled.state === "failed") throw new Error(settled.summary);
						const live = projection();
						return result(settled.summary, { ...settled, ...(live ? liveDetails(live, tier) : startingDetails()) });
					} finally {
						releaseDynamicView(toolCallId);
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
					.finally(() => releaseDynamicView(toolCallId));
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
		async execute(toolCallId, params, _signal, _update, ctx) {
			for (const adapter of adapters) {
				const agents = await adapter.listSubagents(ctx) as Array<{ id?: string }>;
				if (agents.some((agent) => agent.id === params.agentId)) {
					const recorded = await adapter.respondSubagent(params.agentId, params.messageId, params.response, ctx) as { workflowRef?: string; message?: { blocking?: boolean } };
					// Decision reports are non-blocking evidence and must never resurrect a
					// workflow paused for an unrelated failed settlement. Blocking responses
					// may continue work, but only after advancing the durable ownership fence.
					if (recorded.workflowRef && recorded.message?.blocking === true && active.has(recorded.workflowRef)) {
						if (active.get(recorded.workflowRef) === "paused") {
							const control = await adapter.controlExecution?.(recorded.workflowRef, "resume", `subagent-response:${toolCallId}`, ctx);
							if (control) ownership.set(recorded.workflowRef, control.generation);
						}
						active.set(recorded.workflowRef, "running");
						currentRef = recorded.workflowRef;
						persist(recorded.workflowRef, "running");
						requestTick(ctx);
					}
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
		// In-memory promises belong to the prior extension epoch. Durable adapter and
		// agent state below reconstructs active work without letting stale startup
		// overlays pin the replacement dashboard at `starting`.
		inFlight.clear();
		if (process.env.PIBOX_SUBAGENT_ID) { pi.setActiveTools(pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name))); return; }
		adapters.length = 0;
		pi.events.emit(WORKFLOW_ADAPTER_DISCOVERY_EVENT, { register(adapter: WorkflowAdapter) { if (!adapters.some((candidate) => candidate.id === adapter.id)) adapters.push(adapter); } } satisfies WorkflowAdapterDiscovery);
		const catalogAdapter = adapters.find((adapter) => adapter.spawnSubagent && adapter.listSpawnableAgents);
		const catalog = catalogAdapter ? await catalogAdapter.listSpawnableAgents!(ctx).catch(() => []) : [];
		registerSubagentSpawn(catalog);
		sessionCtx = ctx;
		watchAgentLive(ctx);
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
			const restoredSnapshot = await adapter.snapshot(currentRef, ctx).catch(() => undefined);
			currentSnapshot = restoredSnapshot ? reconcileAgentMetricRates(restoredSnapshot) : undefined;
			watchLifecycle(currentRef, adapter, ctx);
		}
		renderDashboard(ctx);
		renderSubagentStatus();
		if (currentRef) requestTick(ctx);
		startVisualTimer();
		subagentPulseTimer = setInterval(() => {
			if (backgroundAgents().length === 0) return;
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
		if (visualTimer) clearTimeout(visualTimer);
		visualTimer = undefined;
		subagentPulseTimer = undefined;
		stopAgentLive();
		agentLive.clear();
		dynamicViews.clear();
		observedStageCompletions.clear();
		runtimeEpoch++;
		shuttingDown = true;
		tickRequestedEpoch = undefined;
		for (const ref of lifecycleSubscriptions.keys()) stopLifecycle(ref);
		active.clear();
		ownership.clear();
		inFlight.clear();
		currentRef = undefined;
		currentSnapshot = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		sessionCtx = undefined;
		dashboardInvalidate = undefined;
		dashboardTui = undefined;
		ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
