import type { ProcessAttempt, SessionAgentRecord } from "../workflow-runtime/agent-registry.js";
import type { WorkflowControlFence } from "../workflow-runtime/control-store.js";
import type { LaunchCoordinator } from "../workflow-runtime/launch-coordinator.js";
import { HarnessError } from "./errors.js";
import type { HarnessRunStore, RunRecord } from "./run-store.js";

interface ManagedEvaluationControl {
	workItemId: string;
	coordinator: LaunchCoordinator;
	controller: AbortController;
	upstreamSignal?: AbortSignal;
	removeUpstream?: () => void;
	runs?: HarnessRunStore;
	runId?: string;
	expectedWorkflowFence?: WorkflowControlFence;
	agentId?: string;
	attemptId?: string;
	attemptGeneration?: number;
	terminated: boolean;
	stopPromise?: Promise<void>;
	settled: Promise<void>;
	confirmSettled: () => void;
}

export interface ManagedEvaluationHandle {
	readonly signal: AbortSignal;
	readonly terminated: boolean;
	readonly runId: string | undefined;
	attachRun(runs: HarnessRunStore, runId: string, expectedWorkflowFence?: WorkflowControlFence): Promise<void>;
	bindAttempt(agent: SessionAgentRecord, attempt: ProcessAttempt): Promise<void>;
	markRunning(): Promise<void>;
	releaseAttempt(): Promise<void>;
	revokeAttempt(update?: { state?: RunRecord["state"]; error?: string; exitCode?: number }, eventType?: string): Promise<void>;
	assertActive(): void;
	finish(): void;
}

/**
 * In-memory owner for evaluation attempts in the current activation.
 *
 * Registration precedes evaluator preflight and durable run allocation, so stop
 * can fence startup races that do not yet have a run or service handle. Durable
 * attempt credentials remain the cross-process authority after allocation.
 */
export class EvaluationSupervisor {
	readonly #managed = new Set<ManagedEvaluationControl>();
	readonly #byRun = new Map<string, ManagedEvaluationControl>();

