import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	WorkflowAdapter,
	WorkflowExecutionControl,
	WorkflowLifecycleEvent,
	WorkflowLifecycleUpdate,
	WorkflowMetrics,
	WorkflowRunResult,
	WorkflowSnapshot,
	WorkflowStartProgress,
	WorkflowStep,
} from "./api.js";

export type WorkflowRunnerMode = "running" | "paused" | "stopped" | "completed";
export type WorkflowRunnerCommand = "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach";

export interface WorkflowRunnerNotice extends WorkflowLifecycleUpdate {
	workflowRef: string;
	fromStatus?: string;
	nextAction?: string;
	attempt?: number;
	iteration?: number;
	correlationId?: string;
}

export interface WorkflowRunnerProjection {
	readonly ref: string;
	readonly mode: WorkflowRunnerMode;
	readonly generation?: number;
	readonly snapshot?: WorkflowSnapshot;
	readonly inFlight: readonly string[];
}

export interface WorkflowRunnerHost {
	onProjection(projection: WorkflowRunnerProjection): void;
	onNotice(notice: WorkflowRunnerNotice): void;
	onLifecycle(event: WorkflowLifecycleEvent): void;
	onComplete(ref: string, prompt: string): void;
}

export interface WorkflowRunnerCommandOptions {
	/** User commands invoke workflow-domain preparation/teardown; internal fences do not. */
	invokeDomainControl?: boolean;
	/** Receives start preparation progress after durable ownership is established. */
	onStartProgress?: (progress: WorkflowStartProgress) => void;
	/** Additional workflow-domain mutation performed on this serialized path after fencing. */
	mutateDomain?: () => Promise<void>;
	/** Durable mode to project after attach. */
	restoreMode?: "running" | "paused";
}

interface InFlightStep {
	stepRef: string;
	revision: number;
	generation?: number;
	expectedExecution?: WorkflowExecutionControl;
	controller: AbortController;
}

/** One independently fenced workflow controller. */
export class WorkflowRunner {
	readonly ref: string;
	readonly adapter: WorkflowAdapter;
	private readonly ctx: ExtensionContext;
	private readonly host: WorkflowRunnerHost;
	private modeValue: WorkflowRunnerMode = "stopped";
	private generationValue: number | undefined;
	private executionControlValue: WorkflowExecutionControl | undefined;
	private snapshotValue: WorkflowSnapshot | undefined;
	private revision = 0;
	private disposed = false;
	private tickRequested = false;
	private tickDrain: Promise<void> | undefined;
	private commandTail: Promise<void> = Promise.resolve();
	private readonly inFlight = new Map<string, InFlightStep>();
	private lifecycle: { controller: AbortController; unsubscribe?: () => void; revision: number } | undefined;

	constructor(ref: string, adapter: WorkflowAdapter, ctx: ExtensionContext, host: WorkflowRunnerHost) {
		this.ref = ref;
		this.adapter = adapter;
		this.ctx = ctx;
		this.host = host;
	}

	get mode(): WorkflowRunnerMode { return this.modeValue; }
	get generation(): number | undefined { return this.generationValue; }
	get snapshot(): WorkflowSnapshot | undefined { return this.snapshotValue; }

	projection(): WorkflowRunnerProjection {
		return {
			ref: this.ref,
			mode: this.modeValue,
			...(this.generationValue !== undefined ? { generation: this.generationValue } : {}),
			...(this.snapshotValue ? { snapshot: this.snapshotValue } : {}),
			inFlight: [...this.inFlight.keys()],
		};
	}

	command(command: WorkflowRunnerCommand, operationId: string, options: WorkflowRunnerCommandOptions = {}): Promise<void> {
		const pending = this.commandTail.then(() => this.applyCommand(command, operationId, options));
		this.commandTail = pending.catch(() => undefined);
		return pending;
	}

	requestTick(): void {
		if (this.disposed || this.modeValue !== "running") return;
		this.tickRequested = true;
		void this.ensureTickDrain();
	}

	/** Request scheduling and wait until the currently queued refresh has launched ready work. */
	async advance(): Promise<void> {
		if (this.disposed || this.modeValue !== "running") return;
		this.tickRequested = true;
		await this.ensureTickDrain();
	}

