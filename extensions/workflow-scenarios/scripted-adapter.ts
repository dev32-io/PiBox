import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowAdapter, WorkflowRunResult, WorkflowSnapshot, WorkflowStepStatus } from "../workflow-runtime/api.js";
import type { ScenarioTraceEvent, ScriptedStepDefinition, ScriptedStepOutcome, WorkflowScenarioDefinition } from "./types.js";

type TraceInput = ScenarioTraceEvent extends infer Event ? Event extends { sequence: number } ? Omit<Event, "sequence"> : never : never;

interface StepState {
	definition: ScriptedStepDefinition;
	status: "pending" | "running" | "done" | "attention" | "cancelled";
	attempts: number;
}

export class ScriptedWorkflowAdapter implements WorkflowAdapter {
	readonly id: string;
	readonly workflowRef: string;
	readonly trace: ScenarioTraceEvent[] = [];
	readonly violations: string[] = [];
	readonly starts = new Map<string, number>();
	peakConcurrency = 0;
	private sequence = 0;
	private readonly states: Map<string, StepState>;
	private readonly active = new Set<string>();

	constructor(readonly scenario: WorkflowScenarioDefinition) {
		this.id = `bench-${scenario.id}`;
		this.workflowRef = `bench:${scenario.id}`;
		this.states = new Map(scenario.steps.map((definition) => [definition.id, { definition, status: "pending", attempts: 0 }]));
		for (const step of scenario.steps) {
			for (const dependency of step.dependsOn ?? []) if (!this.states.has(dependency)) throw new Error(`Scenario ${scenario.id} step ${step.id} has unknown dependency ${dependency}`);
		}
	}

	canHandle(ref: string): boolean { return ref === this.workflowRef || ref.startsWith(`${this.workflowRef}/step:`) || ref.startsWith(`${this.workflowRef}/evaluation:`); }

	async prepareWorkflow(): Promise<void> { this.record({ type: "workflow_prepared", detail: this.workflowRef }); }

	async snapshot(ref: string): Promise<WorkflowSnapshot> {
		if (ref !== this.workflowRef) throw new Error(`Unknown scripted workflow ${ref}`);
		const steps = [...this.states.values()].map(({ definition, status }) => {
			const dependenciesDone = (definition.dependsOn ?? []).every((id) => this.states.get(id)?.status === "done");
			const visibleStatus: WorkflowStepStatus = status === "pending" ? dependenciesDone ? "ready" : "pending" : status;
			return {
				ref: this.stepRef(definition.id),
				title: definition.title ?? definition.id,
				kind: definition.kind ?? "task",
				status: visibleStatus,
				dependsOn: (definition.dependsOn ?? []).map((id) => this.stepRef(id)),
				parallelism: definition.parallelism ?? "allowed",
				resourceClaims: definition.resourceClaims ?? [],
			};
		});
		const status = steps.some((step) => step.status === "attention" || step.status === "cancelled") ? "attention"
			: steps.every((step) => step.status === "done") ? "done"
				: steps.some((step) => step.status === "running") ? "running" : "ready";
		return { ref, title: this.scenario.title, status, steps };
	}

	async runStep(ref: string): Promise<WorkflowRunResult> {
		const id = this.idFromRef(ref);
		const state = this.states.get(id);
		if (!state) throw new Error(`Unknown scripted step ${ref}`);
		if (state.status !== "pending") throw new Error(`Scripted step ${id} cannot start from ${state.status}`);
		const missing = (state.definition.dependsOn ?? []).filter((dependency) => this.states.get(dependency)?.status !== "done");
		if (missing.length) this.violations.push(`${id} started before dependencies completed: ${missing.join(", ")}`);
		const claims = new Set(state.definition.resourceClaims ?? []);
		for (const activeId of this.active) {
			const activeClaims = this.states.get(activeId)?.definition.resourceClaims ?? [];
			const collision = activeClaims.find((claim) => claims.has(claim));
			if (collision) this.violations.push(`${id} overlapped ${activeId} on resource claim ${collision}`);
		}
		state.status = "running";
		state.attempts++;
		this.starts.set(id, (this.starts.get(id) ?? 0) + 1);
		this.active.add(id);
		this.peakConcurrency = Math.max(this.peakConcurrency, this.active.size);
		this.record({ type: "step_started", stepId: id, active: [...this.active].sort() });
		await new Promise((resolve) => setTimeout(resolve, state.definition.delayMs ?? 1));
		const outcome = this.outcome(state.definition, state.attempts);
		this.active.delete(id);
		if (outcome === "complete") {
			state.status = "done";
			this.record({ type: "step_completed", stepId: id, active: [...this.active].sort() });
			return { ref, state: "completed", summary: `${id} completed.` };
		}
		if (outcome === "cancel") {
			state.status = "cancelled";
			this.record({ type: "step_cancelled", stepId: id, active: [...this.active].sort() });
			return { ref, state: "cancelled", summary: `${id} cancelled.`, attention: true };
		}
		state.status = "attention";
		this.record({ type: outcome === "block" ? "step_blocked" : "step_failed", stepId: id, active: [...this.active].sort() });
		return { ref, state: outcome === "block" ? "blocked" : "failed", summary: `${id} ${outcome === "block" ? "blocked" : "failed"}.`, attention: true };
	}

	async controlCheckpoint(ref: string, action: "approve" | "request_changes", _options?: { prompt?: string; acceptedRisks?: Array<{ findingId: string; rationale: string }> }): Promise<unknown> {
		const id = this.idFromRef(ref.replace("/evaluation:", "/step:"));
		const state = this.states.get(id);
		if (!state || state.definition.kind !== "evaluation") throw new Error(`Unknown scripted evaluation checkpoint ${ref}`);
		this.record({ type: "workflow_control", detail: `checkpoint:${action}:${id}` });
		if (action === "approve") state.status = "done";
		else state.status = "pending";
		return { id, action };
	}

	async controlWorkflow(_ref: string, action: "pause" | "resume" | "stop"): Promise<void> {
		this.record({ type: "workflow_control", detail: action });
		if (action === "resume") for (const state of this.states.values()) if (state.status === "attention" || state.status === "cancelled") state.status = "pending";
		if (action === "stop") for (const state of this.states.values()) if (state.status === "running") state.status = "cancelled";
	}

	async listSubagents(): Promise<unknown[]> { return []; }
	async listMessages(): Promise<unknown[]> { return []; }
	async controlSubagent(): Promise<unknown> { return {}; }
	async respondSubagent(): Promise<unknown> { return {}; }

	statuses(): Record<string, WorkflowStepStatus> {
		return Object.fromEntries([...this.states].map(([id, state]) => [id, state.status]));
	}

	private outcome(definition: ScriptedStepDefinition, attempt: number): ScriptedStepOutcome {
		const outcomes = definition.outcomes;
		return outcomes?.[Math.min(attempt - 1, outcomes.length - 1)] ?? definition.outcome ?? "complete";
	}

	private stepRef(id: string): string { return `${this.workflowRef}/step:${id}`; }
	private idFromRef(ref: string): string {
		const prefix = `${this.workflowRef}/step:`;
		if (!ref.startsWith(prefix)) throw new Error(`Invalid scripted step ref ${ref}`);
		return ref.slice(prefix.length);
	}
	private record(event: TraceInput): void { this.trace.push({ sequence: ++this.sequence, ...event } as ScenarioTraceEvent); }
}
