import type { AgentProgress } from "./agent-progress.js";
import { isAgentProcessActive, type AgentState, type SessionAgentRecord, type WorkflowActivityDescriptor, type SessionAgentRegistry } from "./agent-registry.js";

/** Durable process facts projected from one logical agent's current attempt. */
export interface AgentLiveProjection {
	agentId: string;
	operationId: string;
	role: string;
	state: AgentState;
	presentation?: "foreground" | "background";
	workItemId?: string;
	taskId?: string;
	evaluationId?: string;
	attemptId?: string;
	attemptSequence?: number;
	attemptState?: "launching" | "running" | "exited" | "failed";
	activity?: WorkflowActivityDescriptor;
	provider: string;
	model: string;
	effort: string;
	fast?: boolean;
	startedAt: string;
	progress?: AgentProgress;
	active: boolean;
}

export type AgentLiveListener = (projection: AgentLiveProjection) => void;

export function agentLiveProcessStatus(projection: AgentLiveProjection): "starting" | "active" | undefined {
	if (!projection.active) return undefined;
	return projection.attemptState === "running" || Boolean(projection.progress?.processStartedAt) ? "active" : "starting";
}

export function projectAgentLive(agent: SessionAgentRecord): AgentLiveProjection {
	const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
	return {
		agentId: agent.id,
		operationId: agent.operationId,
		role: agent.role,
		state: agent.state,
		...(agent.presentation ? { presentation: agent.presentation } : {}),
		...(agent.workItemId ? { workItemId: agent.workItemId } : {}),
		...(agent.taskId ? { taskId: agent.taskId } : {}),
		...(agent.evaluationId ? { evaluationId: agent.evaluationId } : {}),
		...(attempt ? {
			attemptId: attempt.id,
			attemptSequence: attempt.sequence,
			attemptState: attempt.state,
			...(attempt.activity ? { activity: attempt.activity } : {}),
			provider: attempt.provider ?? agent.provider,
			model: attempt.model ?? agent.model,
			effort: attempt.effort ?? agent.effort,
			...(attempt.fast === true ? { fast: true } : {}),
			startedAt: attempt.startedAt,
			...(attempt.progress ? { progress: structuredClone(attempt.progress) } : {}),
		} : {
			provider: agent.provider,
			model: agent.model,
			effort: agent.effort,
			startedAt: agent.startedAt,
		}),
		active: isAgentProcessActive(agent),
	};
}

/**
 * One manager-owned, reload-safe feed for current-attempt process state.
 * Registry snapshots are durable before publication; the initial list closes
 * the attachment gap and makes a replacement UI converge without workflow reads.
 */
export class AgentLiveProjectionManager {
	constructor(readonly registry: SessionAgentRegistry) {}

	async list(): Promise<AgentLiveProjection[]> {
		return (await this.registry.list()).map(projectAgentLive);
	}

	async watch(listener: AgentLiveListener, signal?: AbortSignal): Promise<() => void> {
		const unsubscribe = await this.registry.watch((event) => {
			if (!event.data.agentId) return;
			void this.registry.get(event.data.agentId).then((agent) => listener(projectAgentLive(agent))).catch(() => undefined);
		}, signal);
		for (const projection of await this.list()) listener(projection);
		return unsubscribe;
	}
}