	async refresh(): Promise<WorkflowSnapshot | undefined> {
		if (this.disposed) return undefined;
		const revision = this.revision;
		await this.adapter.reconcileWorkflow?.(this.ref, this.ctx);
		const snapshot = await this.adapter.snapshot(this.ref, this.ctx);
		if (!this.isRevision(revision)) return undefined;
		this.publishSnapshot(snapshot);
		return this.snapshotValue;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.revision++;
		this.stopLifecycle();
		// Do not erase unsettled obligations on reload detach. Their promises retain
		// this runner until settlement, while adapter-owned process-global supervision
		// lets a replacement stop and await them.
	}

	private async applyCommand(command: WorkflowRunnerCommand, operationId: string, options: WorkflowRunnerCommandOptions): Promise<void> {
		if (this.disposed) throw new Error(`Workflow runner ${this.ref} is disposed`);
		if (!this.adapter.controlExecution) throw new Error(`Workflow adapter ${this.adapter.id} does not provide durable execution control`);

		// Establish durable ownership before invalidating local work or mutating the workflow domain.
		// A rejected fence therefore leaves both the runner projection and canonical workflow untouched.
		const control: WorkflowExecutionControl = await this.adapter.controlExecution(this.ref, command, operationId, this.ctx);
		if (this.disposed) return;

		this.revision++;
		const revision = this.revision;
		if (command === "stop" || command === "detach") {
			this.stopLifecycle();
			if (command === "stop") for (const step of this.inFlight.values()) step.controller.abort();
		}

		this.generationValue = control.generation;
		this.executionControlValue = structuredClone(control);
		const targetMode: WorkflowRunnerMode = command === "attach" ? (options.restoreMode ?? (control.mode === "paused" ? "paused" : "running"))
			: command === "detach" ? (control.mode === "paused" ? "paused" : "running")
				: command === "pause" ? "paused"
				: command === "stop" ? "stopped"
					: command === "complete" ? "completed" : "running";
		// An activation is not locally running until all post-fence domain work succeeds.
		// This also prevents lifecycle callbacks from scheduling against a half-applied command.
		this.modeValue = command === "start" ? "stopped" : command === "resume" ? "paused" : targetMode;

		let domainFailed = false;
		let domainError: unknown;
		try {
			await options.mutateDomain?.();
			if (command === "start" && options.invokeDomainControl !== false) await this.adapter.prepareWorkflow?.(this.ref, this.ctx, options.onStartProgress);
			if (command === "resume" && options.invokeDomainControl !== false) await this.adapter.controlWorkflow(this.ref, "resume", this.ctx);
			if (command === "pause" && options.invokeDomainControl !== false) await this.adapter.controlWorkflow(this.ref, "pause", this.ctx);
			if (command === "stop" && options.invokeDomainControl !== false) await this.adapter.controlWorkflow(this.ref, "stop", this.ctx);
		} catch (error) {
			domainFailed = true;
			domainError = error;
		}

		if (domainFailed && (command === "start" || command === "resume")) {
			const safeCommand = command === "start" ? "stop" : "pause";
			let compensationError: unknown;
			try {
				const compensated = await this.adapter.controlExecution(this.ref, safeCommand, `${operationId}:compensate:${safeCommand}`, this.ctx);
				if (this.isRevision(revision)) {
					this.generationValue = compensated.generation;
					this.executionControlValue = structuredClone(compensated);
				}
			} catch (error) { compensationError = error; }
			if (this.isRevision(revision)) {
				this.modeValue = safeCommand === "stop" ? "stopped" : "paused";
				this.tickRequested = false;
				this.stopLifecycle();
				if (safeCommand === "stop") {
					for (const step of this.inFlight.values()) step.controller.abort();
					this.snapshotValue = undefined;
				}
				this.publish();
			}
			if (compensationError) {
				throw new AggregateError(
					[domainError, compensationError],
					`Workflow ${this.ref} ${command} failed: ${errorDetail(domainError)}; durable ${safeCommand} compensation failed: ${errorDetail(compensationError)}`,
					{ cause: domainError },
				);
			}
			throw domainError;
		}
		if (!this.isRevision(revision)) return;

		this.modeValue = targetMode;
		if (command !== "detach" && (this.modeValue === "running" || this.modeValue === "paused")) this.watchLifecycle(revision);
		if (this.modeValue === "stopped") this.snapshotValue = undefined;
		this.publish();
		if (command !== "detach" && this.modeValue === "running") this.requestTick();
		else if (command !== "detach" && this.modeValue === "paused") await this.refresh().catch(() => undefined);
		if (domainFailed) throw domainError;
	}

