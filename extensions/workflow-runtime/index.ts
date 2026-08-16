import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, WORKFLOW_FEEDBACK_EVENT, type DynamicSubagentRequest, type DynamicSubagentStarted, type SpawnableAgentDefinition, type WorkflowAdapter, type WorkflowAdapterDiscovery, type WorkflowControlEvent, type WorkflowFeedbackEvent, type WorkflowRunResult, type WorkflowSnapshot, type WorkflowStep } from "./api.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { formatSubagentRoute, SUBAGENT_PULSE_INTERVAL_MS, subagentPulseDot } from "./subagent-display.js";
import { activateWorkflowBypass, confirmWorkflowBypass } from "../permissions/runtime.js";

const TOOL_NAMES = ["workflow_start", "workflow_control", "workflow_checkpoint", "subagent_spawn", "subagent_status", "subagent_control", "subagent_respond"];
const RUNNING_FRAMES: Record<string, readonly string[]> = {
	task: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	merge: ["⇢", "→", "⇢", "⇒"],
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
};

function formatElapsed(startedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export default function workflows(pi: ExtensionAPI): void {
	const adapters: WorkflowAdapter[] = [];
	const active = new Map<string, "running" | "paused">();
	const inFlight = new Set<string>();
	let currentRef: string | undefined;
	let currentSnapshot: WorkflowSnapshot | undefined;
	let timer: NodeJS.Timeout | undefined;
	let subagentPulseTimer: NodeJS.Timeout | undefined;
	let ticking = false;
	let frame = 0;
	let subagentPulseFrame = 0;
	let sessionCtx: ExtensionContext | undefined;
	let visualTimer: NodeJS.Timeout | undefined;
	let dashboardTui: { requestRender?: () => void } | undefined;
	let dashboardInvalidate: (() => void) | undefined;
	const notices = new Map<string, WorkflowNotice>();
	const runningSubagents = new Map<string, RunningSubagentStatus>();

	const adapterFor = (ref: string): WorkflowAdapter => {
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
		pi.appendEntry("pibox-workflow", { ref, state, at: new Date().toISOString() });
	};

	const sendFeedback = (event: WorkflowFeedbackEvent) => {
		pi.events.emit(WORKFLOW_FEEDBACK_EVENT, event);
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
			const route = formatSubagentRoute(status.tier, status.resolved);
			return `${ctx.ui.theme.fg("warning", dot)} ${ctx.ui.theme.fg("text", status.agent)} ${ctx.ui.theme.fg("dim", `running · ${route} · ${formatElapsed(status.startedAt)}`)}`;
		});
		ctx.ui.setStatus(SUBAGENT_STATUS_KEY, lines.join("\n"));
	};

	const deliverBackgroundSubagentResult = (agent: string, settled: WorkflowRunResult) => {
		const content = renderBuiltInPrompt("background-subagent-result", {
			agent,
			state: settled.state,
			summary: settled.summary || "The subagent returned no report.",
		});
		try {
			pi.sendMessage({ customType: "pibox-subagent-result", content, display: false, details: settled }, { deliverAs: "followUp", triggerTurn: true });
		} catch {
			// The durable subagent record remains available after session replacement or shutdown.
		}
	};

	const sendEvent = (event: WorkflowNotice & { cause?: string; attempt?: number; iteration?: number; correlationId?: string }) => {
		notices.set(event.workflowRef, event);
		if (sessionCtx) renderDashboard(sessionCtx);
		try {
			// Keep workflow plumbing out of chat history; attention still steers the orchestrator.
			const detail = [event.detail, event.cause ? `Cause: ${event.cause}` : undefined, event.nextAction ? `Next: ${event.nextAction}` : undefined].filter(Boolean).join("\n");
			pi.sendMessage({ customType: "pibox-workflow-event", content: `[Workflow ${event.attention ? "attention" : "event"}]\n${event.title}${detail ? `\n${detail}` : ""}`, display: false, details: event }, event.attention
				? { deliverAs: "steer", triggerTurn: true }
				: { deliverAs: "steer", triggerTurn: false });
		} catch {
			// A replacement or closing session will reconcile from durable adapter state.
		}
	};

	const stateRank = (status: WorkflowStep["status"]): number => status === "attention" ? 5 : status === "running" ? 4 : status === "ready" ? 3 : status === "pending" ? 2 : status === "done" ? 1 : 5;
	const stateIcon = (status: WorkflowStep["status"], kind: string): string => {
		if (status === "running") { const frames = RUNNING_FRAMES[kind] ?? DEFAULT_RUNNING_FRAMES; return frames[frame % frames.length]!; }
		return status === "attention" ? "!" : status === "ready" ? "○" : status === "pending" ? "□" : status === "done" ? "✓" : "–";
	};

	const rawTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext): string[] => {
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const step of snapshot.steps) {
			const icon = stateIcon(step.status, step.kind);
			const color: "success" | "warning" | "error" | "muted" | "accent" = step.status === "done" ? "success" : step.status === "attention" ? "error" : step.status === "running" ? "accent" : "muted";
			lines.push(`${ctx.ui.theme.fg(color, `${icon} `)}${step.title}`);
		}
		return lines;
	};

	const stageTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext): string[] => {
		if (!snapshot.stages?.length) return rawTaskLines(snapshot, ctx);
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const stage of snapshot.stages) {
			const stageSteps = snapshot.steps.filter((step) => stage.nodes.some((node) => step.ref.endsWith(`/${node}`)));
			const primary = stageSteps.reduce<WorkflowStep | undefined>((best, step) => !best || stateRank(step.status) > stateRank(best.status) ? step : best, undefined);
			const stageStatus = primary?.status ?? "pending";
			const stageIcon = stateIcon(stageStatus, primary?.kind ?? "task");
			const label = stage.group === "runtime" ? "Runtime verification" : `Stage ${stage.index + 1} · ${stage.id}${stage.parallel ? " · parallel frontier" : ""}`;
			const stageColor: "error" | "accent" | "muted" | "success" = stageStatus === "attention" ? "error" : stageStatus === "running" || stageStatus === "ready" ? "accent" : stageStatus === "done" ? "success" : "muted";
			lines.push(ctx.ui.theme.fg(stageColor, `${stageIcon} ${label}`));
			for (const step of stageSteps) {
				const color: "success" | "error" | "muted" | "accent" = step.status === "done" ? "success" : step.status === "attention" ? "error" : step.status === "running" || step.status === "ready" ? "accent" : "muted";
				lines.push(`  ${ctx.ui.theme.fg(color, `${stateIcon(step.status, step.kind)} `)}${step.title}`);
			}
		}
		return lines;
	};

	const dashboardLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, width: number): string[] => {
		const innerWidth = Math.max(1, width - 2);
		const tasks = stageTaskLines(snapshot, ctx);
		const separatorWidth = 3;
		const naturalTaskWidth = Math.max(...tasks.map((task) => visibleWidth(task)));
		const maxTaskWidth = Math.max(28, Math.floor(innerWidth * 0.58));
		const compactTaskWidth = Math.min(naturalTaskWidth, maxTaskWidth);
		const availableEventWidth = innerWidth - compactTaskWidth - separatorWidth;
		const notice = currentRef ? notices.get(currentRef) : undefined;
		const showNotice = Boolean(notice && innerWidth >= 72 && availableEventWidth >= 22);
		const taskWidth = showNotice ? compactTaskWidth : innerWidth;
		const eventWidth = showNotice ? availableEventWidth : 0;
		const separator = ctx.ui.theme.fg("borderMuted", " │ ");
		return tasks.map((task, index) => {
			const left = truncateToWidth(task, taskWidth, "…");
			let content = left;
			if (showNotice && notice) {
				const leftPane = `${left}${" ".repeat(Math.max(0, taskWidth - visibleWidth(left)))}`;
				const eventText = index === 0
					? ctx.ui.theme.fg(notice.attention ? "warning" : "accent", ctx.ui.theme.bold(notice.title))
					: index === 1 && notice.detail ? ctx.ui.theme.fg("dim", notice.detail.replaceAll("\n", " ")) : "";
				content = `${leftPane}${separator}${truncateToWidth(eventText, eventWidth, "…")}`;
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

	const settleStep = async (adapter: WorkflowAdapter, step: WorkflowStep, promise: Promise<WorkflowRunResult>, ctx: ExtensionContext, workflowRef?: string) => {
		try {
			const settled = await promise;
			const attention = Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed");
			const terminalSnapshot = workflowRef ? await adapter.snapshot(workflowRef, ctx).catch(() => undefined) : undefined;
			const terminalStep = terminalSnapshot?.steps.find((candidate) => candidate.ref === step.ref);
			sendEvent({ workflowRef: workflowRef ?? step.ref, title: `${step.title} · ${settled.state}`, detail: settled.summary, attention, kind: step.kind, ...(terminalStep?.status ? { toStatus: terminalStep.status } : {}), cause: attention ? "step-settled-with-attention" : "step-settled" });
			if (workflowRef && (step.kind === "task" || step.kind === "evaluation") && settled.state === "completed" && !attention && terminalStep?.status === "done") {
				sendFeedback({ type: "task-completed", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, toStatus: step.kind === "evaluation" ? "passed" : "integrated", terminal: true });
			}
			if (attention) {
				if (workflowRef) {
					active.set(workflowRef, "paused"); persist(workflowRef, "paused");
					sendFeedback({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, cause: "step-attention", nextAction: "Resolve the step and resume or decide at its checkpoint." });
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (workflowRef) {
				active.set(workflowRef, "paused"); persist(workflowRef, "paused");
				sendFeedback({ type: "error", workflowRef, stepRef: step.ref, kind: step.kind, title: step.title, detail, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
			}
			sendEvent({ workflowRef: workflowRef ?? step.ref, title: `${step.title} · failed`, detail, attention: true, kind: step.kind, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
		} finally {
			inFlight.delete(step.ref);
			await tick(ctx);
		}
	};

	const startStep = (adapter: WorkflowAdapter, step: WorkflowStep, ctx: ExtensionContext, signal?: AbortSignal): Promise<WorkflowRunResult> => {
		if (inFlight.has(step.ref)) throw new Error(`Step is already running: ${step.ref}`);
		inFlight.add(step.ref);
		sendEvent({ workflowRef: step.ref.split("/")[0]!, title: `Starting ${step.title}`, attention: false, kind: step.kind, toStatus: "running" });
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

	const tick = async (ctx: ExtensionContext) => {
		if (ticking) return;
		ticking = true;
		try {
			frame++;
			for (const [ref, state] of active) {
				const adapter = adapterFor(ref);
				let snapshot: WorkflowSnapshot;
				try { snapshot = await adapter.snapshot(ref, ctx); }
				catch (error) {
					if (state === "running") {
						const detail = error instanceof Error ? error.message : String(error);
						active.set(ref, "paused"); persist(ref, "paused");
						sendFeedback({ type: "error", workflowRef: ref, title: ref, detail, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
						sendEvent({ workflowRef: ref, title: `${ref} · attention`, detail, attention: true, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
					}
					continue;
				}
				if (ref === currentRef) {
					currentSnapshot = { ...snapshot, steps: snapshot.steps.map((step) => inFlight.has(step.ref) && step.status !== "done" ? { ...step, status: "running" } : step) };
					renderDashboard(ctx);
				}
				if (state !== "running") continue;
				// An adapter snapshot can briefly observe canonical settlement between child exit
				// and runStep completion. The in-flight promise remains authoritative until it
				// settles; only attention with no active step should pause the workflow.
				const hasIndependentReadyWork = snapshot.steps.some((step) => step.status === "ready" && !inFlight.has(step.ref));
				if (snapshot.status === "attention" && !snapshot.steps.some((step) => inFlight.has(step.ref)) && !hasIndependentReadyWork) {
					active.set(ref, "paused"); persist(ref, "paused");
					const attentionSteps = snapshot.steps.filter((step) => step.status === "attention");
					const detail = attentionSteps.map((step) => `${step.ref}: ${step.detail ?? "needs intervention"}`).join("\n");
					const checkpoint = attentionSteps.find((step) => step.kind === "evaluation");
					const guidance = `${detail || "Workflow needs intervention."}${checkpoint ? `\nUse workflow_checkpoint on ${checkpoint.ref} to request changes, retry the same reviewer, continue, skip, or accept non-blocking risk. Do not manipulate Git or task state manually.` : ""}`;
					sendFeedback({ type: "error", workflowRef: ref, ...(attentionSteps[0] ? { stepRef: attentionSteps[0].ref, kind: attentionSteps[0].kind } : {}), title: snapshot.title, detail: guidance, cause: "checkpoint-required", nextAction: checkpoint ? "Use workflow_checkpoint to decide the review outcome." : "Resolve the attention state and resume." });
					sendEvent({ workflowRef: ref, title: `${snapshot.title} · attention`, detail: guidance, attention: true, cause: "checkpoint-required", nextAction: checkpoint ? "Use workflow_checkpoint to decide the review outcome." : "Resolve the attention state and resume." });
					continue;
				}
				if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
					active.delete(ref); persist(ref, "stopped"); sendEvent({ workflowRef: ref, title: `${snapshot.title} · complete`, detail: "Finished all workflow steps.", attention: false, toStatus: "integrated", cause: "workflow-terminal" });
					const prompt = await adapter.completionPrompt?.(ref, ctx) ?? renderBuiltInPrompt("default-workflow-completion", { workflowRef: ref });
					try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* session recovery can inspect canonical completion state */ }
					continue;
				}
				for (const step of runnable(snapshot)) {
					const promise = startStep(adapter, step, ctx);
					void settleStep(adapter, step, promise, ctx, ref);
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (currentRef) sendFeedback({ type: "error", workflowRef: currentRef, title: "Workflow runner", detail, cause: "runner-exception" });
			sendEvent({ workflowRef: currentRef ?? "workflow", title: "Workflow runner · attention", detail, attention: true, cause: "runner-exception" });
		} finally { ticking = false; }
	};

	pi.registerTool({
		name: "workflow_start", label: "Start Workflow",
		description: "Start deterministic background execution for a reviewed workflow reference after the user explicitly asks to run it. Before launch, PiBox shows a user-owned TUI confirmation and switches the session and spawned subagents to permission bypass mode. The registered adapter refreshes current steps and advances routine ready work.",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const confirmed = await confirmWorkflowBypass(ctx, params.ref);
				if (!confirmed) return result(`Workflow start cancelled. ${params.ref} was not launched and permission mode was not changed.`, { ref: params.ref, cancelled: true });
				const adapter = adapterFor(params.ref);
				const preflight = await adapter.preflightWorkflow?.(params.ref, ctx);
				if (preflight && !preflight.ok) {
					const detail = preflight.detail ?? "Workflow preflight failed. Resolve the declared prerequisites and retry.";
					sendFeedback({ type: "error", workflowRef: params.ref, title: "Workflow preflight · attention", detail, cause: "preflight-failed", nextAction: "Configure the declared prerequisites without guessing values, then retry workflow_start." });
					sendEvent({ workflowRef: params.ref, title: "Workflow preflight · attention", detail, attention: true, cause: "preflight-failed", nextAction: "Configure the declared prerequisites, then retry workflow_start." });
					return result(detail, { ref: params.ref, attention: true, preflight });
				}
				await adapter.prepareWorkflow?.(params.ref, ctx);
				const snapshot = await adapter.snapshot(params.ref, ctx);
				activateWorkflowBypass();
				active.set(params.ref, "running"); currentRef = params.ref; currentSnapshot = snapshot; persist(params.ref, "running"); renderDashboard(ctx);
				void tick(ctx);
				return result(`Started workflow ${params.ref} in background with ${snapshot.steps.length} step(s).`, snapshot);
			} catch (error) {
				active.delete(params.ref);
				if (currentRef === params.ref) { currentRef = undefined; currentSnapshot = undefined; renderDashboard(ctx); }
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "workflow_control", label: "Control Workflow", description: "Pause, resume, or stop workflow execution. Stop terminates active attempts but preserves adapter-owned work; resume prepares incomplete stopped work and starts fresh attempts.",
		parameters: Type.Object({ ref: Type.String(), action: StringEnum(["pause", "resume", "stop"] as const) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const adapter = adapterFor(params.ref); await adapter.controlWorkflow(params.ref, params.action, ctx);
			if (params.action === "resume") active.set(params.ref, "running"); else if (params.action === "pause") active.set(params.ref, "paused"); else active.delete(params.ref);
			currentRef = params.ref; persist(params.ref, params.action === "stop" ? "stopped" : params.action === "resume" ? "running" : "paused");
			if (params.action === "stop") { currentSnapshot = undefined; renderDashboard(ctx); } else await tick(ctx);
			return result(`${params.action} recorded for workflow ${params.ref}.`);
		},
	});

	pi.registerTool({
		name: "workflow_checkpoint", label: "Decide Workflow Checkpoint",
		description: "Apply a review-loop decision. request_changes starts or reconciles the persistent fixer and automatically re-runs the same persistent reviewer after a successful fix; no separate resume is needed. Failed repair launch/reconciliation does not consume an iteration. retry re-runs review without repair; accept_risk is only for non-blocking findings.",
		parameters: Type.Object({ ref: Type.String({ description: "Exact evaluation step ref" }), action: StringEnum(["continue", "retry", "request_changes", "skip", "accept_risk"] as const), prompt: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const adapter = adapterFor(params.ref);
			if (!adapter.controlCheckpoint) throw new Error(`Workflow adapter does not support checkpoint decisions: ${params.ref}`);
			const decision = await adapter.controlCheckpoint(params.ref, params.action, params.prompt, ctx);
			const workflowRef = params.ref.split("/evaluation:")[0]!;
			active.set(workflowRef, "running"); currentRef = workflowRef; persist(workflowRef, "running");
			await tick(ctx);
			return result(params.action === "request_changes" ? `Repair and automatic re-review completed for ${params.ref}.` : `${params.action} recorded for ${params.ref}.`, decision);
		},
	});

	const registerSubagentSpawn = (catalog: SpawnableAgentDefinition[] = []) => {
		const available = catalog.length > 0
			? catalog.map((agent) => `${agent.name} (${agent.source}, ${agent.tier}) — ${agent.description}`).join("; ")
			: "The registered workflow adapter supplies the available definitions at session start.";
		pi.registerTool({
			name: "subagent_spawn", label: "Spawn Subagent",
			description: `Spawn a subagent from one configured agent definition and a complete task prompt. Available agents: ${available} Background is the default and returns immediately; foreground waits for settlement. Choose delegation only when it helps; managed workflow tasks remain internally scheduled by workflow_start/resume.`,
			parameters: Type.Object({
				agent: Type.String({ description: `Exact configured agent name. Available agents: ${catalog.length > 0 ? catalog.map((agent) => agent.name).join(", ") : "resolved at session start"}` }),
				task: Type.String({ description: "Complete assignment prompt for the child" }),
				mode: Type.Optional(StringEnum(["background", "foreground"] as const, { default: "background" })),
				tier: Type.Optional(StringEnum(["low", "medium", "high", "max"] as const, { description: "Defaults to medium; high/max require tierJustification" })),
				tierJustification: Type.Optional(Type.String({ description: "For high/max: why medium is insufficient, the irreducible ambiguity, and why more decomposition is unsafe or incoherent" })),
				model: Type.Optional(Type.String({ description: "Exceptional configured concrete model override; normally omit to use agent policy" })),
				effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
				strict: Type.Optional(Type.Boolean()),
			}, { additionalProperties: false }),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const adapter = dynamicAdapter();
				const mode = params.mode ?? "background";
				if ((params.tier === "high" || params.tier === "max") && (!params.tierJustification || params.tierJustification.trim().length < 20)) throw new Error(`${params.tier} routing requires a substantive tierJustification explaining why medium is insufficient, the irreducible ambiguity, and why further decomposition is unsafe or incoherent`);
				const request: DynamicSubagentRequest = {
					operationId: toolCallId, agent: params.agent, task: params.task,
					tier: params.tier ?? "medium",
					...(params.tierJustification ? { tierJustification: params.tierJustification } : {}),
					...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}), ...(params.strict !== undefined ? { strict: params.strict } : {}),
				};
				const tier = params.tier ?? "medium";
				let resolvedStatus: DynamicSubagentStarted | undefined;
				if (mode === "background") {
					runningSubagents.set(toolCallId, { agent: params.agent, mode, startedAt: Date.now(), ...(tier ? { tier } : {}) });
					renderSubagentStatus();
				}
				const runningDetails = () => ({ agent: params.agent, state: "running", tier, resolved: resolvedStatus });
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
		name: "subagent_status", label: "Subagent Status", description: "List logical subagents and open asynchronous messages across registered adapters.", parameters: Type.Object({}),
		async execute(_id, _params, _signal, _update, ctx) {
			const agents = (await Promise.all(adapters.map((adapter) => adapter.listSubagents(ctx)))).flat();
			const messages = (await Promise.all(adapters.map((adapter) => adapter.listMessages(ctx)))).flat();
			return result(agents.length ? JSON.stringify({ agents, openMessages: messages }, null, 2) : "No subagents recorded.", { agents, openMessages: messages });
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
					if (recorded.workflowRef && active.has(recorded.workflowRef)) { active.set(recorded.workflowRef, "running"); persist(recorded.workflowRef, "running"); void tick(ctx); }
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
		void tick(sessionCtx);
	});

	pi.on("session_start", async (_event, ctx) => {
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
		for (const [ref, state] of states) if (state !== "stopped") { active.set(ref, state); currentRef = ref; }
		if (currentRef) currentSnapshot = await adapterFor(currentRef).snapshot(currentRef, ctx).catch(() => undefined);
		renderDashboard(ctx);
		renderSubagentStatus();
		timer = setInterval(() => { if (sessionCtx) void tick(sessionCtx); }, 500); timer.unref();
		startVisualTimer();
		subagentPulseTimer = setInterval(() => {
			if (runningSubagents.size === 0) return;
			subagentPulseFrame++;
			renderSubagentStatus();
		}, SUBAGENT_PULSE_INTERVAL_MS);
		subagentPulseTimer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		if (subagentPulseTimer) clearInterval(subagentPulseTimer);
		if (visualTimer) clearInterval(visualTimer);
		timer = undefined;
		visualTimer = undefined;
		subagentPulseTimer = undefined;
		runningSubagents.clear();
		if (ctx.hasUI) ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		sessionCtx = undefined;
		dashboardInvalidate = undefined;
		dashboardTui = undefined;
		ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
