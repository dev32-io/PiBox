import { SessionAgentRegistry, TERMINAL_AGENT_STATES } from "../workflow-runtime/agent-registry.js";
import { HarnessError } from "./errors.js";
import { validateManagedEvaluationReport } from "./evaluation-integrity.js";
import { HarnessRunStore, type EvaluationHandoff } from "./run-store.js";
import type { EvaluationManifest } from "./types.js";
import { WorkItemStore } from "./work-items.js";
import { WorkflowControlStore } from "../workflow-runtime/control-store.js";

export interface ManagedEvaluationSettlementInput {
	workItems: WorkItemStore;
	runs: HarnessRunStore;
	workItemId: string;
	evaluationId: string;
	runId: string;
	handoff: EvaluationHandoff;
	reviewerAgentId: string;
	reviewedCommit: string;
	exitCode: number;
	completionEvent: "run.completed" | "run.reconciled_completed";
	/** Live-attempt stop fence. Recovery settlement intentionally omits it. */
	assertActive?: () => void | Promise<void>;
}

export interface ManagedEvaluationSettlement {
	evaluation: EvaluationManifest;
	recorded: boolean;
	runSettled: boolean;
}

export async function reusableReviewerAgentId(registry: SessionAgentRegistry, reviewerAgentId: string | undefined): Promise<string | undefined> {
	if (!reviewerAgentId) return undefined;
	const reviewer = await registry.get(reviewerAgentId).catch(() => undefined);
	return reviewer && !TERMINAL_AGENT_STATES.has(reviewer.state) ? reviewerAgentId : undefined;
}

/** Failed/blocked reviewers remain persistent; successful reviewers settle terminally. */
export async function finalizeReviewerAfterSettlement(registry: SessionAgentRegistry, reviewerAgentId: string, verdict: EvaluationHandoff["verdict"]): Promise<"reusable" | "completed" | "pending"> {
	if (verdict === "fail" || verdict === "blocked") return "reusable";
	let reviewer = await registry.get(reviewerAgentId);
	if (reviewer.state === "completed") return "completed";
	if (reviewer.state !== "reported") return "pending";
	try {
		await registry.transition(reviewerAgentId, "completed", { summary: `Evaluation completed: ${verdict}` });
		return "completed";
	} catch (error) {
		// A concurrent live/recovery settler may have completed the same reviewer.
		reviewer = await registry.get(reviewerAgentId);
		if (reviewer.state === "completed") return "completed";
		throw error;
	}
}

/**
 * Settle one evaluator handoff under the canonical mutation lock.
 *
 * The live evaluator path and recovery reconciliation intentionally share this
 * operation. Whichever path wins records the evaluation attempt and completes
 * the run; every later replay observes that durable result without incrementing
 * the attempt or exposing a transient review-loop state.
 */
