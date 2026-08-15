import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, WORKFLOW_FEEDBACK_EVENT, type DynamicSubagentRequest, type DynamicSubagentStarted, type SpawnableAgentDefinition, type WorkflowAdapter, type WorkflowAdapterDiscovery, type WorkflowControlEvent, type WorkflowFeedbackEvent, type WorkflowRunResult, type WorkflowSnapshot, type WorkflowStep } from "./api.js";
import { renderBuiltInPrompt } from "../workflow/prompt-loader.js";
import { SUBAGENT_PULSE_INTERVAL_MS, subagentPulseDot } from "./subagent-display.js";
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

type WorkflowNotice = { title: string; detail?: string; attention: boolean };
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
	let latestNotice: WorkflowNotice | undefined;
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
			const route = status.resolved
				? `${status.resolved.provider}/${status.resolved.model}#${status.resolved.effort}`
				: status.tier ? `${status.tier} tier` : "resolving model";
			return `${ctx.ui.theme.fg("warning", dot)} ${ctx.ui.theme.fg("text", status.agent)} ${ctx.ui.theme.fg("dim", `running · ${status.mode} · ${route} · ${formatElapsed(status.startedAt)}`)}`;
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

	const sendEvent = (title: string, detail?: string, attention = false) => {
		latestNotice = { title, ...(detail ? { detail } : {}), attention };
		if (sessionCtx) renderDashboard(sessionCtx);
		try {
			// Keep workflow plumbing out of chat history; attention still steers the orchestrator.
			pi.sendMessage({ customType: "pibox-workflow-event", content: `[Workflow ${attention ? "attention" : "event"}]\n${title}${detail ? `\n${detail}` : ""}`, display: false }, attention
				? { deliverAs: "steer", triggerTurn: true }
				: { deliverAs: "steer", triggerTurn: false });
		} catch {
			// A replacement or closing session will reconcile from durable adapter state.
		}
	};

	const rawTaskLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext): string[] => {
		const done = snapshot.steps.filter((step) => step.status === "done").length;
		const lines = [ctx.ui.theme.fg("accent", ctx.ui.theme.bold(`Workflow · ${snapshot.title} · ${done}/${snapshot.steps.length} steps`))];
		for (const step of snapshot.steps) {
			let icon: string;
			let color: "success" | "warning" | "error" | "muted" | "accent" = "muted";
			if (step.status === "done") { icon = "✓"; color = "success"; }
			else if (step.status === "running") {
				const frames = RUNNING_FRAMES[step.kind] ?? DEFAULT_RUNNING_FRAMES;
				icon = frames[frame % frames.length]!;
				color = "accent";
			}
			else if (step.status === "attention") { icon = step.detail?.includes("fail") ? "×" : "!"; color = step.detail?.includes("fail") ? "error" : "warning"; }
			else if (step.status === "cancelled") icon = "–";
			else icon = "○";
			lines.push(`${ctx.ui.theme.fg(color, `${icon} `)}${step.title}`);
		}
		return lines;
	};

	const dashboardLines = (snapshot: WorkflowSnapshot, ctx: ExtensionContext, width: number): string[] => {
		const innerWidth = Math.max(1, width - 2);
		const tasks = rawTaskLines(snapshot, ctx);
		const separatorWidth = 3;
		const naturalTaskWidth = Math.max(...tasks.map((task) => visibleWidth(task)));
		const maxTaskWidth = Math.max(28, Math.floor(innerWidth * 0.58));
		const compactTaskWidth = Math.min(naturalTaskWidth, maxTaskWidth);
		const availableEventWidth = innerWidth - compactTaskWidth - separatorWidth;
		const showNotice = Boolean(latestNotice && innerWidth >= 72 && availableEventWidth >= 22);
		const taskWidth = showNotice ? compactTaskWidth : innerWidth;
		const eventWidth = showNotice ? availableEventWidth : 0;
		const separator = ctx.ui.theme.fg("borderMuted", " │ ");
		const notice = latestNotice;
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

	const renderDashboard = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || !currentSnapshot) { ctx.ui.setWidget("pibox-workflow", undefined); return; }
		ctx.ui.setWidget("pibox-workflow", (_tui, _theme) => ({
			render(width: number) { return dashboardLines(currentSnapshot!, ctx, width); },
			invalidate() {},
		}));
	};

	const settleStep = async (adapter: WorkflowAdapter, step: WorkflowStep, promise: Promise<WorkflowRunResult>, ctx: ExtensionContext, workflowRef?: string) => {
		try {
			const settled = await promise;
			const attention = Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed");
			sendEvent(`${step.title} · ${settled.state}`, settled.summary, attention);
			if (workflowRef && step.kind === "task" && settled.state === "completed" && !attention) {
				sendFeedback({ type: "task-completed", workflowRef, stepRef: step.ref, title: step.title, detail: settled.summary });
			}
			if (attention) {
				if (workflowRef) {
					active.set(workflowRef, "paused"); persist(workflowRef, "paused");
					sendFeedback({ type: "error", workflowRef, stepRef: step.ref, title: step.title, detail: settled.summary });
				}
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			if (workflowRef) {
				active.set(workflowRef, "paused"); persist(workflowRef, "paused");
				sendFeedback({ type: "error", workflowRef, stepRef: step.ref, title: step.title, detail });
			}
			sendEvent(`${step.title} · failed`, detail, true);
		} finally {
			inFlight.delete(step.ref);
			await tick(ctx);
		}
	};

	const startStep = (adapter: WorkflowAdapter, step: WorkflowStep, ctx: ExtensionContext, signal?: AbortSignal): Promise<WorkflowRunResult> => {
		if (inFlight.has(step.ref)) throw new Error(`Step is already running: ${step.ref}`);
		inFlight.add(step.ref);
		sendEvent(`Starting ${step.title}`);
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
						sendFeedback({ type: "error", workflowRef: ref, title: ref, detail });
						sendEvent(`${ref} · attention`, detail, true);
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
				if (snapshot.status === "attention" && !snapshot.steps.some((step) => inFlight.has(step.ref))) {
					active.set(ref, "paused"); persist(ref, "paused");
					const attentionSteps = snapshot.steps.filter((step) => step.status === "attention");
					const detail = attentionSteps.map((step) => `${step.ref}: ${step.detail ?? "needs intervention"}`).join("\n");
					const checkpoint = attentionSteps.find((step) => step.kind === "evaluation");
					const guidance = `${detail || "Workflow needs intervention."}${checkpoint ? `\nUse workflow_checkpoint on ${checkpoint.ref} to request changes, retry the same reviewer, continue, skip, or accept non-blocking risk. Do not manipulate Git or task state manually.` : ""}`;
					sendFeedback({ type: "error", workflowRef: ref, ...(attentionSteps[0] ? { stepRef: attentionSteps[0].ref } : {}), title: snapshot.title, detail: guidance });
					sendEvent(`${snapshot.title} · attention`, guidance, true);
					continue;
				}
				if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
					active.delete(ref); persist(ref, "stopped"); sendEvent(`${snapshot.title} · complete`, "Finished all workflow steps.");
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
			if (currentRef) sendFeedback({ type: "error", workflowRef: currentRef, title: "Workflow runner", detail });
			sendEvent("Workflow runner · attention", detail, true);
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
		description: "Apply the main orchestrator's decision at an actionable review/fix checkpoint. Use request_changes with a live repair prompt, retry to re-run the same reviewer, continue after an accepted clean state, skip only when justified, or accept_risk for non-blocking findings.",
		parameters: Type.Object({ ref: Type.String({ description: "Exact evaluation step ref" }), action: StringEnum(["continue", "retry", "request_changes", "skip", "accept_risk"] as const), prompt: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			const adapter = adapterFor(params.ref);
			if (!adapter.controlCheckpoint) throw new Error(`Workflow adapter does not support checkpoint decisions: ${params.ref}`);
			const decision = await adapter.controlCheckpoint(params.ref, params.action, params.prompt, ctx);
			const workflowRef = params.ref.split("/evaluation:")[0]!;
			active.set(workflowRef, "running"); currentRef = workflowRef; persist(workflowRef, "running");
			await tick(ctx);
			return result(`${params.action} recorded for ${params.ref}.`, decision);
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
				tier: Type.Optional(StringEnum(["low", "medium", "high", "max"] as const)),
				model: Type.Optional(Type.String({ description: "Exceptional configured concrete model override; normally omit to use agent policy" })),
				effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
				strict: Type.Optional(Type.Boolean()),
			}, { additionalProperties: false }),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const adapter = dynamicAdapter();
				const mode = params.mode ?? "background";
				const request: DynamicSubagentRequest = {
					operationId: toolCallId, agent: params.agent, task: params.task,
					...(params.tier ? { tier: params.tier } : {}),
					...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}), ...(params.strict !== undefined ? { strict: params.strict } : {}),
				};
				if (mode === "background") {
					const catalogTier = catalog.find((agent) => agent.name === params.agent)?.tier;
					const tier = params.tier ?? catalogTier;
					runningSubagents.set(toolCallId, { agent: params.agent, mode, startedAt: Date.now(), ...(tier ? { tier } : {}) });
					renderSubagentStatus();
				}
				const promise = adapter.spawnSubagent!(
					request,
					ctx,
					mode === "foreground" ? signal : undefined,
					mode === "foreground" && onUpdate ? (text) => onUpdate(result(text, { agent: params.agent, state: "running" })) : undefined,
					mode === "background" ? (resolved) => {
						const current = runningSubagents.get(toolCallId);
						if (current) runningSubagents.set(toolCallId, { ...current, resolved });
						renderSubagentStatus();
					} : undefined,
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
		timer = undefined;
		subagentPulseTimer = undefined;
		runningSubagents.clear();
		if (ctx.hasUI) ctx.ui.setStatus(SUBAGENT_STATUS_KEY, undefined);
		sessionCtx = undefined;
		ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
