import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WORKFLOW_ADAPTER_DISCOVERY_EVENT = "pibox:workflow:discover-adapters";
export const WORKFLOW_CONTROL_EVENT = "pibox:workflow:control";

export type WorkflowStepStatus = "pending" | "ready" | "running" | "done" | "attention" | "cancelled";

export interface WorkflowStep {
	ref: string;
	title: string;
	kind: string;
	status: WorkflowStepStatus;
	dependsOn: string[];
	parallelism: "allowed" | "serial";
	resourceClaims: string[];
	detail?: string;
}

export interface WorkflowSnapshot {
	ref: string;
	title: string;
	status: "ready" | "running" | "paused" | "attention" | "done";
	steps: WorkflowStep[];
}

export interface WorkflowRunResult {
	ref: string;
	state: "completed" | "blocked" | "failed" | "cancelled";
	summary: string;
	agentId?: string;
	attention?: boolean;
}

/** Free-form main-session delegation. Managed workflow steps keep their canonical adapter-owned refs. */
export interface DynamicSubagentRequest {
	operationId: string;
	agent: string;
	task: string;
	tier?: "low" | "medium" | "high" | "max";
	deliberation?: "standard" | "deep";
	model?: string;
	effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	strict?: boolean;
}

export interface WorkflowAdapter {
	id: string;
	canHandle(ref: string): boolean;
	prepareWorkflow?(ref: string, ctx: ExtensionContext): Promise<void>;
	completionPrompt?(ref: string, ctx: ExtensionContext): Promise<string>;
	snapshot(ref: string, ctx: ExtensionContext): Promise<WorkflowSnapshot>;
	runStep(ref: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<WorkflowRunResult>;
	/** Optional dynamic agent/task launcher used by the main-session subagent_spawn tool. */
	spawnSubagent?(request: DynamicSubagentRequest, ctx: ExtensionContext, signal?: AbortSignal, onText?: (text: string) => void): Promise<WorkflowRunResult>;
	controlWorkflow(ref: string, action: "pause" | "resume" | "stop", ctx: ExtensionContext): Promise<void>;
	controlCheckpoint?(ref: string, action: "continue" | "retry" | "request_changes" | "skip" | "accept_risk", prompt: string | undefined, ctx: ExtensionContext): Promise<unknown>;
	listSubagents(ctx: ExtensionContext): Promise<unknown[]>;
	listMessages(ctx: ExtensionContext): Promise<unknown[]>;
	controlSubagent(agentId: string, action: "pause" | "stop", ctx: ExtensionContext): Promise<unknown>;
	respondSubagent(agentId: string, messageId: string, response: string, ctx: ExtensionContext): Promise<unknown>;
}

export interface WorkflowControlEvent { ref: string; action: "pause" | "resume" | "stop"; }

export interface WorkflowAdapterDiscovery {
	register(adapter: WorkflowAdapter): void;
}