export async function settleManagedEvaluation(input: ManagedEvaluationSettlementInput): Promise<ManagedEvaluationSettlement> {
	if (input.handoff.runId !== input.runId || input.handoff.evaluationId !== input.evaluationId) {
		throw new HarnessError("INVALID_HANDOFF", `Evaluation handoff does not match run ${input.runId}`);
	}
	validateManagedEvaluationReport(input.handoff.report, input.handoff.verdict);
	try {
		return await input.workItems.coordinator.run(`managed-evaluation-settlement:${input.runId}`, async () => {
			await input.assertActive?.();
			const run = await input.runs.read(input.runId);
			if (run.workItemId !== input.workItemId || run.evaluationId !== input.evaluationId) {
				throw new HarnessError("INVALID_HANDOFF", `Evaluation run ${input.runId} has a mismatched canonical scope`);
			}
			if (["cancelled", "interrupted"].includes(run.state)) throw new HarnessError("CAPABILITY_DENIED", `Evaluation run ${input.runId} is ${run.state}`);
			if (run.workflowOwnerActivationId || run.workflowOwnerProcessInstanceId) {
				const control = await new WorkflowControlStore(input.workItems.privateRoot).get(`work-item:${input.workItemId}`);
				if (!control || control.mode === "stopped" || control.mode === "completed"
					|| (run.workflowExecutionFence !== undefined && control.executionFence !== run.workflowExecutionFence)
					|| control.ownerActivationId !== run.workflowOwnerActivationId
					|| control.ownerProcessInstanceId !== run.workflowOwnerProcessInstanceId) {
					throw new HarnessError("CAPABILITY_DENIED", `Evaluation run ${input.runId} belongs to a stopped or replaced workflow activation`);
				}
			}
			if (run.workflowExecutionFence !== undefined) await input.runs.assertCanonicalMutationAllowed(input.runId);
			let evaluation = await input.workItems.readEvaluation(input.workItemId, input.evaluationId);
			if (evaluation.attempt > run.attempt) {
				throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} advanced past stale run attempt ${run.attempt}`);
			}
			if (evaluation.attempt < run.attempt - 1) {
				throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} cannot skip to run attempt ${run.attempt} from ${evaluation.attempt}`);
			}

			let recorded = false;
			if (evaluation.attempt < run.attempt) {
				await input.assertActive?.();
				evaluation = await input.workItems.recordEvaluation({
					workItemId: input.workItemId,
					evaluationId: input.evaluationId,
					verdict: input.handoff.verdict,
					report: input.handoff.report,
					...(input.handoff.caseResults ? { caseResults: input.handoff.caseResults } : {}),
					evidence: input.handoff.evidence,
					findings: input.handoff.findings,
					...(input.handoff.residualRisks ? { residualRisks: input.handoff.residualRisks } : {}),
					expectedAttempt: run.attempt,
					reviewContext: { reviewerAgentId: input.reviewerAgentId, reviewedCommit: input.reviewedCommit },
				});
				recorded = true;
			} else {
				if (evaluation.result?.verdict !== input.handoff.verdict) {
					throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} attempt ${run.attempt} conflicts with run verdict ${input.handoff.verdict}`);
				}
				const existingReviewer = evaluation.loop?.reviewerAgentId;
				const existingCommit = evaluation.loop?.reviewedCommit;
				if (existingReviewer && existingReviewer !== input.reviewerAgentId) {
					throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} attempt ${run.attempt} belongs to another reviewer`);
				}
				if (existingCommit && existingCommit !== input.reviewedCommit) {
					throw new HarnessError("INVALID_HANDOFF", `Evaluation ${input.evaluationId} attempt ${run.attempt} reviewed another commit`);
				}
				// Backfill context for runs recorded by an older recovery path without
				// disturbing their already-settled awaiting_manager/passed state.
				if (!existingReviewer || !existingCommit) {
					evaluation = await input.workItems.updateEvaluationLoop(input.workItemId, input.evaluationId, {
						reviewerAgentId: input.reviewerAgentId,
						reviewedCommit: input.reviewedCommit,
					});
				}
			}

			// Recording the canonical result is the settlement linearization point. For
			// idempotent replays with no new result, re-check immediately before the run
			// projection instead.
			if (!recorded) await input.assertActive?.();
			const freshRun = await input.runs.read(input.runId);
			const runSettled = freshRun.state !== "completed";
			if (runSettled) {
				await input.runs.update(input.runId, { state: "completed", exitCode: input.exitCode }, input.completionEvent);
			}
			return { evaluation, recorded, runSettled };
		});
	} catch (error) {
		// A durable workflow stop/replacement owns cancellation or interruption even
		// when recovery settlement runs in another extension activation and therefore
		// has no in-memory assertActive callback.
		const failedRun = await input.runs.read(input.runId).catch(() => undefined);
		let fencedState: "cancelled" | "interrupted" | undefined = failedRun?.state === "cancelled" || failedRun?.state === "interrupted" ? failedRun.state : undefined;
		let schedulerPaused = false;
		if (!fencedState && failedRun && (failedRun.workflowOwnerActivationId || failedRun.workflowOwnerProcessInstanceId)) {
			const control = await new WorkflowControlStore(input.workItems.privateRoot).get(`work-item:${input.workItemId}`).catch(() => undefined);
			if (control && (control.ownerActivationId !== failedRun.workflowOwnerActivationId || control.ownerProcessInstanceId !== failedRun.workflowOwnerProcessInstanceId)) fencedState = "interrupted";
			else if (!control || control.mode === "stopped" || control.mode === "completed" || (failedRun.workflowExecutionFence !== undefined && control.executionFence !== failedRun.workflowExecutionFence)) fencedState = "cancelled";
			else schedulerPaused = control.mode === "paused";
		}
		if (fencedState) {
			if (failedRun && !["completed", "cancelled", "interrupted"].includes(failedRun.state)) {
				await input.runs.update(input.runId, {
					state: fencedState,
					currentAgentAttemptId: undefined,
					currentAgentGeneration: undefined,
					credentialRevokedAt: new Date().toISOString(),
					error: fencedState === "cancelled" ? "Evaluation cancelled by workflow stop" : "Evaluation owner activation was replaced",
				}, `run.${fencedState}`).catch(() => undefined);
			}
			throw error;
		}
		if (schedulerPaused) throw error;
		let stopped = false;
		try { await input.assertActive?.(); } catch { stopped = true; }
		if (stopped) throw error;
		// The evaluator process is already settled and its handoff remains durable for
		// reconciliation. Do not project this run as actively executing while canonical
		// settlement is blocked or rejected.
		if (failedRun && !["completed", "cancelled", "interrupted"].includes(failedRun.state)) {
			await input.runs.update(input.runId, {
				state: "failed",
				exitCode: input.exitCode,
				error: `Evaluation settlement failed: ${error instanceof Error ? error.message : String(error)}`,
			}, "run.settlement_failed").catch(() => undefined);
		}
		throw error;
	}
}
