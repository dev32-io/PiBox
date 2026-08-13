import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { WORKFLOW_ADAPTER_DISCOVERY_EVENT, WORKFLOW_CONTROL_EVENT, type DynamicSubagentRequest, type WorkflowAdapter, type WorkflowAdapterDiscovery, type WorkflowControlEvent, type WorkflowRunResult, type WorkflowSnapshot, type WorkflowStep } from "./api.js";

const TOOL_NAMES = ["workflow_start", "workflow_control", "subagent_spawn", "subagent_status", "subagent_control", "subagent_respond"];
const RUNNING_FRAMES: Record<string, readonly string[]> = {
	task: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	merge: ["⇢", "→", "⇢", "⇒"],
	evaluation: ["◐", "◓", "◑", "◒"],
};
const DEFAULT_RUNNING_FRAMES = RUNNING_FRAMES.task!;

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

type WorkflowNotice = { title: string; detail?: string; attention: boolean };

export default function workflows(pi: ExtensionAPI): void {
	const adapters: WorkflowAdapter[] = [];
	const active = new Map<string, "running" | "paused">();
	const inFlight = new Set<string>();
	let currentRef: string | undefined;
	let currentSnapshot: WorkflowSnapshot | undefined;
	let timer: NodeJS.Timeout | undefined;
	let ticking = false;
	let frame = 0;
	let sessionCtx: ExtensionContext | undefined;
	let latestNotice: WorkflowNotice | undefined;

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
			sendEvent(`${step.title} · ${settled.state}`, settled.summary, Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed"));
			if (settled.attention || settled.state === "blocked" || settled.state === "failed") {
				if (workflowRef) { active.set(workflowRef, "paused"); persist(workflowRef, "paused"); }
			}
		} catch (error) {
			if (workflowRef) { active.set(workflowRef, "paused"); persist(workflowRef, "paused"); }
			sendEvent(`${step.title} · failed`, error instanceof Error ? error.message : String(error), true);
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
						active.set(ref, "paused"); persist(ref, "paused");
						sendEvent(`${ref} · attention`, error instanceof Error ? error.message : String(error), true);
					}
					continue;
				}
				if (ref === currentRef) {
					currentSnapshot = { ...snapshot, steps: snapshot.steps.map((step) => inFlight.has(step.ref) && step.status !== "done" ? { ...step, status: "running" } : step) };
					renderDashboard(ctx);
				}
				if (state !== "running") continue;
				if (snapshot.status === "attention") { active.set(ref, "paused"); persist(ref, "paused"); sendEvent(`${snapshot.title} · attention`, "Workflow needs intervention.", true); continue; }
				if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
					active.delete(ref); persist(ref, "stopped"); sendEvent(`${snapshot.title} · complete`, "Finished all workflow steps.");
					const prompt = await adapter.completionPrompt?.(ref, ctx) ?? `Workflow ${ref} completed. Brief the user on what was delivered, verification outcomes, deviations, residual risks, and the branch or next action. Inspect the workflow's canonical outcome artifact when available and combine it with lifecycle evidence already observed; do not reply silently.`;
					try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* session recovery can inspect canonical completion state */ }
					continue;
				}
				for (const step of runnable(snapshot)) {
					const promise = startStep(adapter, step, ctx);
					void settleStep(adapter, step, promise, ctx, ref);
				}
			}
		} catch (error) {
			sendEvent("Workflow runner · attention", error instanceof Error ? error.message : String(error), true);
		} finally { ticking = false; }
	};

	pi.registerTool({
		name: "workflow_start", label: "Start Workflow",
		description: "Start deterministic background execution for a reviewed workflow reference after the user explicitly asks to run it. No separate approval command is required. The registered adapter refreshes current steps and advances routine ready work.",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(_id, params, _signal, _update, ctx) {
			try {
				const adapter = adapterFor(params.ref);
				await adapter.prepareWorkflow?.(params.ref, ctx);
				const snapshot = await adapter.snapshot(params.ref, ctx);
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
		name: "subagent_spawn", label: "Spawn Subagent",
		description: "Spawn a read-only subagent from a configured specialist role and task prompt. Background is the default and returns immediately; foreground waits for settlement. Managed implementation tasks are spawned internally by workflow_start/resume through the same coordinator and lifecycle registry.",
		parameters: Type.Object({
			role: Type.String({ description: "Exact configured role name, such as plan-critic, explorer, researcher, or quality-reviewer" }),
			task: Type.String({ description: "Complete assignment prompt for the child" }),
			mode: Type.Optional(StringEnum(["background", "foreground"] as const, { default: "background" })),
			tier: Type.Optional(StringEnum(["low", "medium", "high", "max"] as const)),
			deliberation: Type.Optional(StringEnum(["standard", "deep"] as const)),
			model: Type.Optional(Type.String({ description: "Exceptional configured concrete model override; normally omit to use role policy" })),
			effort: Type.Optional(StringEnum(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)),
			strict: Type.Optional(Type.Boolean()),
		}, { additionalProperties: false }),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const adapter = dynamicAdapter();
			const mode = params.mode ?? "background";
			const request: DynamicSubagentRequest = {
				operationId: toolCallId, role: params.role, task: params.task,
				...(params.tier ? { tier: params.tier } : {}), ...(params.deliberation ? { deliberation: params.deliberation } : {}),
				...(params.model ? { model: params.model } : {}), ...(params.effort ? { effort: params.effort } : {}), ...(params.strict !== undefined ? { strict: params.strict } : {}),
			};
			// Esc cancels only an explicitly foreground child. Background children are
			// controlled through subagent_control and survive the launching turn.
			const promise = adapter.spawnSubagent!(request, ctx, mode === "foreground" ? signal : undefined, mode === "foreground" && onUpdate ? (text) => onUpdate(result(text, { role: params.role, state: "running" })) : undefined);
			if (mode === "foreground") {
				const settled = await promise;
				if (settled.state === "failed") throw new Error(settled.summary);
				return result(settled.summary, settled);
			}
			void promise.then((settled) => sendEvent(`${params.role} · ${settled.state}`, settled.summary, Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed"))).catch((error) => sendEvent(`${params.role} · failed`, error instanceof Error ? error.message : String(error), true));
			return result(`Spawned ${params.role} in background. Lifecycle and attention updates will be delivered to this session.`, { role: params.role, state: "starting" });
		},
	});

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
		timer = setInterval(() => { if (sessionCtx) void tick(sessionCtx); }, 500); timer.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer); timer = undefined; sessionCtx = undefined; ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
