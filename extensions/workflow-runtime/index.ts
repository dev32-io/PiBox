import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { activateWorkflowBypass, confirmCriticalRisk, confirmWorkflowBypass, currentPermissionMode } from "../permissions/runtime.js";
import { SUBAGENT_ANIMATION_INTERVAL_MS } from "../subagent/display.js";
import { isSubagentRuntime } from "../subagent/tool-policy.js";
import { getSubagentUiProjectionRegistry } from "../subagent/ui-projection.js";
import { authoritativeAttentionTarget, hasWorkflowAttention } from "../workflow/story-runtime-store.js";
import { WORKFLOW_CONTROL_EVENT, WORKFLOW_LIFECYCLE_EVENT, type WorkflowAdapter, type WorkflowControlEvent, type WorkflowLifecycleEvent, type WorkflowPreflight } from "./api.js";
import { getWorkflowAdapterCapabilityRegistry } from "./capability-registry.js";
import { workflowDashboardNeedsAnimation, workflowDashboardsLines, type WorkflowDashboardEntry } from "./dashboard.js";
import { WorkflowRunner, type WorkflowRunnerNotice } from "./runner.js";
import { registerWorkflowRunnerRestorer } from "./runner-restoration.js";

const result = (text: string, details: unknown = null) => ({ content: [{ type: "text" as const, text }], details });
const bounded = (value: unknown, limit = 700) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, limit);
const CORRECTION_CHECK = Type.Union([
	Type.String({ minLength: 1 }),
	Type.Object({ id: Type.Optional(Type.String({ minLength: 1 })), command: Type.String({ minLength: 1 }), profile: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
const EXECUTION_CORRECTION = Type.Object({
	attentionEpoch: Type.Integer({ minimum: 1 }),
	target: Type.Union([
		Type.Object({ kind: Type.Literal("task"), stageId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("stage-verification"), stageId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("integration"), stageId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("stage-review"), stageId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("final-review") }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("e2e") }, { additionalProperties: false }),
	]),
	task: Type.Optional(Type.Object({ description: Type.Optional(Type.String({ minLength: 1 })), scope: Type.Optional(Type.String({ minLength: 1 })), delivery: Type.Optional(Type.String({ minLength: 1 })), checks: Type.Optional(Type.Array(CORRECTION_CHECK)) }, { additionalProperties: false })),
	stageVerification: Type.Optional(Type.Object({ checks: Type.Array(CORRECTION_CHECK) }, { additionalProperties: false })),
}, { additionalProperties: false });

export default function workflows(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;
	const registry = getWorkflowAdapterCapabilityRegistry();
	const subagentUi = getSubagentUiProjectionRegistry();
	const runners = new Map<string, WorkflowRunner>();
	let sessionCtx: ExtensionContext | undefined;
	let selectedRef: string | undefined;
	let shuttingDown = false;
	let unregisterSubagentUi: (() => void) | undefined;
	let unregisterRunnerRestorer: (() => void) | undefined;
	let frame = 0;
	let timer: NodeJS.Timeout | undefined;
	let dashboardTui: { requestRender?: () => void } | undefined;
	let dashboardSubagentKey = "";

	const adapterFor = (ref: string): WorkflowAdapter => { const adapter = registry.resolve(ref); if (!adapter) throw new Error(`No target workflow adapter accepts ${ref}`); return adapter; };
	const sendLifecycle = (event: WorkflowLifecycleEvent) => { try { pi.events.emit(WORKFLOW_LIFECYCLE_EVENT, event); } catch { /* durable state remains authoritative */ } };
	const dashboardEntries = (): WorkflowDashboardEntry[] => {
		const seenStories = new Set<string>();
		return [...runners.values()].flatMap((runner) => {
			if ((runner.mode !== "running" && runner.mode !== "paused") || !runner.snapshot) return [];
			const storyId = runner.snapshot.runtime.storyId;
			const workflowChildren = seenStories.has(storyId) ? undefined : subagentUi.projectWorkflow(storyId);
			seenStories.add(storyId);
			return [{ snapshot: runner.snapshot, ...(workflowChildren ? { workflowChildren } : {}) }];
		});
	};
	const subagentKey = (entries: readonly WorkflowDashboardEntry[]) => JSON.stringify(entries.map((entry) => [entry.snapshot.runtime.storyId, entry.workflowChildren?.agents ?? []]));
	const stopDashboardTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
	const clearDashboard = (ctx?: ExtensionContext) => {
		stopDashboardTimer(); dashboardTui = undefined; dashboardSubagentKey = ""; frame = 0;
		ctx?.ui.setWidget("pibox-workflow", undefined);
	};
	const syncDashboardTimer = () => {
		const entries = dashboardEntries();
		if (!sessionCtx?.hasUI || !dashboardTui || !entries.some((entry) => workflowDashboardNeedsAnimation(entry))) { stopDashboardTimer(); return; }
		if (timer) return;
		timer = setTimeout(() => {
			timer = undefined; frame++; dashboardTui?.requestRender?.(); syncDashboardTimer();
		}, SUBAGENT_ANIMATION_INTERVAL_MS);
		timer.unref();
	};
	const renderDashboard = () => {
		const ctx = sessionCtx;
		const entries = dashboardEntries();
		if (!ctx?.hasUI || !entries.length) { clearDashboard(ctx); return; }
		dashboardSubagentKey = subagentKey(entries);
		ctx.ui.setWidget("pibox-workflow", (tui) => {
			dashboardTui = tui as unknown as { requestRender?: () => void };
			return {
				render: (width: number) => workflowDashboardsLines(dashboardEntries(), ctx, width, frame),
				invalidate() {},
			};
		});
		syncDashboardTimer();
	};
	const sendNotice = (notice: WorkflowRunnerNotice) => {
		if (runners.has(notice.workflowRef)) renderDashboard();
		if (!notice.attention) return;
		const safe = { ...notice, title: bounded(notice.title, 180), ...(notice.detail ? { detail: bounded(notice.detail) } : {}), ...(notice.nextAction ? { nextAction: bounded(notice.nextAction, 240) } : {}) };
		try { pi.sendMessage({ customType: "pibox-workflow-event", content: `[Workflow attention]\n${safe.title}${safe.detail ? `\n${safe.detail}` : ""}${safe.nextAction ? `\nNext: ${safe.nextAction}` : ""}`, display: true, details: safe }, { deliverAs: "steer", triggerTurn: true }); } catch { /* durable state remains */ }
	};
	const runnerFor = (ref: string): WorkflowRunner => {
		const existing = runners.get(ref); if (existing) return existing;
		if (!sessionCtx) throw new Error("Workflow runtime is not attached to a session");
		const runner = new WorkflowRunner(ref, adapterFor(ref), sessionCtx, { onProjection() { renderDashboard(); }, onNotice: sendNotice, onLifecycle: sendLifecycle, onComplete(_ref, prompt) { try { pi.sendMessage({ customType: "pibox-workflow-complete", content: prompt, display: false }, { deliverAs: "steer", triggerTurn: true }); } catch { /* outcome remains durable */ } } });
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
	const guardLaunch = async (adapter: WorkflowAdapter, ref: string, ctx: ExtensionContext, progress?: (phase: string) => void, projectedRuntime?: import("../workflow/story-runtime-store.js").StoryRuntimeState) => {
		progress?.("Validating prerequisites");
		const preflight = await adapter.preflightWorkflow?.(ref, ctx, projectedRuntime ? { projectedRuntime } : undefined);
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

	pi.registerTool({ name: "workflow_control", label: "Control Workflow", description: "Pause, resume, stop, or resolve attention. request_changes may apply a runtime execution correction at the current attention epoch; guarded preflight and permission confirmation happen before mutation.", parameters: Type.Object({ ref: Type.String(), action: StringEnum(["pause", "resume", "stop", "approve", "request_changes"] as const), prompt: Type.Optional(Type.String()), correction: Type.Optional(EXECUTION_CORRECTION), acceptedRisks: Type.Optional(Type.Array(Type.Object({ findingId: Type.String({ minLength: 1 }), rationale: Type.String({ minLength: 1 }) }, { additionalProperties: false }))) }, { additionalProperties: false }), async execute(toolCallId, params, _signal, _update, ctx) {
		const adapter = adapterFor(params.ref);
		if (params.action === "approve" || params.action === "request_changes") {
			if (!adapter.resolveAttention) throw new Error(`Workflow ${params.ref} does not support target attention resolution`);
			if (params.action === "approve" && params.correction) throw new Error("Execution corrections are valid only with action=request_changes");
			if (params.action === "request_changes" && params.acceptedRisks) throw new Error("acceptedRisks are valid only with action=approve");
			const decision = { action: params.action, ...(params.prompt ? { prompt: params.prompt } : {}), ...(params.correction ? { correction: params.correction } : {}), ...(params.acceptedRisks ? { acceptedRisks: params.acceptedRisks } : {}) };
			const before = await adapter.snapshot(params.ref, ctx);
			const ledgerResolution = before.runtime.attention?.code === "ledger_persistence_failed" && !authoritativeAttentionTarget(before.runtime) && Object.keys(before.runtime.ledgerRecoveries ?? {}).length > 0;
			const expectedLedgerRecovery = ledgerResolution ? structuredClone(Object.values(before.runtime.ledgerRecoveries!)[0]!) : undefined;
			const validated = await adapter.resolveAttention(params.ref, decision, ctx, { dryRun: true, ...(expectedLedgerRecovery ? { expectedLedgerRecovery } : {}) });
			if (params.action === "approve" && !ledgerResolution) {
				const criticalFindingIds = [...validated.stages.map((stage) => stage.review), validated.finalReview]
					.flatMap((review) => review.currentFindings.filter((finding) => finding.severity === "critical").map((finding) => finding.id));
				if (!criticalFindingIds.length) throw new Error(`Workflow ${params.ref} approval has no validated Critical review finding`);
				if (!await confirmCriticalRisk(ctx, params.ref, criticalFindingIds)) return result(`Workflow control cancelled. ${params.ref} Critical risk was not accepted; state, permission mode, and execution were not changed.`, { cancelled: true });
			}
			if (!ledgerResolution && !hasWorkflowAttention(validated)) {
				const guard = await guardLaunch(adapter, params.ref, ctx, undefined, validated);
				if (!guard.ok) return "cancelled" in guard ? result(`Workflow control cancelled. ${params.ref} was not changed or resumed.`, { cancelled: true }) : result(guard.detail, { attention: true, preflight: guard.preflight });
			}
			const committed = await adapter.resolveAttention(params.ref, decision, ctx, expectedLedgerRecovery ? { expectedLedgerRecovery } : undefined);
			selectedRef = params.ref;
			const runner = runnerFor(params.ref);
			if (ledgerResolution) {
				const snapshot = await runner.refresh();
				return result(hasWorkflowAttention(committed)
					? `Ledger settlement recorded; remaining attention for ${params.ref} must be resolved before explicit resume.`
					: `Ledger settlement recorded for ${params.ref}; workflow remains paused until explicit resume.`, snapshot);
			}
			if (hasWorkflowAttention(committed)) {
				const snapshot = await runner.refresh();
				const recorded = params.correction ? "Correction" : params.action;
				return result(`${recorded} recorded; remaining attention for ${params.ref} must be resolved before resume.\n${JSON.stringify({ attentionEpoch: committed.attentionEpoch ?? 1, attentionTarget: committed.attentionTarget ?? null, attention: committed.attention && { code: committed.attention.code, summary: committed.attention.summary } })}`, snapshot);
			}
			await runner.command("resume", `control:${toolCallId}`, { invokeDomainControl: true });
			await runner.advance();
			return result(`${params.action} recorded and ${params.ref} resumed.`, runner.snapshot);
		}
		if (params.action === "resume") { await requireResolvedAttention(adapter, params.ref, ctx); const guard = await guardLaunch(adapter, params.ref, ctx); if (!guard.ok) return "cancelled" in guard ? result(`Workflow resume cancelled. ${params.ref} was not resumed.`, { cancelled: true }) : result(guard.detail, { attention: true, preflight: guard.preflight }); }
		selectedRef = params.ref; const runner = runnerFor(params.ref); await runner.command(params.action, `tool:${toolCallId}`, { invokeDomainControl: true }); if (params.action === "resume") await runner.advance(); return result(`${params.action} recorded for ${params.ref}.`, runner.snapshot);
	} });

	pi.events.on(WORKFLOW_CONTROL_EVENT, (value: unknown) => { const event = value as WorkflowControlEvent; if (!sessionCtx || shuttingDown) return; void (async () => { if (event.action === "resume") { const adapter = adapterFor(event.ref); await requireResolvedAttention(adapter, event.ref, sessionCtx!); const guard = await guardLaunch(adapter, event.ref, sessionCtx!); if (!guard.ok) return; } selectedRef = event.ref; await runnerFor(event.ref).command(event.action, event.operationId ?? `event:${Date.now()}`, { invokeDomainControl: false }); })().catch((error) => sendNotice({ workflowRef: event.ref, title: `${event.ref} · control failed`, detail: error instanceof Error ? error.message : String(error), attention: true })); });

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false; sessionCtx = ctx;
		unregisterRunnerRestorer?.(); unregisterRunnerRestorer = registerWorkflowRunnerRestorer(async (controls) => {
			if (!sessionCtx || shuttingDown) return;
			for (const control of controls) {
				if ((control.mode !== "running" && control.mode !== "paused") || runners.has(control.workflowRef) || (control.ownerSessionId && control.ownerSessionId !== sessionCtx.sessionManager.getSessionId())) continue;
				selectedRef = control.workflowRef; await runnerFor(control.workflowRef).command("attach", `demand:${control.workflowRef}`, { restoreMode: control.mode, invokeDomainControl: false });
			}
			renderDashboard();
		});
		unregisterSubagentUi?.(); unregisterSubagentUi = subagentUi.subscribe(() => {
			if (shuttingDown || !sessionCtx?.hasUI) return;
			const entries = dashboardEntries();
			if (!entries.length) return;
			const key = subagentKey(entries);
			if (dashboardSubagentKey === key) return;
			dashboardSubagentKey = key;
			if (dashboardTui) { dashboardTui.requestRender?.(); syncDashboardTimer(); }
			else renderDashboard();
		});
	});
	pi.on("session_shutdown", async (_event, ctx) => { shuttingDown = true; await Promise.all([...runners.values()].map((runner) => runner.dispose())); runners.clear(); selectedRef = undefined; sessionCtx = undefined; unregisterRunnerRestorer?.(); unregisterRunnerRestorer = undefined; unregisterSubagentUi?.(); unregisterSubagentUi = undefined; clearDashboard(ctx); });
}
