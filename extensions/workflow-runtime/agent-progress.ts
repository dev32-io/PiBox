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
	outputTokens: number;
	reasoningTokens: number;
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
		return {
			...current,
			lastEventAt: observedAt,
			turns: current.turns + 1,
			outputTokens: current.outputTokens + nonNegativeInteger(usage.output),
			reasoningTokens: current.reasoningTokens + nonNegativeInteger(usage.reasoning),
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
	return { startedAt, lastEventAt: startedAt, turns: 0, toolCalls: 0, toolErrors: 0, outputTokens: 0, reasoningTokens: 0 };
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

function compactNumber(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 10_000) return `${(Math.round(value / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
	if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
	return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function elapsed(from: string, toMs: number): string {
	const seconds = Math.max(0, Math.floor((toMs - Date.parse(from)) / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function formatAgentProgress(progress: AgentProgress | undefined, now = Date.now()): string {
	if (!progress) return "";
	const terminalAt = progress.processExitedAt ? Date.parse(progress.processExitedAt) : progress.settledAt ? Date.parse(progress.settledAt) : now;
	const parts = [elapsed(progress.startedAt, terminalAt)];
	if (progress.turns > 0) parts.push(`${progress.turns} turn${progress.turns === 1 ? "" : "s"}`);
	if (progress.toolCalls > 0) parts.push(`${progress.toolCalls} tool${progress.toolCalls === 1 ? "" : "s"}`);
	if (progress.activeTool) parts.push(progress.activeTool);
	if (progress.outputTokens > 0) parts.push(`↓ ${compactNumber(progress.outputTokens)}`);
	const processStatus = formatAgentProcessStatus(progress);
	if (processStatus) parts.push(processStatus);
	return parts.join(" · ");
}
