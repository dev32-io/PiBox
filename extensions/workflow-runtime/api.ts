import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentProgress } from "./agent-progress.js";

export const WORKFLOW_ADAPTER_DISCOVERY_EVENT = "pibox:workflow:discover-adapters";
export const WORKFLOW_CONTROL_EVENT = "pibox:workflow:control";
export const WORKFLOW_FEEDBACK_EVENT = "pibox:workflow:feedback";

export interface WorkflowFeedbackEvent {
	type: "task-completed" | "error";
	workflowRef: string;
	stepRef?: string;
	kind?: string;
	title: string;
	detail?: string;
	fromStatus?: string;
	toStatus?: string;
	cause?: string;
	attempt?: number;
	iteration?: number;
	nextAction?: string;
	/** Correlates workflow feedback with the turn that caused it when available. */
	correlationId?: string;
	terminal?: boolean;
}

export type WorkflowStepStatus = "pending" | "ready" | "running" | "done" | "attention" | "cancelled";

export type WorkflowStepPhase = "implementing" | "contribution-ready" | "ready-to-integrate" | "assembling-candidate" | "verifying-candidate" | "verification-failed" | "integrated";

export interface WorkflowStep {
	ref: string;
	title: string;
	kind: string;
	status: WorkflowStepStatus;
	phase?: WorkflowStepPhase;
	dependsOn: string[];
	parallelism: "allowed" | "serial";
	resourceClaims: string[];
	detail?: string;
	progress?: AgentProgress;
}

export interface WorkflowStageSnapshot {
	id: string;
	index: number;
	nodes: string[];
	parallel: boolean;
	group?: "planner" | "runtime";
}

export interface WorkflowSnapshot {
	ref: string;
	title: string;
	status: "ready" | "running" | "paused" | "attention" | "done";
	steps: WorkflowStep[];
	/** Stage-aware rendering metadata; absent on third-party/legacy adapters. */
	stages?: WorkflowStageSnapshot[];
}

export interface WorkflowRunResult {
	ref: string;
	state: "completed" | "blocked" | "failed" | "cancelled";
	summary: string;
	agentId?: string;
	attention?: boolean;
}

export interface DynamicSubagentStarted {
	agentId: string;
	provider: string;
	model: string;
	effort: string;
	startedAt: string;
}

export interface SpawnableAgentDefinition {
	name: string;
	description: string;
	tier: "low" | "medium" | "high" | "max";
	source: "built-in" | "configured" | "project";
}

/** Free-form main-session delegation. Managed workflow steps keep their canonical adapter-owned refs. */
export type DynamicSubagentTier = "low" | "medium" | "high" | "max" | "local";

/** Infer provider-isolated local routing only from an explicit local-llm model. */
export function inferDynamicSubagentTier(tier?: DynamicSubagentTier, model?: string): DynamicSubagentTier {
	if (tier) return tier;
	return model?.trim().startsWith("local-llm/") ? "local" : "medium";
}

export interface DynamicSubagentRequest {
	operationId: string;
	agent: string;
	task: string;
	/** Selects a configured capability tier or the provider-isolated local route list. */
	tier?: DynamicSubagentTier;
	/** Preferred configured model, optionally provider-qualified or suffixed with #effort. */
	model?: string;
	/** Overrides a #effort suffix or the preferred route's configured effort. */
	effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface WorkflowStartProgress {
	phase: "Validating prerequisites" | "Finalizing reviewed plan" | "Validating working branch" | "Creating runtime verification gates" | "Activating tasks" | "Building execution snapshot" | "Starting workflow";
	elapsedMs: number;
}

export interface WorkflowPreflight {
	ok: boolean;
	detail?: string;
	missingCommands?: string[];
	missingEnvironment?: string[];
}

export interface WorkflowExecutionControl {
	workflowRef: string;
	mode: "running" | "paused" | "stopped" | "completed";
	generation: number;
	ownerSessionId?: string;
}

export interface WorkflowLifecycleUpdate {
	workflowRef: string;
	title: string;
	detail?: string;
	attention: boolean;
	kind?: string;
	toStatus?: WorkflowStepStatus;
	cause?: string;
}

export interface WorkflowAdapter {
	id: string;
	canHandle(ref: string): boolean;
	/** Subscribe to durable worker lifecycle transitions for event-driven refreshes. Setup may be asynchronous. */
	subscribeLifecycle?(ref: string, ctx: ExtensionContext, listener: (update?: WorkflowLifecycleUpdate) => void, signal?: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
	/** Durable workflow ownership boundary. Commands are idempotent by operationId. */
	controlExecution?(ref: string, command: "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach", operationId: string, ctx: ExtensionContext): Promise<WorkflowExecutionControl>;
	listExecutionControls?(ctx: ExtensionContext): Promise<WorkflowExecutionControl[]>;
	assertExecutionCurrent?(ref: string, generation: number, ctx: ExtensionContext): Promise<void>;
	/** Explicit supervisor reconciliation command; snapshots remain pure reads. */
	reconcileWorkflow?(ref: string, ctx: ExtensionContext): Promise<void>;
	/** Cheap, side-effect-free validation performed before any worker is launched. */
	preflightWorkflow?(ref: string, ctx: ExtensionContext): Promise<WorkflowPreflight>;
	prepareWorkflow?(ref: string, ctx: ExtensionContext, onUpdate?: (progress: WorkflowStartProgress) => void): Promise<void>;
	completionPrompt?(ref: string, ctx: ExtensionContext): Promise<string>;
	snapshot(ref: string, ctx: ExtensionContext): Promise<WorkflowSnapshot>;
	runStep(ref: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<WorkflowRunResult>;
	/** Optional dynamic agent/task launcher used by the main-session subagent_spawn tool. */
	spawnSubagent?(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void, onStarted?: (status: DynamicSubagentStarted) => void, onProgress?: (progress: AgentProgress) => void): Promise<WorkflowRunResult>;
	/** Trusted, validated definitions available to the generic launcher. */
	listSpawnableAgents?(ctx: ExtensionContext): Promise<SpawnableAgentDefinition[]>;
	controlWorkflow(ref: string, action: "pause" | "resume" | "stop", ctx: ExtensionContext): Promise<void>;
	controlCheckpoint?(ref: string, action: "approve" | "request_changes", options: { prompt?: string; acceptedRisks?: Array<{ findingId: string; rationale: string }> } | undefined, ctx: ExtensionContext): Promise<unknown>;
	listSubagents(ctx: ExtensionContext): Promise<unknown[]>;
	listMessages(ctx: ExtensionContext): Promise<unknown[]>;
	controlSubagent(agentId: string, action: "pause" | "stop", ctx: ExtensionContext): Promise<unknown>;
	respondSubagent(agentId: string, messageId: string, response: string, ctx: ExtensionContext): Promise<unknown>;
}

export interface WorkflowControlEvent { ref: string; action: "pause" | "resume" | "stop"; }

export interface WorkflowAdapterDiscovery {
	register(adapter: WorkflowAdapter): void;
}
