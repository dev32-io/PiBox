import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowAdapter, WorkflowLifecycleEvent, WorkflowLifecycleUpdate, WorkflowSnapshot, WorkflowStartProgress } from "./api.js";

export type WorkflowRunnerMode = "running" | "paused" | "stopped" | "completed";
export type WorkflowRunnerCommand = "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach";
export interface WorkflowRunnerNotice extends WorkflowLifecycleUpdate { workflowRef: string; nextAction?: string; correlationId?: string }
export interface WorkflowRunnerProjection { readonly ref: string; readonly mode: WorkflowRunnerMode; readonly snapshot?: WorkflowSnapshot }
export interface WorkflowRunnerHost {
	onProjection(projection: WorkflowRunnerProjection): void;
	onNotice(notice: WorkflowRunnerNotice): void;
	onLifecycle(event: WorkflowLifecycleEvent): void;
	onComplete(ref: string, prompt: string): void;
}
export interface WorkflowRunnerCommandOptions {
	invokeDomainControl?: boolean;
	onStartProgress?: (progress: WorkflowStartProgress) => void;
	restoreMode?: "running" | "paused";
}

/** Small local controller; the adapter and story-local state machine own all scheduling authority. */
export class WorkflowRunner {
	private modeValue: WorkflowRunnerMode = "stopped";
	private snapshotValue: WorkflowSnapshot | undefined;
	private disposed = false;
	private commandTail: Promise<void> = Promise.resolve();
	private tickDrain: Promise<void> | undefined;
	private tickRequested = false;
	private revision = 0;
	private lifecycle: { controller: AbortController; unsubscribe?: () => void; revision: number } | undefined;

	constructor(readonly ref: string, readonly adapter: WorkflowAdapter, private readonly ctx: ExtensionContext, private readonly host: WorkflowRunnerHost) {}
	get mode(): WorkflowRunnerMode { return this.modeValue; }
	get snapshot(): WorkflowSnapshot | undefined { return this.snapshotValue; }
	projection(): WorkflowRunnerProjection { return { ref: this.ref, mode: this.modeValue, ...(this.snapshotValue ? { snapshot: this.snapshotValue } : {}) }; }

	command(command: WorkflowRunnerCommand, operationId: string, options: WorkflowRunnerCommandOptions = {}): Promise<void> {
		const pending = this.commandTail.then(() => this.applyCommand(command, operationId, options));
		this.commandTail = pending.catch(() => undefined);
		return pending;
	}

	requestTick(): void { if (!this.disposed && this.modeValue === "running") { this.tickRequested = true; void this.ensureTickDrain(); } }
	async advance(): Promise<void> { if (!this.disposed && this.modeValue === "running") { this.tickRequested = true; await this.ensureTickDrain(); } }
	async refresh(): Promise<WorkflowSnapshot | undefined> {
		if (this.disposed) return undefined;
		const revision = this.revision;
		await this.adapter.reconcileWorkflow?.(this.ref, this.ctx);
		const snapshot = await this.adapter.snapshot(this.ref, this.ctx);
		if (this.disposed || revision !== this.revision) return undefined;
		this.snapshotValue = snapshot; this.publish(); return snapshot;
	}
	async dispose(): Promise<void> { if (!this.disposed) { this.disposed = true; this.revision++; this.stopLifecycle(); } }

	private async applyCommand(command: WorkflowRunnerCommand, operationId: string, options: WorkflowRunnerCommandOptions): Promise<void> {
		if (this.disposed) throw new Error(`Workflow runner ${this.ref} is disposed`);
		const control = await this.adapter.controlExecution(this.ref, command, operationId, this.ctx);
		this.revision++;
		const revision = this.revision;
		if (command === "stop" || command === "detach") this.stopLifecycle();
		if (command === "start" && options.invokeDomainControl !== false) await this.adapter.prepareWorkflow?.(this.ref, this.ctx, options.onStartProgress);
		if (["pause", "resume", "stop"].includes(command) && options.invokeDomainControl !== false) await this.adapter.controlWorkflow(this.ref, command as "pause" | "resume" | "stop", this.ctx);
		this.modeValue = command === "attach" ? options.restoreMode ?? (control.mode === "paused" ? "paused" : "running")
			: command === "detach" ? (control.mode === "paused" ? "paused" : "running")
				: command === "pause" ? "paused" : command === "stop" ? "stopped" : command === "complete" ? "completed" : "running";
		if (command !== "detach" && (this.modeValue === "running" || this.modeValue === "paused")) this.watchLifecycle(revision);
		if (this.modeValue === "stopped") this.snapshotValue = undefined;
		this.publish();
		if (command !== "detach" && this.modeValue === "running") this.requestTick();
		else if (command !== "detach" && this.modeValue === "paused") await this.refresh().catch(() => undefined);
	}

