import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { activateWorkflowBypass, confirmWorkflowBypass } from "../permissions/runtime.js";
import { isSubagentRuntime } from "../subagent/tool-policy.js";
import { WORKFLOW_CONTROL_EVENT, WORKFLOW_LIFECYCLE_EVENT, type WorkflowAdapter, type WorkflowControlEvent, type WorkflowLifecycleEvent, type WorkflowPreflight } from "./api.js";
import { getWorkflowAdapterCapabilityRegistry } from "./capability-registry.js";
import { workflowDashboardLines } from "./dashboard.js";
import { WorkflowRunner, type WorkflowRunnerNotice } from "./runner.js";
import { renderWorkflowEventMessage } from "./workflow-event-display.js";

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });

function bounded(value: unknown, limit = 700): string {
	return String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);
}

export default function workflows(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;
	pi.registerMessageRenderer("pibox-workflow-event", renderWorkflowEventMessage);
	const registry = getWorkflowAdapterCapabilityRegistry();
	const runners = new Map<string, WorkflowRunner>();
	const restoredRefs = new Set<string>();
	let sessionCtx: ExtensionContext | undefined;
	let selectedRef: string | undefined;
	let frame = 0;
	let visualTimer: NodeJS.Timeout | undefined;
	let dashboardTui: { requestRender?: () => void } | undefined;
	let unregisterRegistry: (() => void) | undefined;
	let shuttingDown = false;
	let restoringReload = false;

	const adapterFor = (ref: string): WorkflowAdapter => {
		const adapter = registry.resolve(ref);
		if (!adapter) throw new Error(`No workflow adapter accepts ${ref}`);
		return adapter;
	};

	const sendLifecycle = (event: WorkflowLifecycleEvent) => {
		try { pi.events.emit(WORKFLOW_LIFECYCLE_EVENT, event); }
		catch { /* Replacement sessions reconcile from durable workflow state. */ }
	};

	const renderDashboard = () => {
		const ctx = sessionCtx;
		const snapshot = selectedRef ? runners.get(selectedRef)?.snapshot : undefined;
		if (!ctx?.hasUI || !snapshot) {
			ctx?.ui.setWidget("pibox-workflow", undefined);
			return;
		}
		ctx.ui.setWidget("pibox-workflow", (tui) => {
			dashboardTui = tui as unknown as { requestRender?: () => void };
			return { render: (width: number) => workflowDashboardLines(runners.get(selectedRef!)?.snapshot ?? snapshot, ctx, width, frame), invalidate() {} };
		});
		startVisualTimer();
	};

	const sendNotice = (notice: WorkflowRunnerNotice) => {
		const safe = {
			...notice,
			title: bounded(notice.title, 180),
			...(notice.detail ? { detail: bounded(notice.detail) } : {}),
			...(notice.nextAction ? { nextAction: bounded(notice.nextAction, 240) } : {}),
		};
		if (selectedRef === notice.workflowRef) renderDashboard();
		const reviewCompleted = !safe.attention && safe.kind === "evaluation" && safe.toStatus === "done";
		if (!safe.attention && !reviewCompleted) return;
		try {
			const detail = [safe.detail, safe.cause ? `Cause: ${bounded(safe.cause, 120)}` : undefined, safe.nextAction ? `Next: ${safe.nextAction}` : undefined].filter(Boolean).join("\n");
			pi.sendMessage({ customType: "pibox-workflow-event", content: `[${safe.attention ? "Workflow attention" : "Workflow progress"}]\n${safe.title}${detail ? `\n${detail}` : ""}`, display: true, details: safe }, { deliverAs: safe.attention ? "steer" : "followUp", triggerTurn: true });
		} catch { /* Durable state remains available. */ }
	};

	function startVisualTimer(): void {
		if (visualTimer || !sessionCtx) return;
		const schedule = () => {
			const snapshot = selectedRef ? runners.get(selectedRef)?.snapshot : undefined;
			if (!snapshot) return;
			const animated = snapshot.steps.some((step) => step.status === "running");
			const live = snapshot.metrics?.live;
			const timing = Boolean(live && (live.running || live.activeAgents > 0 || live.activeVerifications > 0));
			if (!animated && !timing) return;
			const delay = animated ? 90 : Math.max(50, 1_000 - (Date.now() % 1_000));
			visualTimer = setTimeout(() => {
				visualTimer = undefined;
				if (animated) frame++;
				dashboardTui?.requestRender?.();
				schedule();
			}, delay);
			visualTimer.unref();
		};
		schedule();
	}

	const runnerFor = (ref: string): WorkflowRunner => {
		const existing = runners.get(ref);
		if (existing) return existing;
		if (!sessionCtx) throw new Error("Workflow runtime is not attached to a session");
		const runner = new WorkflowRunner(ref, adapterFor(ref), sessionCtx, {
			onProjection(projection) {
				if (selectedRef === projection.ref) renderDashboard();
			},
			onNotice: sendNotice,
			onLifecycle: sendLifecycle,
			onComplete(_ref, prompt) {
				try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); }
				catch { /* Canonical completion remains durable. */ }
			},
		});
		runners.set(ref, runner);
		return runner;
	};

	const reportPreflight = (ref: string, preflight: WorkflowPreflight) => {
		const detail = preflight.detail ?? "Workflow preflight failed. Resolve the declared prerequisites and retry.";
		sendLifecycle({ type: "error", workflowRef: ref, title: "Workflow preflight · attention", detail, cause: "preflight-failed", nextAction: "Configure the declared prerequisites without guessing values, then retry workflow_start." });
		sendNotice({ workflowRef: ref, title: "Workflow preflight · attention", detail, attention: true, cause: "preflight-failed", nextAction: "Configure the declared prerequisites, then retry workflow_start." });
		return detail;
	};

	pi.registerTool({
		name: "workflow_start", label: "Start Workflow",
		description: "Start deterministic background execution for a reviewed workflow reference after the user explicitly asks to run it. Before launch, PiBox shows a user-owned TUI confirmation and switches the session and spawned subagents to permission bypass mode.",
		parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, onUpdate, ctx) {
			const started = Date.now();
			const progress = (phase: string) => {
				const text = `${phase} · ${Date.now() - started}ms`;
				onUpdate?.(result(text, { ref: params.ref, phase, elapsedMs: Date.now() - started }));
				if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", text);
			};
			try {
				if (!await confirmWorkflowBypass(ctx, params.ref)) return result(`Workflow start cancelled. ${params.ref} was not launched and permission mode was not changed.`, { ref: params.ref, cancelled: true });
				const adapter = adapterFor(params.ref);
				progress("Validating prerequisites");
				const preflight = await adapter.preflightWorkflow?.(params.ref, ctx);
				if (preflight && !preflight.ok) return result(reportPreflight(params.ref, preflight), { ref: params.ref, attention: true, preflight });
				progress("Building execution snapshot");
				await adapter.snapshot(params.ref, ctx);
				progress("Starting workflow");
				activateWorkflowBypass();
				selectedRef = params.ref;
				const runner = runnerFor(params.ref);
				await runner.command("start", `tool:${toolCallId}`, {
					onStartProgress(update) {
						onUpdate?.(result(`${update.phase} · ${update.elapsedMs}ms`, { ref: params.ref, ...update }));
						if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", `${update.phase} · ${update.elapsedMs}ms`);
					},
				});
				await runner.advance();
				const snapshot = runner.snapshot;
				return result(`Started workflow ${params.ref} in background with ${snapshot?.steps.length ?? 0} step(s).`, snapshot);
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("pibox-workflow-start", undefined);
			}
		},
	});

	pi.registerTool({
		name: "workflow_control", label: "Control Workflow",
		description: "Pause, resume, or stop workflow execution. Stop terminates active attempts but preserves adapter-owned work; resume prepares incomplete stopped work and starts fresh attempts.",
		parameters: Type.Object({ ref: Type.String(), action: StringEnum(["pause", "resume", "stop"] as const) }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, _ctx) {
			selectedRef = params.ref;
			const runner = runnerFor(params.ref);
			await runner.command(params.action, `tool:${toolCallId}`, { invokeDomainControl: true });
			if (params.action === "stop" && selectedRef === params.ref) {
				selectedRef = [...runners.values()].find((candidate) => candidate.ref !== params.ref && candidate.snapshot)?.ref;
				renderDashboard();
			}
			return result(`${params.action} recorded for workflow ${params.ref}.`);
		},
	});

	pi.registerTool({
		name: "workflow_checkpoint", label: "Review checkpoint",
		description: "Choose the meaningful review outcome: approve (optionally with structured acceptedRisks) or request_changes. The runner durably resumes checkpoint-driven continuation.",
		parameters: Type.Object({ ref: Type.String({ description: "Exact evaluation step ref" }), action: StringEnum(["approve", "request_changes"] as const), prompt: Type.Optional(Type.String()), acceptedRisks: Type.Optional(Type.Array(Type.Object({ findingId: Type.String(), rationale: Type.String() }))) }, { additionalProperties: false }),
		async execute(toolCallId, params, _signal, _update, ctx) {
			const workflowRef = params.ref.split("/evaluation:")[0]!;
			const adapter = adapterFor(workflowRef);
			const controlCheckpoint = adapter.controlCheckpoint;
			if (!controlCheckpoint) throw new Error(`Workflow adapter does not support checkpoint decisions: ${params.ref}`);
			selectedRef = workflowRef;
			const runner = runnerFor(workflowRef);
			let decision: unknown;
			try {
				await runner.command("resume", `checkpoint:${toolCallId}`, {
					invokeDomainControl: false,
					async mutateDomain() {
						decision = await controlCheckpoint.call(adapter, params.ref, params.action, { ...(params.prompt ? { prompt: params.prompt } : {}), ...(params.acceptedRisks ? { acceptedRisks: params.acceptedRisks } : {}) }, ctx);
					},
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("USER_DECISION_REQUIRED")) return result(message, { userDecisionRequired: true, ref: params.ref });
				throw error;
			}
			await runner.advance();
			return result(params.action === "request_changes" ? `Request changes recorded for ${params.ref}. Managed repair and automatic re-review are running in the background.` : `Approve recorded for ${params.ref}.`, decision);
		},
	});

	pi.events.on(WORKFLOW_CONTROL_EVENT, (event: unknown) => {
		const command = event as WorkflowControlEvent;
		if (!sessionCtx || shuttingDown) return;
		selectedRef = command.ref;
		void runnerFor(command.ref).command(command.action, command.operationId ?? `event:${command.ref}:${command.action}:${Date.now()}`, { invokeDomainControl: false }).catch((error) => {
			sendNotice({ workflowRef: command.ref, title: `${command.ref} · control failed`, detail: error instanceof Error ? error.message : String(error), attention: true, cause: "control-event-failed" });
		});
	});

	const restoreAvailable = async () => {
		const ctx = sessionCtx;
		if (!ctx || shuttingDown || !restoringReload) return;
		for (const adapter of registry.list()) {
			const records = adapter.listExecutionControls ? await adapter.listExecutionControls(ctx).catch(() => []) : [];
			for (const record of records) {
				if (restoredRefs.has(record.workflowRef) || (record.mode !== "running" && record.mode !== "paused")) continue;
				if (record.ownerSessionId && record.ownerSessionId !== ctx.sessionManager.getSessionId()) continue;
				const runner = runnerFor(record.workflowRef);
				await runner.command("attach", `session:${ctx.sessionManager.getSessionId()}:attach:${record.generation}`, { restoreMode: record.mode });
				restoredRefs.add(record.workflowRef);
				selectedRef = record.workflowRef;
			}
		}
		renderDashboard();
	};

	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false;
		restoringReload = event.reason === "reload";
		sessionCtx = ctx;
		unregisterRegistry?.();
		unregisterRegistry = registry.subscribe(() => { if (sessionCtx && !shuttingDown) void restoreAvailable(); });
		restoredRefs.clear();
		await restoreAvailable();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		await Promise.all([...runners.values()].map(async (runner) => {
			if (runner.mode === "running" || runner.mode === "paused") await runner.command("detach", `session:${ctx.sessionManager.getSessionId()}:detach:${runner.generation ?? 0}`, { invokeDomainControl: false }).catch(() => undefined);
			await runner.dispose();
		}));
		runners.clear();
		restoredRefs.clear();
		selectedRef = undefined;
		sessionCtx = undefined;
		unregisterRegistry?.();
		unregisterRegistry = undefined;
		restoringReload = false;
		if (visualTimer) clearTimeout(visualTimer);
		visualTimer = undefined;
		dashboardTui = undefined;
		ctx.ui.setWidget("pibox-workflow", undefined);
	});
}
