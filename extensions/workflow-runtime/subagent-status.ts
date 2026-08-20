import { TERMINAL_AGENT_STATES } from "./agent-registry.js";

/** The point-in-time query defaults used by subagent_status. */
export const DEFAULT_SUBAGENT_STATUS_LIMIT = 12;
export const MAX_SUBAGENT_STATUS_LIMIT = 20;

export interface SubagentStatusFilters {
	agentId?: string;
	workflowRef?: string;
	state?: string;
	includeSettled?: boolean;
	limit?: number;
}

export interface SubagentStatusProgress {
	startedAt?: string;
	processStartedAt?: string;
	processExitedAt?: string;
	lastEventAt?: string;
	turns: number;
	toolCalls: number;
	toolErrors: number;
	outputTokens: number;
	reasoningTokens: number;
	contextTokens?: number;
	activeTool?: string;
	settledAt?: string;
}

export interface SubagentStatusAgent {
	id: string;
	role: string;
	state: string;
	provider?: string;
	model?: string;
	effort?: string;
	fast?: boolean;
	workflowRef?: string;
	startedAt?: string;
	updatedAt?: string;
	progress?: SubagentStatusProgress;
	summary?: string;
	error?: string;
	attention: boolean;
	openMessageCount?: number;
}

export interface SubagentStatusMessage {
	id: string;
	agentId?: string;
	workflowRef?: string;
	type?: string;
	status: "open";
	blocking?: boolean;
	summary?: string;
	title?: string;
	updatedAt?: string;
}

export interface SubagentStatusPayload {
	agents: SubagentStatusAgent[];
	openMessages: SubagentStatusMessage[];
	counts: {
		agents: number;
		actionableAgents: number;
		settledAgents: number;
		openMessages: number;
		returnedAgents: number;
		returnedOpenMessages: number;
	};
	page: {
		limit: number;
		hasMoreAgents: boolean;
		hasMoreMessages: boolean;
	};
}

type RecordValue = Record<string, unknown>;

type ProjectedAgent = SubagentStatusAgent & {
	actionable: boolean;
	sortTime: number;
};

const ATTENTION_STATES = new Set([
	"failed",
	"protocol_failed",
	"recovery_required",
	"interrupted",
	"waiting_decision",
	"blocked",
	"paused",
	"waiting_model",
	"waiting_capacity",
	"reported",
]);
const ACTIVE_STATES = new Set(["reserved", "launching", "running"]);

function isRecord(value: unknown): value is RecordValue {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
	return normalized ? normalized.slice(0, limit) : undefined;
}

function number(value: unknown, maximum = 1_000_000_000): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(maximum, Math.max(0, Math.round(value)));
}

function timestamp(value: unknown): string | undefined {
	return text(value, 64);
}

function sortTime(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return 0;
}

function stateOf(source: RecordValue): string {
	return text(source.state ?? source.status, 64) ?? "unknown";
}

function agentIdOf(source: RecordValue): string | undefined {
	return text(source.id ?? source.agentId, 160);
}

function workflowRefOf(source: RecordValue): string | undefined {
	const explicit = text(source.workflowRef, 180);
	if (explicit) return explicit;
	const workItemId = text(source.workItemId, 120);
	if (!workItemId) return undefined;
	return workItemId.startsWith("work-item:") ? workItemId : `work-item:${workItemId}`;
}

function currentAttempt(source: RecordValue): RecordValue | undefined {
	if (!Array.isArray(source.attempts)) return undefined;
	const attempts = source.attempts.filter(isRecord);
	const currentId = text(source.currentAttemptId, 160);
	return currentId ? attempts.find((attempt) => attempt.id === currentId) : undefined;
}