	private ensureTickDrain(): Promise<void> {
		if (this.tickDrain) return this.tickDrain;
		const pending = this.drainTicks().finally(() => { if (this.tickDrain === pending) this.tickDrain = undefined; if (!this.disposed && this.modeValue === "running" && this.tickRequested) void this.ensureTickDrain(); });
		this.tickDrain = pending; return pending;
	}
	private async drainTicks(): Promise<void> { while (!this.disposed && this.modeValue === "running" && this.tickRequested) { this.tickRequested = false; await this.tickOnce(); } }
	private async tickOnce(): Promise<void> {
		const revision = this.revision;
		try {
			await this.adapter.reconcileWorkflow?.(this.ref, this.ctx);
			await this.adapter.advanceWorkflow(this.ref, this.ctx);
			const snapshot = await this.adapter.snapshot(this.ref, this.ctx);
			if (this.disposed || revision !== this.revision || this.modeValue !== "running") return;
			this.snapshotValue = snapshot; this.publish();
			if (snapshot.runtime.status === "attention") {
				const detail = snapshot.runtime.attention?.summary ?? "Workflow needs attention.";
				await this.command("pause", `attention:${this.ref}:${snapshot.runtime.attention?.code ?? "unknown"}`, { invokeDomainControl: false });
				this.host.onLifecycle({ type: "error", workflowRef: this.ref, title: snapshot.title, detail, cause: snapshot.runtime.attention?.code ?? "attention", nextAction: "Resolve the recorded attention state and explicitly resume." });
				this.host.onNotice({ workflowRef: this.ref, title: `${snapshot.title} · attention`, detail, attention: true, cause: snapshot.runtime.attention?.code ?? "attention", nextAction: "Resolve the recorded attention state and explicitly resume." });
			} else if (snapshot.runtime.status === "completed") await this.complete(snapshot, revision);
		} catch (error) {
			if (this.disposed || revision !== this.revision || this.modeValue !== "running") return;
			const detail = error instanceof Error ? error.message : String(error);
			await this.command("pause", `failure:${this.ref}:${revision}`, { invokeDomainControl: false });
			this.host.onLifecycle({ type: "error", workflowRef: this.ref, title: this.ref, detail, cause: "workflow-advance-failed", nextAction: "Inspect the workflow and explicitly resume when corrected." });
			this.host.onNotice({ workflowRef: this.ref, title: `${this.ref} · attention`, detail, attention: true, cause: "workflow-advance-failed" });
		}
	}
	private async complete(snapshot: WorkflowSnapshot, revision: number): Promise<void> {
		await this.command("complete", `complete:${this.ref}:${revision}`, { invokeDomainControl: false });
		if (this.modeValue !== "completed") return;
		this.snapshotValue = await this.adapter.snapshot(this.ref, this.ctx).catch(() => snapshot); this.publish();
		this.host.onNotice({ workflowRef: this.ref, title: `${snapshot.title} · complete`, detail: "Finished every stage, whole-branch review, and E2E gate.", attention: false, cause: "workflow-terminal" });
		this.host.onComplete(this.ref, await this.adapter.completionPrompt?.(this.ref, this.ctx) ?? `Workflow ${this.ref} is complete. Brief the user from its canonical outcome.`);
	}
	private watchLifecycle(revision: number): void {
		if (!this.adapter.subscribeLifecycle) return;
		this.stopLifecycle();
		const controller = new AbortController(); const subscription = { controller, revision } as { controller: AbortController; unsubscribe?: () => void; revision: number }; this.lifecycle = subscription;
		const listener = (update?: WorkflowLifecycleUpdate) => { if (this.disposed || this.revision !== revision || this.lifecycle !== subscription) return; if (update?.lifecycle) this.host.onLifecycle(update.lifecycle); if (update) this.host.onNotice(update); if (this.modeValue === "running") this.requestTick(); else void this.refresh().catch(() => undefined); };
		void Promise.resolve(this.adapter.subscribeLifecycle(this.ref, this.ctx, listener, controller.signal)).then((unsubscribe) => { if (controller.signal.aborted || this.lifecycle !== subscription) { if (typeof unsubscribe === "function") unsubscribe(); return; } if (typeof unsubscribe === "function") subscription.unsubscribe = unsubscribe; listener(); }).catch(() => undefined);
	}
	private stopLifecycle(): void { const current = this.lifecycle; if (!current) return; current.controller.abort(); current.unsubscribe?.(); this.lifecycle = undefined; }
	private publish(): void { if (!this.disposed) this.host.onProjection(this.projection()); }
}
