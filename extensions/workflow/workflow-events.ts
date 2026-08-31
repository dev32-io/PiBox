import type { WorkflowMetricCategory } from "../workflow-runtime/api.js";
import { RepositoryEventStore, type HarnessEvent } from "./event-store.js";

export type WorkflowDomainEventType =
	| "workflow.started"
	| "workflow.paused"
	| "workflow.resumed"
	| "workflow.stopped"
	| "workflow.completed"
	| "workflow.failed"
	| "workflow.detached"
	| "workflow.attached"
	| "step.ready"
	| "step.started"
	| "step.settled"
	| "step.failed"
	| "stage.completed"
	| "agent.reserved"
	| "agent.attempt_started"
	| "agent.running"
	| "agent.reported"
	| "agent.failed"
	| "agent.cancelled"
	| "checkpoint.required"
	| "checkpoint.decision_recorded";

export interface WorkflowTransitionData {
	from?: string;
	to?: string;
	cause?: string;
	summary?: string;
	attention?: boolean;
	nextAction?: string;
}

export interface WorkflowDomainEventInput {
	type: WorkflowDomainEventType;
	workItemId: string;
	ownerGeneration: number;
	correlationId: string;
	causationId?: string;
	stepRef?: string;
	stageId?: string;
	stageIndex?: number;
	stepKind?: string;
	runId?: string;
	agentId?: string;
	activity?: { kind: "review" | "repair"; generation: number };
	metricCategory?: Exclude<WorkflowMetricCategory, "orchestration">;
	transition?: WorkflowTransitionData;
}

interface PersistedWorkflowDomainEvent extends Omit<WorkflowDomainEventInput, "type"> {
	schemaVersion: 1;
	repositoryId: string;
}

export interface WorkflowDomainEvent extends WorkflowDomainEventInput {
	id: string;
	sequence: number;
	at: string;
	repositoryId: string;
}

function project(repositoryId: string, event: HarnessEvent<PersistedWorkflowDomainEvent>): WorkflowDomainEvent {
	return {
		id: `${repositoryId}:${event.sequence}`,
		sequence: event.sequence,
		at: event.at,
		type: event.type as WorkflowDomainEventType,
		repositoryId,
		workItemId: event.data.workItemId,
		ownerGeneration: event.data.ownerGeneration,
		correlationId: event.data.correlationId,
		...(event.data.causationId ? { causationId: event.data.causationId } : {}),
		...(event.data.stepRef ? { stepRef: event.data.stepRef } : {}),
		...(event.data.stageId ? { stageId: event.data.stageId } : {}),
		...(event.data.stageIndex !== undefined ? { stageIndex: event.data.stageIndex } : {}),
		...(event.data.stepKind ? { stepKind: event.data.stepKind } : {}),
		...(event.data.runId ? { runId: event.data.runId } : {}),
		...(event.data.agentId ? { agentId: event.data.agentId } : {}),
		...(event.data.activity ? { activity: event.data.activity } : {}),
		...(event.data.metricCategory ? { metricCategory: event.data.metricCategory } : {}),
		...(event.data.transition ? { transition: event.data.transition } : {}),
	};
}

function boundedEventText(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return value.length <= 4_096 ? value : `${value.slice(0, 4_080)}…`;
}

function isPersistedWorkflowEvent(event: HarnessEvent): event is HarnessEvent<PersistedWorkflowDomainEvent> {
	if (!event.type.startsWith("workflow.") && !event.type.startsWith("step.") && !event.type.startsWith("stage.") && !event.type.startsWith("agent.") && !event.type.startsWith("checkpoint.")) return false;
	if (!event.data || typeof event.data !== "object") return false;
	const data = event.data as Partial<PersistedWorkflowDomainEvent>;
	return data.schemaVersion === 1 && typeof data.repositoryId === "string" && typeof data.workItemId === "string" && Number.isInteger(data.ownerGeneration) && typeof data.correlationId === "string";
}

/** Typed semantic workflow facts stored in the repository event journal. */
export class WorkflowEventJournal {
	constructor(readonly store: RepositoryEventStore) {}

	async append(input: WorkflowDomainEventInput): Promise<WorkflowDomainEvent> {
		if (!input.workItemId || !input.correlationId || !Number.isInteger(input.ownerGeneration) || input.ownerGeneration < 1) throw new Error("Workflow events require work item, correlation, and positive owner generation");
		const { type, ...payload } = input;
		const summary = boundedEventText(payload.transition?.summary);
		const nextAction = boundedEventText(payload.transition?.nextAction);
		const transition: WorkflowTransitionData | undefined = payload.transition ? {
			...payload.transition,
			...(summary !== undefined ? { summary } : {}),
			...(nextAction !== undefined ? { nextAction } : {}),
		} : undefined;
		const event = await this.store.append(type, { schemaVersion: 1 as const, repositoryId: this.store.identity.id, ...payload, ...(transition ? { transition } : {}) });
		return project(this.store.identity.id, event);
	}

	async readSince(cursor: number, workItemId?: string): Promise<WorkflowDomainEvent[]> {
		const events = await this.store.readSince(cursor);
		return events
			.filter(isPersistedWorkflowEvent)
			.filter((event) => event.data.repositoryId === this.store.identity.id && (!workItemId || event.data.workItemId === workItemId))
			.map((event) => project(this.store.identity.id, event));
	}

	subscribe(listener: (event: WorkflowDomainEvent) => void): () => void {
		return this.store.subscribe((event) => {
			if (isPersistedWorkflowEvent(event) && event.data.repositoryId === this.store.identity.id) listener(project(this.store.identity.id, event));
		});
	}
}