function progressOf(source: RecordValue, attempt: RecordValue | undefined): SubagentStatusProgress | undefined {
	const raw = isRecord(attempt?.progress) ? attempt.progress : !Array.isArray(source.attempts) && isRecord(source.progress) ? source.progress : undefined;
	if (!raw) return undefined;
	const progress: SubagentStatusProgress = {
		turns: number(raw.turns),
		toolCalls: number(raw.toolCalls),
		toolErrors: number(raw.toolErrors),
		outputTokens: number(raw.outputTokens),
		reasoningTokens: number(raw.reasoningTokens),
	};
	for (const key of ["startedAt", "processStartedAt", "processExitedAt", "lastEventAt", "settledAt"] as const) {
		const value = timestamp(raw[key]);
		if (value) progress[key] = value;
	}
	const contextTokens = number(raw.contextTokens);
	if (contextTokens > 0) progress.contextTokens = contextTokens;
	const activeTool = text(raw.activeTool, 32)?.replace(/[^a-zA-Z0-9_.:-]/g, "");
	if (activeTool) progress.activeTool = activeTool;
	return progress;
}

function projectAgent(value: unknown): ProjectedAgent | undefined {
	if (!isRecord(value)) return undefined;
	const id = agentIdOf(value);
	if (!id) return undefined;
	const attempt = currentAttempt(value);
	const state = stateOf(value);
	const workflowRef = workflowRefOf(value);
	const provider = text(attempt?.provider ?? value.provider, 120);
	const model = text(attempt?.model ?? value.model, 160);
	const effort = text(attempt?.effort ?? value.effort, 32);
	const fast = attempt?.fast === true || (!attempt && value.fast === true);
	const startedAt = timestamp(value.startedAt);
	const updatedAt = timestamp(value.updatedAt);
	const progress = progressOf(value, attempt);
	const summary = text(value.summary, 240);
	const error = text(value.error, 240);
	const attention = ATTENTION_STATES.has(state);
	return {
		id,
		role: text(value.role ?? value.name, 120) ?? "unknown",
		state,
		...(provider ? { provider } : {}),
		...(model ? { model } : {}),
		...(effort ? { effort } : {}),
		...(fast ? { fast: true } : {}),
		...(workflowRef ? { workflowRef } : {}),
		...(startedAt ? { startedAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
		...(progress ? { progress } : {}),
		...(summary ? { summary } : {}),
		...(error ? { error } : {}),
		attention,
		actionable: !TERMINAL_AGENT_STATES.has(state as never) || attention,
		sortTime: sortTime(value.updatedAt ?? value.completedAt ?? value.startedAt),
	};
}

function projectMessage(value: unknown, agents: Map<string, ProjectedAgent>): SubagentStatusMessage | undefined {
	if (!isRecord(value)) return undefined;
	const status = text(value.status, 32);
	if (status && status !== "open") return undefined;
	const id = text(value.id ?? value.messageId, 160);
	if (!id) return undefined;
	const agentId = text(value.agentId, 160);
	const owner = agentId ? agents.get(agentId) : undefined;
	const workflowRef = text(value.workflowRef, 180) ?? owner?.workflowRef;
	const type = text(value.type ?? value.kind, 64);
	const summary = text(value.summary, 240);
	const title = text(value.title, 160);
	const updatedAt = timestamp(value.updatedAt ?? value.createdAt);
	return {
		id,
		...(agentId ? { agentId } : {}),
		...(workflowRef ? { workflowRef } : {}),
		...(type ? { type } : {}),
		status: "open",
		...(typeof value.blocking === "boolean" ? { blocking: value.blocking } : {}),
		...(summary ? { summary } : {}),
		...(title ? { title } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

function compareNewest(left: { sortTime: number; id: string }, right: { sortTime: number; id: string }): number {
	return right.sortTime - left.sortTime || left.id.localeCompare(right.id);
}

function compareAgent(left: ProjectedAgent, right: ProjectedAgent): number {
	const rank = (agent: ProjectedAgent): number => agent.attention ? 2 : ACTIVE_STATES.has(agent.state) ? 1 : 0;
	return rank(right) - rank(left) || compareNewest(left, right);
}

function compareMessage(left: SubagentStatusMessage, right: SubagentStatusMessage): number {
	return compareNewest({ sortTime: sortTime(left.updatedAt), id: left.id }, { sortTime: sortTime(right.updatedAt), id: right.id });
}

function matchesWorkflow(agent: ProjectedAgent | SubagentStatusMessage, workflowRef: string | undefined): boolean {
	return !workflowRef || agent.workflowRef === workflowRef;
}

/** Project untrusted adapter records into a bounded, recovery-oriented status view. */
export function projectSubagentStatus(
	agentValues: readonly unknown[],
	messageValues: readonly unknown[],
	filters: SubagentStatusFilters = {},
): SubagentStatusPayload {
	const agents = agentValues.map(projectAgent).filter((agent): agent is ProjectedAgent => Boolean(agent));
	const byId = new Map(agents.map((agent) => [agent.id, agent]));
	const messages = messageValues.map((message) => projectMessage(message, byId)).filter((message): message is SubagentStatusMessage => Boolean(message));
	const openMessageCounts = new Map<string, number>();
	for (const message of messages) if (message.agentId) openMessageCounts.set(message.agentId, (openMessageCounts.get(message.agentId) ?? 0) + 1);
	for (const agent of agents) {
		const count = openMessageCounts.get(agent.id) ?? 0;
		if (count > 0) agent.openMessageCount = count;
		if (count > 0) agent.attention = true;
		agent.actionable = agent.actionable || count > 0;
	}

	const normalizedAgentId = text(filters.agentId, 160);
	const normalizedWorkflowRef = text(filters.workflowRef, 180);
	const normalizedState = text(filters.state, 64);
	const matchingAgents = agents.filter((agent) =>
		(!normalizedAgentId || agent.id === normalizedAgentId) &&
		(!normalizedWorkflowRef || matchesWorkflow(agent, normalizedWorkflowRef)) &&
		(!normalizedState || agent.state === normalizedState),
	);
	const includeSettled = filters.includeSettled === true;
	const visibleAgents = matchingAgents
		.filter((agent) => includeSettled || agent.actionable)
		.sort(includeSettled ? compareNewest : compareAgent);
	const matchingMessages = messages.filter((message) =>
		(!normalizedAgentId || message.agentId === normalizedAgentId) &&
		(!normalizedWorkflowRef || matchesWorkflow(message, normalizedWorkflowRef)) &&
		(!normalizedState || (message.agentId ? byId.get(message.agentId)?.state === normalizedState : false)),
	).sort(compareMessage);
	const limit = Math.min(MAX_SUBAGENT_STATUS_LIMIT, Math.max(1, Math.floor(filters.limit ?? DEFAULT_SUBAGENT_STATUS_LIMIT)));
	const selectedAgents = visibleAgents.slice(0, limit).map(({ actionable: _actionable, sortTime: _sortTime, ...agent }) => agent);
	const selectedMessages = matchingMessages.slice(0, limit);
	return {
		agents: selectedAgents,
		openMessages: selectedMessages,
		counts: {
			agents: matchingAgents.length,
			actionableAgents: matchingAgents.filter((agent) => agent.actionable).length,
			settledAgents: matchingAgents.filter((agent) => TERMINAL_AGENT_STATES.has(agent.state as never)).length,
			openMessages: matchingMessages.length,
			returnedAgents: selectedAgents.length,
			returnedOpenMessages: selectedMessages.length,
		},
		page: {
			limit,
			hasMoreAgents: visibleAgents.length > limit,
			hasMoreMessages: matchingMessages.length > limit,
		},
	};
}

export function subagentStatusEmptyText(payload: SubagentStatusPayload, filters: SubagentStatusFilters = {}): string {
	if (payload.agents.length > 0 || payload.openMessages.length > 0) return "";
	if (filters.includeSettled !== true && payload.counts.settledAgents > 0) return "No actionable subagents. Use includeSettled: true to inspect settled history.";
	if (filters.agentId || filters.workflowRef || filters.state) return "No subagents match the requested filters.";
	return "No subagents recorded.";
}
