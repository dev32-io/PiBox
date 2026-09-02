import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StoryRuntimeState } from "../workflow/story-runtime-store.js";

export const WORKFLOW_CONTROL_EVENT = "pibox:workflow:control";
export const WORKFLOW_LIFECYCLE_EVENT = "pibox:workflow:lifecycle";

export interface WorkflowLifecycleEvent {
	type: "stage-completed" | "error";
	workflowRef: string;
	stageId?: string;
	title: string;
	detail?: string;
	cause?: string;
	nextAction?: string;
	correlationId?: string;
}

export interface WorkflowSnapshot {
	ref: string;
	title: string;
	status: "ready" | "running" | "paused" | "attention" | "done";
	runtime: StoryRuntimeState;
}

export interface WorkflowStartProgress {
	phase: "Validating prerequisites" | "Building execution snapshot" | "Starting workflow";
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
	ownerSessionId?: string;
	ownerProcessInstanceId?: string;
	ownerActivationId?: string;
}

export interface WorkflowAttentionDecision {
	action: "request_changes" | "approve";
	prompt?: string;
	acceptedRisks?: readonly { findingId: string; rationale: string }[];
}

export interface WorkflowLifecycleUpdate {
	workflowRef: string;
	lifecycle?: WorkflowLifecycleEvent;
	title: string;
	detail?: string;
	attention: boolean;
	cause?: string;
}

export interface WorkflowAdapter {
	id: string;
	canHandle(ref: string): boolean;
	subscribeLifecycle?(ref: string, ctx: ExtensionContext, listener: (update?: WorkflowLifecycleUpdate) => void, signal?: AbortSignal): void | (() => void) | Promise<void | (() => void)>;
	controlExecution(ref: string, command: "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach", operationId: string, ctx: ExtensionContext): Promise<WorkflowExecutionControl>;
	listExecutionControls?(ctx: ExtensionContext): Promise<WorkflowExecutionControl[]>;
	reconcileActivation?(ctx: ExtensionContext): Promise<void>;
	reconcileWorkflow?(ref: string, ctx: ExtensionContext): Promise<void>;
	advanceWorkflow(ref: string, ctx: ExtensionContext): Promise<void>;
	resolveAttention?(ref: string, decision: WorkflowAttentionDecision, ctx: ExtensionContext, options?: { dryRun?: boolean }): Promise<StoryRuntimeState>;
	preflightWorkflow?(ref: string, ctx: ExtensionContext): Promise<WorkflowPreflight>;
	prepareWorkflow?(ref: string, ctx: ExtensionContext, onUpdate?: (progress: WorkflowStartProgress) => void): Promise<void>;
	completionPrompt?(ref: string, ctx: ExtensionContext): Promise<string>;
	snapshot(ref: string, ctx: ExtensionContext): Promise<WorkflowSnapshot>;
	controlWorkflow(ref: string, action: "pause" | "resume" | "stop", ctx: ExtensionContext): Promise<void>;
}

export interface WorkflowControlEvent { ref: string; action: "pause" | "resume" | "stop"; operationId?: string }
