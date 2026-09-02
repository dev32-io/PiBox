import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { activateWorkflowBypass, confirmCriticalRisk, confirmWorkflowBypass, currentPermissionMode } from "../permissions/runtime.js";
import { isSubagentRuntime } from "../subagent/tool-policy.js";
import { hasWorkflowAttention } from "../workflow/story-runtime-store.js";
import { WORKFLOW_CONTROL_EVENT, WORKFLOW_LIFECYCLE_EVENT, type WorkflowAdapter, type WorkflowControlEvent, type WorkflowLifecycleEvent, type WorkflowPreflight } from "./api.js";
import { getWorkflowAdapterCapabilityRegistry } from "./capability-registry.js";
import { workflowDashboardLines } from "./dashboard.js";
import { WorkflowRunner, type WorkflowRunnerNotice } from "./runner.js";

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });
const bounded = (value: unknown, limit = 700) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);

export default function workflows(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;
	const registry = getWorkflowAdapterCapabilityRegistry();
	const runners = new Map<string, WorkflowRunner>();
	let sessionCtx: ExtensionContext | undefined;
	let selectedRef: string | undefined;
	let restoringReload = false;
	let shuttingDown = false;
	let unregisterRegistry: (() => void) | undefined;
	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let dashboardTui: { requestRender?: () => void } | undefined;

	const adapterFor = (ref: string): WorkflowAdapter => { const adapter = registry.resolve(ref); if (!adapter) throw new Error(`No target workflow adapter accepts ${ref}`); return adapter; };
	const sendLifecycle = (event: WorkflowLifecycleEvent) => { try { pi.events.emit(WORKFLOW_LIFECYCLE_EVENT, event); } catch { /* durable state remains authoritative */ } };
	const renderDashboard = () => {
		const ctx = sessionCtx; const snapshot = selectedRef ? runners.get(selectedRef)?.snapshot : undefined;
		if (!ctx?.hasUI || !snapshot) { ctx?.ui.setWidget("pibox-workflow", undefined); return; }
		ctx.ui.setWidget("pibox-workflow", (tui) => { dashboardTui = tui as unknown as { requestRender?: () => void }; return { render: (width: number) => workflowDashboardLines(runners.get(selectedRef!)?.snapshot?.runtime ?? snapshot.runtime, ctx, width, frame), invalidate() {} }; });
		if (!timer) {
			const animate = () => { const current = selectedRef ? runners.get(selectedRef)?.snapshot?.runtime : undefined; if (!current || current.status === "completed" || current.status === "paused" || current.status === "stopped") { timer = undefined; return; } timer = setTimeout(() => { frame++; dashboardTui?.requestRender?.(); animate(); }, 100); timer.unref(); };
			animate();
		}
	};
	const sendNotice = (notice: WorkflowRunnerNotice) => {
		if (selectedRef === notice.workflowRef) renderDashboard();
		if (!notice.attention) return;
		const safe = { ...notice, title: bounded(notice.title, 180), ...(notice.detail ? { detail: bounded(notice.detail) } : {}), ...(notice.nextAction ? { nextAction: bounded(notice.nextAction, 240) } : {}) };
		try { pi.sendMessage({ customType: "pibox-workflow-event", content: `[Workflow attention]\n${safe.title}${safe.detail ? `\n${safe.detail}` : ""}${safe.nextAction ? `\nNext: ${safe.nextAction}` : ""}`, display: true, details: safe }, { deliverAs: "steer", triggerTurn: true }); } catch { /* durable state remains */ }
	};
	const runnerFor = (ref: string): WorkflowRunner => {
		const existing = runners.get(ref); if (existing) return existing;
		if (!sessionCtx) throw new Error("Workflow runtime is not attached to a session");
		const runner = new WorkflowRunner(ref, adapterFor(ref), sessionCtx, { onProjection() { if (selectedRef === ref) renderDashboard(); }, onNotice: sendNotice, onLifecycle: sendLifecycle, onComplete(_ref, prompt) { try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* outcome remains durable */ } } });
		runners.set(ref, runner); return runner;
	};
	const reportPreflight = (ref: string, preflight: WorkflowPreflight) => {
		const detail = preflight.detail ?? "Workflow preflight failed. Resolve the declared prerequisites and retry.";
		sendLifecycle({ type: "error", workflowRef: ref, title: "Workflow preflight · attention", detail, cause: "preflight-failed", nextAction: "Configure the declared prerequisites, then retry." });
		return detail;
	};
	const requireResolvedAttention = async (adapter: WorkflowAdapter, ref: string, ctx: ExtensionContext) => {
		const snapshot = await adapter.snapshot(ref, ctx);
		if (hasWorkflowAttention(snapshot.runtime)) throw new Error(`Workflow ${ref} has unresolved attention; use workflow_control with action=request_changes or action=approve`);
	};
	const guardLaunch = async (adapter: WorkflowAdapter, ref: string, ctx: ExtensionContext, progress?: (phase: string) => void) => {
		progress?.("Validating prerequisites");
		const preflight = await adapter.preflightWorkflow?.(ref, ctx);
		if (preflight && !preflight.ok) return { ok: false as const, detail: reportPreflight(ref, preflight), preflight };
		progress?.("Building execution snapshot"); await adapter.snapshot(ref, ctx);
		if (currentPermissionMode() === "bypass") return { ok: true as const };
		if (!await confirmWorkflowBypass(ctx, ref)) return { ok: false as const, cancelled: true as const };
		activateWorkflowBypass(); return { ok: true as const };
	};

	pi.registerTool({ name: "workflow_start", label: "Start Workflow", description: "Start a reviewed target story through its stage state machine after explicit permission-bypass confirmation.", parameters: Type.Object({ ref: Type.String() }, { additionalProperties: false }), async execute(toolCallId, params, _signal, onUpdate, ctx) {
		const started = Date.now(); const progress = (phase: string) => onUpdate?.(result(`${phase} · ${Date.now() - started}ms`, { ref: params.ref, phase }));
		const guard = await guardLaunch(adapterFor(params.ref), params.ref, ctx, progress);
		if (!guard.ok) return "cancelled" in guard ? result(`Workflow start cancelled. ${params.ref} was not launched and permission mode was not changed.`, { cancelled: true }) : result(guard.detail, { attention: true, preflight: guard.preflight });
		selectedRef = params.ref; const runner = runnerFor(params.ref); await runner.command("start", `tool:${toolCallId}`); await runner.advance();
		return result(`Started target workflow ${params.ref}.`, runner.snapshot);
	} });

	pi.registerTool({ name: "workflow_control", label: "Control Workflow", description: "Pause, resume, stop, or resolve attention for a target workflow. Resume and attention resolution pass through the guarded launch path.", parameters: Type.Object({ ref: Type.String(), action: StringEnum(["pause", "resume", "stop", "approve", "request_changes"] as const), prompt: Type.Optional(Type.String({ maxLength: 4000 })), acceptedRisks: Type.Optional(Type.Array(Type.Object({ findingId: Type.String({ minLength: 1, maxLength: 200 }), rationale: Type.String({ minLength: 1, maxLength: 4000 }) }, { additionalProperties: false }), { maxItems: 200 })) }, { additionalProperties: false }), async execute(toolCallId, params, _signal, _update, ctx) {
		const adapter = adapterFor(params.ref);
		if (params.action === "approve" || params.action === "request_changes") {
			if (!adapter.resolveAttention) throw new Error(`Workflow ${params.ref} does not support target attention resolution`);
			const decision = { action: params.action, ...(params.prompt ? { prompt: params.prompt } : {}), ...(params.acceptedRisks ? { acceptedRisks: params.acceptedRisks } : {}) };
			const validated = await adapter.resolveAttention(params.ref, decision, ctx, { dryRun: true });
			if (params.action === "approve") {
				const criticalFindingIds = [...validated.stages.map((stage) => stage.review), validated.finalReview]
					.flatMap((review) => review.currentFindings.filter((finding) => finding.severity === "critical").map((finding) => finding.id));
				if (!criticalFindingIds.length) throw new Error(`Workflow ${params.ref} approval has no validated Critical review finding`);
				if (!await confirmCriticalRisk(ctx, params.ref, criticalFindingIds)) return result(`Workflow control cancelled. ${params.ref} Critical risk was not accepted; state, permission mode, and execution were not changed.`, { cancelled: true });
			}
			const guard = await guardLaunch(adapter, params.ref, ctx);
			if (!guard.ok) return "cancelled" in guard ? result(`Workflow control cancelled. ${params.ref} was not changed or resumed.`, { cancelled: true }) : result(guard.detail, { attention: true, preflight: guard.preflight });
			await adapter.resolveAttention(params.ref, decision, ctx); selectedRef = params.ref; const runner = runnerFor(params.ref); await runner.command("resume", `control:${toolCallId}`, { invokeDomainControl: true }); await runner.advance(); return result(`${params.action} recorded and ${params.ref} resumed.`, runner.snapshot);
		}
		if (params.action === "resume") { await requireResolvedAttention(adapter, params.ref, ctx); const guard = await guardLaunch(adapter, params.ref, ctx); if (!guard.ok) return "cancelled" in guard ? result(`Workflow resume cancelled. ${params.ref} was not resumed.`, { cancelled: true }) : result(guard.detail, { attention: true, preflight: guard.preflight }); }
		selectedRef = params.ref; const runner = runnerFor(params.ref); await runner.command(params.action, `tool:${toolCallId}`, { invokeDomainControl: true }); if (params.action === "resume") await runner.advance(); return result(`${params.action} recorded for ${params.ref}.`, runner.snapshot);
	} });

	pi.events.on(WORKFLOW_CONTROL_EVENT, (value: unknown) => { const event = value as WorkflowControlEvent; if (!sessionCtx || shuttingDown) return; void (async () => { if (event.action === "resume") { const adapter = adapterFor(event.ref); await requireResolvedAttention(adapter, event.ref, sessionCtx!); const guard = await guardLaunch(adapter, event.ref, sessionCtx!); if (!guard.ok) return; } selectedRef = event.ref; await runnerFor(event.ref).command(event.action, event.operationId ?? `event:${Date.now()}`, { invokeDomainControl: false }); })().catch((error) => sendNotice({ workflowRef: event.ref, title: `${event.ref} · control failed`, detail: error instanceof Error ? error.message : String(error), attention: true })); });

	const restoreAvailable = async () => {
		if (!sessionCtx || shuttingDown || !restoringReload) return;
		for (const adapter of registry.list()) for (const control of await adapter.listExecutionControls?.(sessionCtx).catch(() => []) ?? []) {
			if (control.mode !== "running" && control.mode !== "paused") continue;
			if (control.ownerSessionId && control.ownerSessionId !== sessionCtx.sessionManager.getSessionId()) continue;
			selectedRef = control.workflowRef; await runnerFor(control.workflowRef).command("attach", `reload:${control.workflowRef}`, { restoreMode: control.mode });
		}
		renderDashboard();
	};
	pi.on("session_start", async (event, ctx) => {
		shuttingDown = false; restoringReload = event.reason === "reload"; sessionCtx = ctx;
		unregisterRegistry?.(); unregisterRegistry = registry.subscribe(() => { void restoreAvailable(); });
		if (!restoringReload) for (const adapter of registry.list()) await adapter.reconcileActivation?.(ctx);
		await restoreAvailable();
	});
	pi.on("session_shutdown", async (_event, ctx) => { shuttingDown = true; await Promise.all([...runners.values()].map((runner) => runner.dispose())); runners.clear(); selectedRef = undefined; sessionCtx = undefined; restoringReload = false; unregisterRegistry?.(); unregisterRegistry = undefined; if (timer) clearTimeout(timer); timer = undefined; dashboardTui = undefined; ctx.ui.setWidget("pibox-workflow", undefined); });
}