	private ensureTickDrain(): Promise<void> {
		if (this.tickDrain) return this.tickDrain;
		const pending = this.drainTicks().finally(() => {
			if (this.tickDrain === pending) this.tickDrain = undefined;
			if (!this.disposed && this.modeValue === "running" && this.tickRequested) void this.ensureTickDrain();
		});
		this.tickDrain = pending;
		return pending;
	}

	private async drainTicks(): Promise<void> {
		while (!this.disposed && this.modeValue === "running" && this.tickRequested) {
			this.tickRequested = false;
			await this.tickOnce();
		}
	}

	private async tickOnce(): Promise<void> {
		const revision = this.revision;
		let snapshot: WorkflowSnapshot;
		try {
			await this.adapter.reconcileWorkflow?.(this.ref, this.ctx);
			snapshot = await this.adapter.snapshot(this.ref, this.ctx);
		} catch (error) {
			if (!this.isLive(revision)) return;
			const detail = error instanceof Error ? error.message : String(error);
			await this.pauseForAttention(`snapshot:${this.ref}:${this.generationValue ?? revision}:failed`);
			this.host.onLifecycle({ type: "error", workflowRef: this.ref, title: this.ref, detail, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
			this.host.onNotice({ workflowRef: this.ref, title: `${this.ref} · attention`, detail, attention: true, cause: "snapshot-failed", nextAction: "Inspect the workflow and resume when ready." });
			return;
		}
		if (!this.isLive(revision)) return;
		this.publishSnapshot(snapshot);

		const hasIndependentReadyWork = snapshot.steps.some((step) => step.status === "ready" && !this.inFlight.has(step.ref));
		const attentionSteps = snapshot.steps.filter((step) => step.status === "attention");
		const actionable = attentionSteps.filter((step) => step.detail !== "result pending reconciliation");
		if (snapshot.status === "attention" && actionable.length > 0 && this.inFlight.size === 0 && !hasIndependentReadyWork) {
			const detail = actionable.map((step) => `${step.ref}: ${step.detail ?? "needs intervention"}`).join("\n");
			await this.pauseForAttention(`attention:${actionable.map((step) => step.ref).join(",")}:${this.generationValue ?? revision}`);
			const checkpoint = actionable.find((step) => step.kind === "evaluation");
			const guidance = `${detail || "Workflow needs intervention."}${checkpoint ? `\nUse workflow_checkpoint on ${checkpoint.ref}: Approve (optionally naming accepted risks) or Request changes. Do not manipulate Git or task state manually.` : ""}`;
			this.host.onLifecycle({ type: "error", workflowRef: this.ref, ...(attentionSteps[0] ? { stepRef: attentionSteps[0].ref, kind: attentionSteps[0].kind } : {}), title: snapshot.title, detail: guidance, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
			this.host.onNotice({ workflowRef: this.ref, title: `${snapshot.title} · attention`, detail: guidance, attention: true, cause: "checkpoint-required", nextAction: checkpoint ? "Approve or request changes at the review checkpoint." : "Resolve the attention state and resume." });
			return;
		}

		if (snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "done")) {
			await this.complete(snapshot, revision);
			return;
		}

		for (const step of this.runnable(snapshot)) {
			if (!this.isLive(revision)) break;
			if (this.generationValue !== undefined && this.adapter.assertExecutionCurrent) {
				try { await this.adapter.assertExecutionCurrent(this.ref, this.generationValue, this.ctx); }
				catch { await this.pauseForAttention(`launch:${step.ref}:${this.generationValue}:stale`); break; }
			}
			if (!this.isLive(revision)) break;
			this.startStep(step, revision);
		}
	}

	private startStep(step: WorkflowStep, revision: number): void {
		if (this.inFlight.has(step.ref)) return;
		const controller = new AbortController();
		const expectedExecution = this.executionControlValue ? structuredClone(this.executionControlValue) : undefined;
		const active: InFlightStep = { stepRef: step.ref, revision, ...(this.generationValue !== undefined ? { generation: this.generationValue } : {}), ...(expectedExecution ? { expectedExecution } : {}), controller };
		this.inFlight.set(step.ref, active);
		this.publish();
		const startTitle = step.checkpoint ? `Starting ${step.title.split(" · ")[0]}` : step.kind === "merge" ? `Assembling integration candidate · ${step.title}` : `Starting ${step.title}`;
		this.host.onNotice({ workflowRef: this.ref, title: startTitle, attention: false, kind: step.kind, toStatus: "running" });
		void this.settleStep(step, active, this.adapter.runStep(step.ref, this.ctx, controller.signal, expectedExecution));
	}

	private async settleStep(step: WorkflowStep, active: InFlightStep, promise: Promise<WorkflowRunResult>): Promise<void> {
		try {
			const settled = await promise;
			if (!await this.settlementIsCurrent(active)) return;
			const attention = Boolean(settled.attention || settled.state === "blocked" || settled.state === "failed");
			const terminalSnapshot = await this.adapter.snapshot(this.ref, this.ctx).catch(() => undefined);
			if (!await this.settlementIsCurrent(active)) return;
			const terminalStep = terminalSnapshot?.steps.find((candidate) => candidate.ref === step.ref);
			this.host.onNotice({ workflowRef: this.ref, title: `${terminalStep?.title ?? step.title} · ${settled.state}`, detail: settled.summary, attention, kind: step.kind, ...(terminalStep?.status ? { toStatus: terminalStep.status } : {}), cause: attention ? "step-settled-with-attention" : "step-settled" });
			if (terminalSnapshot) this.publishSnapshot(terminalSnapshot);
			if (attention) {
				await this.pauseForAttention(`settlement:${step.ref}:${active.generation ?? active.revision}:attention`);
				this.host.onLifecycle({ type: "error", workflowRef: this.ref, stepRef: step.ref, kind: step.kind, title: step.title, detail: settled.summary, cause: "step-attention", nextAction: "Resolve the step and resume or decide at its checkpoint." });
			}
		} catch (error) {
			if (!await this.settlementIsCurrent(active)) return;
			const detail = error instanceof Error ? error.message : String(error);
			await this.pauseForAttention(`settlement:${step.ref}:${active.generation ?? active.revision}:exception`);
			this.host.onLifecycle({ type: "error", workflowRef: this.ref, stepRef: step.ref, kind: step.kind, title: step.title, detail, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
			this.host.onNotice({ workflowRef: this.ref, title: `${step.title} · failed`, detail, attention: true, kind: step.kind, cause: "step-exception", nextAction: "Inspect the failure and resume or decide at the checkpoint." });
		} finally {
			if (this.inFlight.get(step.ref) === active) this.inFlight.delete(step.ref);
			this.publish();
			this.requestTick();
		}
	}

	private async settlementIsCurrent(active: InFlightStep): Promise<boolean> {
		if (!this.isLive(active.revision) || this.inFlight.get(active.stepRef) !== active) return false;
		if (active.generation === undefined || !this.adapter.assertExecutionCurrent) return true;
		try {
			await this.adapter.assertExecutionCurrent(this.ref, active.generation, this.ctx);
			return this.isLive(active.revision) && this.inFlight.get(active.stepRef) === active;
		} catch { return false; }
	}

	private async pauseForAttention(operationId: string): Promise<void> {
		if (this.modeValue !== "running") return;
		await this.command("pause", operationId, { invokeDomainControl: false });
	}

	private async complete(snapshot: WorkflowSnapshot, revision: number): Promise<void> {
		await this.command("complete", `complete:${this.ref}:${this.generationValue ?? revision}`, { invokeDomainControl: false });
		if (this.modeValue !== "completed") return;
		const completedAt = Date.now();
		const refreshed = await this.adapter.snapshot(this.ref, this.ctx).catch(() => snapshot);
		const terminal = refreshed.metrics ? { ...refreshed, metrics: freezeMetricProjection(refreshed.metrics, completedAt) } : refreshed;
		this.publishSnapshot(terminal);
		this.host.onNotice({ workflowRef: this.ref, title: `${snapshot.title} · complete`, detail: "Finished all workflow steps.", attention: false, cause: "workflow-terminal" });
		const prompt = await this.adapter.completionPrompt?.(this.ref, this.ctx) ?? `Workflow ${this.ref} is complete. Brief the user from its canonical outcome.`;
		this.host.onComplete(this.ref, prompt);
	}

	private runnable(snapshot: WorkflowSnapshot): WorkflowStep[] {
		const ready = snapshot.steps.filter((step) => step.status === "ready" && !this.inFlight.has(step.ref));
		const running = snapshot.steps.filter((step) => step.status === "running" || this.inFlight.has(step.ref));
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
	}

	private publishSnapshot(snapshot: WorkflowSnapshot): void {
		this.snapshotValue = {
			...snapshot,
			steps: snapshot.steps.map((step) => this.inFlight.has(step.ref) && step.status !== "done" ? { ...step, status: "running" } : step),
		};
		this.publish();
	}

	private watchLifecycle(revision: number): void {
		if (!this.adapter.subscribeLifecycle) return;
		this.stopLifecycle();
		const controller = new AbortController();
		const subscription = { controller, revision } as { controller: AbortController; unsubscribe?: () => void; revision: number };
		this.lifecycle = subscription;
		const listener = (update?: WorkflowLifecycleUpdate) => {
			if (!this.isRevision(revision) || this.lifecycle !== subscription) return;
			if (update?.lifecycle) this.host.onLifecycle(update.lifecycle);
			if (update) this.host.onNotice(update);
			if (this.modeValue === "running") this.requestTick();
			else void this.refresh().catch(() => undefined);
		};
		void Promise.resolve(this.adapter.subscribeLifecycle(this.ref, this.ctx, listener, controller.signal)).then((unsubscribe) => {
			if (controller.signal.aborted || !this.isRevision(revision) || this.lifecycle !== subscription) {
				if (typeof unsubscribe === "function") unsubscribe();
				return;
			}
			if (typeof unsubscribe === "function") subscription.unsubscribe = unsubscribe;
			listener();
		}).catch(() => undefined);
	}

	private stopLifecycle(): void {
		const subscription = this.lifecycle;
		if (!subscription) return;
		subscription.controller.abort();
		subscription.unsubscribe?.();
		this.lifecycle = undefined;
	}

	private isRevision(revision: number): boolean { return !this.disposed && this.revision === revision; }
	private isLive(revision: number): boolean { return this.isRevision(revision) && this.modeValue === "running"; }
	private publish(): void { if (!this.disposed) this.host.onProjection(this.projection()); }
}

function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function projectedMetric(metrics: WorkflowMetrics, base: number, activeIntervals: number, now: number): number {
	if (!metrics.live || activeIntervals <= 0) return base;
	return base + Math.max(0, now - metrics.live.sampledAtMs) * activeIntervals;
}

function phaseMetric(metrics: WorkflowMetrics, category: NonNullable<WorkflowMetrics["live"]>["activeCategory"], base: number | undefined, now: number): number {
	const hasPhaseProjection = [metrics.implementationMs, metrics.integrationMs, metrics.reviewMs, metrics.e2eMs, metrics.orchestrationMs].some((value) => value !== undefined);
	const compatibleBase = hasPhaseProjection ? (base ?? 0) : category === "orchestration" ? metrics.runningMs : 0;
	const activeCategory = metrics.live?.activeCategory ?? (!hasPhaseProjection && metrics.live?.running ? "orchestration" : undefined);
	return projectedMetric(metrics, compatibleBase, metrics.live?.running && activeCategory === category ? 1 : 0, now);
}

export function freezeMetricProjection(metrics: WorkflowMetrics, now = Date.now()): WorkflowMetrics {
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
}