	begin(workItemId: string, coordinator: LaunchCoordinator, upstreamSignal?: AbortSignal): ManagedEvaluationHandle {
		let confirmSettled!: () => void;
		const settled = new Promise<void>((resolve) => { confirmSettled = resolve; });
		const control: ManagedEvaluationControl = {
			workItemId,
			coordinator,
			controller: new AbortController(),
			...(upstreamSignal ? { upstreamSignal } : {}),
			terminated: false,
			settled,
			confirmSettled,
		};
		this.#managed.add(control);
		const stopFromUpstream = () => { this.terminate(control); void this.stopControl(control).catch(() => undefined); };
		if (upstreamSignal) {
			if (upstreamSignal.aborted) stopFromUpstream();
			else {
				upstreamSignal.addEventListener("abort", stopFromUpstream, { once: true });
				control.removeUpstream = () => upstreamSignal.removeEventListener("abort", stopFromUpstream);
			}
		}
		const supervisor = this;
		let finished = false;
		return {
			get signal() { return control.controller.signal; },
			get terminated() { return control.terminated; },
			get runId() { return control.runId; },
			async attachRun(runs, runId, expectedWorkflowFence) {
				if (control.runId && control.runId !== runId) throw new HarnessError("CAPABILITY_DENIED", "Evaluation supervisor cannot change durable run identity");
				control.runs = runs;
				control.runId = runId;
				if (expectedWorkflowFence) control.expectedWorkflowFence = expectedWorkflowFence;
				else delete control.expectedWorkflowFence;
				supervisor.#byRun.set(runId, control);
				if (control.terminated) await runs.update(runId, { state: "cancelled", credentialRevokedAt: new Date().toISOString(), error: "Evaluation cancelled by workflow stop" }, "run.stop_requested");
			},
			async bindAttempt(agent, attempt) {
				if (!control.runs || !control.runId) throw new HarnessError("CAPABILITY_DENIED", "Evaluation attempt was allocated before its durable run scope");
				control.agentId = agent.id;
				if (control.attemptId && control.attemptId !== attempt.id) {
					if (!control.attemptGeneration) throw new HarnessError("CAPABILITY_DENIED", "Prior evaluation attempt is missing its generation fence");
					await control.runs.releaseAgentAttempt(control.runId, control.attemptId, control.attemptGeneration, control.expectedWorkflowFence);
				}
				control.attemptId = attempt.id;
				control.attemptGeneration = attempt.sequence;
				await control.runs.bindAgentAttempt(control.runId, attempt.id, attempt.sequence, control.expectedWorkflowFence);
				// stop may have arrived before allocation or while the durable bind waited.
				if (control.terminated) {
					await control.runs.revokeAgentAttempt(control.runId, attempt.id, { state: "cancelled", error: "Evaluation cancelled by workflow stop" }, "run.stop_requested");
				}
			},
			async markRunning() {
				if (!control.runs || !control.runId || !control.attemptId || !control.attemptGeneration || control.terminated) throw new HarnessError("CAPABILITY_DENIED", "Evaluation was fenced before process startup completed");
				const marked = await control.runs.updateForAgentAttempt(control.runId, control.attemptId, control.attemptGeneration, { state: "running" }, "run.process_started", control.expectedWorkflowFence);
				if (!marked.updated) throw new HarnessError("CAPABILITY_DENIED", "Evaluation was fenced before process startup completed");
			},
			async releaseAttempt() {
				if (!control.runs || !control.runId || !control.attemptId || !control.attemptGeneration) return;
				await control.runs.releaseAgentAttempt(control.runId, control.attemptId, control.attemptGeneration, control.expectedWorkflowFence, { allowGenerationAdvance: true });
				delete control.attemptId;
				delete control.attemptGeneration;
			},
			async revokeAttempt(update = {}, eventType = "run.agent_attempt_settled") {
				if (!control.runs || !control.runId || !control.attemptId) return;
				await control.runs.revokeAgentAttempt(control.runId, control.attemptId, update, eventType);
			},
			assertActive() {
				if (control.terminated || control.controller.signal.aborted) throw new HarnessError("CAPABILITY_DENIED", "Evaluation settlement belongs to a stopped workflow attempt");
			},
			finish() {
				if (finished) return;
				finished = true;
				control.removeUpstream?.();
				supervisor.#managed.delete(control);
				if (control.runId && supervisor.#byRun.get(control.runId) === control) supervisor.#byRun.delete(control.runId);
				control.confirmSettled();
			},
		};
	}

	/** Stop every evaluator (including pre-allocation launches) for one workflow. */
	async stopWorkItem(workItemId: string): Promise<number> {
		const controls = [...this.#managed].filter((control) => control.workItemId === workItemId);
		for (const control of controls) this.terminate(control);
		await Promise.all(controls.map((control) => this.stopControl(control)));
		return controls.length;
	}

	async stopAll(): Promise<number> {
		const controls = [...this.#managed];
		for (const control of controls) this.terminate(control);
		await Promise.all(controls.map((control) => this.stopControl(control)));
		return controls.length;
	}

	activeRunIds(): string[] {
		return [...this.#byRun.keys()];
	}

	private terminate(control: ManagedEvaluationControl): void {
		if (control.terminated) return;
		control.terminated = true;
		control.controller.abort(new DOMException("Evaluation cancelled by workflow stop", "AbortError"));
	}

	private stopControl(control: ManagedEvaluationControl): Promise<void> {
		if (control.stopPromise) return control.stopPromise;
		this.terminate(control);
		control.stopPromise = (async () => {
			if (control.runs && control.runId && control.attemptId) {
				await control.runs.revokeAgentAttempt(control.runId, control.attemptId, { state: "cancelled", error: "Evaluation cancelled by workflow stop" }, "run.stop_requested");
			} else if (control.runs && control.runId) {
				await control.runs.update(control.runId, { state: "cancelled", credentialRevokedAt: new Date().toISOString(), error: "Evaluation cancelled by workflow stop" }, "run.stop_requested");
			}
			if (control.agentId) await control.coordinator.stop(control.agentId).catch(() => false);
			await control.settled;
		})();
		return control.stopPromise;
	}
}
