import type { AgentProgress } from "./agent-progress.js";

/** Identity of the one live main-session activation that owns a service. */
export interface RuntimeOwner {
	readonly sessionId: string;
	readonly processInstanceId: string;
	readonly activationId: string;
}

export interface PromptContext {
	readonly stableSystemContext: string;
	readonly attemptUserPrompt: string;
}

/** Content-only diagnostics. Transport paths, environment, and credentials are never hashed here. */
export interface PromptContextHashes {
	readonly stableSystemContextHash: string;
	readonly attemptUserTurnHash: string;
}

/** Opaque, service-issued continuation capability. Transport identity remains manager-private. */
export interface LogicalAgentHandle {
	readonly owner: RuntimeOwner;
	readonly agentId: string;
	readonly continuationCapability: string;
}

/** Fully resolved launch configuration. Record values are child environment entries. */
export interface ResolvedExecutionConfig {
	readonly provider: string;
	readonly model: string;
	readonly effort: string;
	readonly tools: readonly string[];
	readonly extensionPaths: readonly string[];
	readonly skillPaths: readonly string[];
	readonly fast: boolean;
	readonly env?: Readonly<Record<string, string>>;
	readonly workflowCredentials?: Readonly<Record<string, string>>;
	readonly workflowMetadata?: Readonly<Record<string, string>>;
}

export interface LaunchSpec extends PromptContext, ResolvedExecutionConfig {
	readonly owner: RuntimeOwner;
	readonly agent: string;
	readonly cwd: string;
	/** Opaque caller key for deciding whether transcript continuation is safe. */
	readonly continuationKey?: string;
	/** Environment metadata for only the initial attempt. */
	readonly attemptMetadata?: Readonly<Record<string, string>>;
	/** In-process capability fence rechecked after invocation resolution and before spawn. */
	readonly beforeSpawn?: () => void | Promise<void>;
}

export interface ContinuationSpec {
	readonly owner: RuntimeOwner;
	readonly handle: LogicalAgentHandle;
	readonly attemptUserPrompt: string;
	/** Safe attempt-scoped overrides; the prior resolved model/tool prefix is immutable. */
	readonly attemptMetadata?: Readonly<Record<string, string>>;
	readonly env?: Readonly<Record<string, string>>;
	readonly workflowCredentials?: Readonly<Record<string, string>>;
	/** In-process capability fence rechecked after invocation resolution and before spawn. */
	readonly beforeSpawn?: () => void | Promise<void>;
}

export type TerminalStatus = "completed" | "failed" | "cancelled";
export type TerminalReason = "completed" | "failure" | "explicit_stop" | "owner_lost";

export interface TerminalResult {
	readonly owner: RuntimeOwner;
	readonly handle: LogicalAgentHandle;
	readonly attemptId: string;
	readonly contextHashes: PromptContextHashes;
	readonly status: TerminalStatus;
	/** Semantic cause, preserved independently from the transport exit code. */
	readonly reason: TerminalReason;
	readonly exitCode: number | null;
	readonly text: string;
	readonly stderr?: string;
	readonly progress?: AgentProgress;
}

export type LogicalAgentState = "launching" | "running" | "stopping" | "completed" | "failed" | "cancelled";

export interface LogicalAgentSnapshot {
	readonly handle: LogicalAgentHandle;
	readonly agent: string;
	readonly state: LogicalAgentState;
	readonly attemptId?: string;
	/** Hashes for the current or most recently settled attempt. */
	readonly contextHashes?: PromptContextHashes;
	readonly processId?: number;
	readonly provider: string;
	readonly model: string;
	readonly effort: string;
	readonly fast: boolean;
	/** Opaque caller key for deciding whether transcript continuation is safe. */
	readonly continuationKey?: string;
	/** Non-secret workflow identity used to rebind after extension reload. */
	readonly workflowMetadata?: Readonly<Record<string, string>>;
	/** Non-secret metadata for the current or most recently settled attempt. */
	readonly attemptMetadata?: Readonly<Record<string, string>>;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly progress?: AgentProgress;
	readonly summary?: string;
}

export interface SubagentSnapshot {
	readonly owner: RuntimeOwner;
	readonly cursor: number;
	readonly agents: readonly LogicalAgentSnapshot[];
}

export type SubagentEventType =
	| "attempt_started"
	| "message_delta"
	| "tool_activity"
	| "usage"
	| "final_message"
	| "stop_requested"
	| "terminating"
	| "process_exited"
	| "output_drained"
	| "terminal";

/** Normalized service event. cursor is activation-wide; sequence is attempt-local. */
export interface SubagentEvent {
	readonly owner: RuntimeOwner;
	readonly cursor: number;
	readonly agentId: string;
	readonly attemptId: string;
	readonly sequence: number;
	readonly type: SubagentEventType;
	readonly at: string;
	readonly data?: Readonly<Record<string, unknown>>;
}

export interface SubagentReplay {
	/** Snapshot at the requested cursor, or the latest snapshot when replay reset. */
	readonly snapshot: SubagentSnapshot;
	readonly events: readonly SubagentEvent[];
	readonly reset: boolean;
}

export type SubagentEventListener = (event: SubagentEvent) => void;

/** Initial replay is returned atomically with installation of the live listener. */
export interface SubagentSubscription {
	readonly initial: SubagentReplay;
	unsubscribe(): void;
}

export interface SubagentInspection {
	readonly handle?: LogicalAgentHandle;
	readonly workflowMetadata?: Readonly<Record<string, string>>;
}

/** Public standalone boundary. Implementations must fence every owner-bearing call. */
export interface SubagentService {
	readonly protocolVersion: number;
	readonly owner: RuntimeOwner;
	launch(spec: LaunchSpec): Promise<{ handle: LogicalAgentHandle; result: Promise<TerminalResult> }>;
	continue(spec: ContinuationSpec): Promise<{ handle: LogicalAgentHandle; result: Promise<TerminalResult> }>;
	/** Wait for the active or most recently settled attempt represented by a live handle. */
	wait(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<TerminalResult>;
	/** Inspect live in-memory agents without exposing transcript paths or credentials. */
	inspect(owner: RuntimeOwner, query?: SubagentInspection): readonly LogicalAgentSnapshot[];
	stop(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void>;
	/** Release a settled logical agent and delete its private transcript and diagnostics. */
	release(owner: RuntimeOwner, handle: LogicalAgentHandle): Promise<void>;
	replay(owner: RuntimeOwner, afterCursor?: number): SubagentReplay;
	subscribe(owner: RuntimeOwner, afterCursor: number, listener: SubagentEventListener): SubagentSubscription;
	teardown(): void | Promise<void>;
}
