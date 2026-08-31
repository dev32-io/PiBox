export interface AgentProgress {
	startedAt: string;
	/** Set only after the child Pi process has successfully spawned. */
	processStartedAt?: string;
	/** Set after the child Pi process exits, independently of agent event activity. */
	processExitedAt?: string;
	lastEventAt: string;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	/** Cumulative input usage across observed turns; absent in historical records. */
	inputTokens?: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	contextTokens?: number;
	activeTool?: string;
	settledAt?: string;
}

function safeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 32);
	return normalized || undefined;
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Pure, privacy-preserving projection of Pi's JSON event stream. */
export function projectAgentProgress(current: AgentProgress, event: unknown, observedAt = new Date().toISOString()): AgentProgress {
	if (!event || typeof event !== "object") return current;
	const value = event as { type?: string; toolName?: unknown; isError?: unknown; message?: { usage?: Record<string, unknown> } };
	if (value.type === "tool_execution_start") {
		const activeTool = safeToolName(value.toolName);
		return { ...current, lastEventAt: observedAt, ...(activeTool ? { activeTool } : {}) };
	}
	if (value.type === "tool_execution_end") {
		const next = { ...current, lastEventAt: observedAt, toolCalls: current.toolCalls + 1, toolErrors: current.toolErrors + (value.isError === true ? 1 : 0) };
		delete next.activeTool;
		return next;
	}
	if (value.type === "turn_end") {
		const usage = value.message?.usage ?? {};
		const contextTokens = nonNegativeInteger(usage.totalTokens);
		const cacheReadTokens = (current.cacheReadTokens ?? 0) + nonNegativeInteger(usage.cacheRead);
		const cacheWriteTokens = (current.cacheWriteTokens ?? 0) + nonNegativeInteger(usage.cacheWrite);
		return {
			...current,
			lastEventAt: observedAt,
			turns: current.turns + 1,
			inputTokens: (current.inputTokens ?? 0) + nonNegativeInteger(usage.input),
			outputTokens: current.outputTokens + nonNegativeInteger(usage.output),
			reasoningTokens: current.reasoningTokens + nonNegativeInteger(usage.reasoning),
			...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
			...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
			...(contextTokens > 0 ? { contextTokens } : {}),
		};
	}
	if (value.type === "agent_settled") {
		const next = { ...current, lastEventAt: observedAt, settledAt: observedAt };
		delete next.activeTool;
		return next;
	}
	return current;
}

export function initialAgentProgress(startedAt: string): AgentProgress {
	return { startedAt, lastEventAt: startedAt, turns: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
}

export function markAgentProcessStarted(progress: AgentProgress, observedAt = new Date().toISOString()): AgentProgress {
	return progress.processStartedAt ? progress : { ...progress, processStartedAt: observedAt };
}

export function markAgentProcessExited(progress: AgentProgress, observedAt = new Date().toISOString()): AgentProgress {
	return progress.processExitedAt ? progress : { ...progress, processExitedAt: observedAt };
}

export function formatAgentProcessStatus(progress: AgentProgress | undefined): "starting" | "active" | undefined {
	if (!progress) return "starting";
	if (progress.processExitedAt) return undefined;
	if (progress.processStartedAt) return "active";
	if (progress.settledAt) return undefined;
	// Activity is a compatibility signal for progress records written before
	// processStartedAt was introduced; any child event proves Pi has spawned.
	const observedProcessActivity = progress.turns > 0 || progress.toolCalls > 0 || progress.outputTokens > 0 || Boolean(progress.activeTool);
	return observedProcessActivity ? "active" : "starting";
}

const MAX_DISPLAY_COUNT = 1_000_000_000;

function displayCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(MAX_DISPLAY_COUNT, Math.max(0, Math.round(value)));
}

function compactNumber(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(Math.round(value / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function timestamp(value: string | number | undefined): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function elapsed(from: string | number, toMs: number): string {
	const fromMs = timestamp(from) ?? toMs;
	const seconds = Math.max(0, Math.floor((toMs - fromMs) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export interface AgentProgressFormatOptions {
	fallbackStartedAt?: string | number;
	/** Manager-derived process state; lifecycle facts remain authoritative over event timing. */
	processStatus?: "starting" | "active";
	/** Render the lifecycle word even when no progress projection exists yet. */
	showStarting?: boolean;
	/** Keep startup visible while allowing compact active surfaces to omit a redundant label. */
	showActive?: boolean;
}

/**
 * Format the bounded, semantic live-progress vocabulary shared by inline
 * subagents, the background footer, and managed workflow task rows.
 */
export function formatAgentProgress(progress: AgentProgress | undefined, now = Date.now(), options: AgentProgressFormatOptions = {}): string {
	if (!progress && options.fallbackStartedAt === undefined && options.showStarting !== true) return "";
	const safeNow = timestamp(now) ?? Date.now();
	const startedAt = progress?.startedAt ?? options.fallbackStartedAt;
	const terminalAt = timestamp(progress?.processExitedAt) ?? timestamp(progress?.settledAt) ?? safeNow;
	const parts = startedAt === undefined ? [] : [elapsed(startedAt, terminalAt)];
	const turns = displayCount(progress?.turns);
	const toolCalls = displayCount(progress?.toolCalls);
	const outputTokens = displayCount(progress?.outputTokens);
	const cacheReadTokens = displayCount(progress?.cacheReadTokens);
	const cacheWriteTokens = displayCount(progress?.cacheWriteTokens);
	if (turns > 0) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
	if (toolCalls > 0) parts.push(`${toolCalls} tool${toolCalls === 1 ? "" : "s"}`);
	const activeTool = safeToolName(progress?.activeTool);
	if (activeTool) parts.push(activeTool);
	if (outputTokens > 0) parts.push(`↓ ${compactNumber(outputTokens)}`);
	if (cacheReadTokens > 0) parts.push(`R ${compactNumber(cacheReadTokens)}`);
	if (cacheWriteTokens > 0) parts.push(`W ${compactNumber(cacheWriteTokens)}`);
	const processStatus = options.processStatus ?? formatAgentProcessStatus(progress);
	if (processStatus && (processStatus !== "active" || options.showActive !== false)) parts.push(processStatus);
	return parts.join(" · ");
}
