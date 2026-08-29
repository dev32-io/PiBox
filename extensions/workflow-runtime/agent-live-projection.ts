import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { initialAgentProgress, markAgentProcessStarted, projectAgentProgress, type AgentProgress } from "./agent-progress.js";
import { isAgentProcessActive, type AgentState, type SessionAgentRecord, type WorkflowActivityDescriptor, type SessionAgentRegistry } from "./agent-registry.js";
import { observeJsonl, type JsonlObserver } from "./direct-agent.js";

interface LiveProgressUpdate {
	registryRoot: string;
	agentId: string;
	attemptId: string;
	progress: AgentProgress;
	source: "launcher" | "fallback";
}

interface CachedLiveProgress extends Omit<LiveProgressUpdate, "registryRoot" | "agentId" | "source"> {
	/** Fallback observer ownership; launcher-published progress is ownerless and authoritative. */
	owner?: string;
	ownerGeneration?: number;
}

interface LiveProgressBus {
	current: Map<string, CachedLiveProgress>;
	listeners: Set<(update: LiveProgressUpdate) => void>;
	nextFallbackGeneration: number;
}

const LIVE_PROGRESS_KEY = Symbol.for("pibox:agent-live-progress:v1");
type LiveProgressGlobal = typeof globalThis & { [LIVE_PROGRESS_KEY]?: LiveProgressBus };

function liveProgressBus(): LiveProgressBus {
	const root = globalThis as LiveProgressGlobal;
	const bus = (root[LIVE_PROGRESS_KEY] ??= { current: new Map(), listeners: new Set(), nextFallbackGeneration: 0 });
	// /reload preserves the Symbol-backed bus across module revisions.
	bus.nextFallbackGeneration ??= 0;
	return bus;
}

function liveProgressKey(registryRoot: string, agentId: string): string {
	return `${registryRoot}\0${agentId}`;
}

function cachedLiveProgressEntry(registryRoot: string, agentId: string, attemptId: string | undefined): CachedLiveProgress | undefined {
	if (!attemptId) return undefined;
	const cached = liveProgressBus().current.get(liveProgressKey(registryRoot, agentId));
	return cached?.attemptId === attemptId ? cached : undefined;
}

function cachedLiveProgress(registryRoot: string, agentId: string, attemptId: string | undefined): AgentProgress | undefined {
	const cached = cachedLiveProgressEntry(registryRoot, agentId, attemptId);
	return cached ? structuredClone(cached.progress) : undefined;
}

function publishLiveProgress(registryRoot: string, agentId: string, attemptId: string, progress: AgentProgress, fallback?: { owner: string; generation: number }): void {
	const update: LiveProgressUpdate = { registryRoot, agentId, attemptId, progress: structuredClone(progress), source: fallback ? "fallback" : "launcher" };
	const bus = liveProgressBus();
	const key = liveProgressKey(registryRoot, agentId);
	const existing = bus.current.get(key);
	if (fallback && existing?.attemptId === attemptId) {
		// The launcher is the single stream owner. Among reload fallback observers,
		// the newest manager wins and older observers become inert.
		if (!existing.owner || (existing.ownerGeneration ?? 0) > fallback.generation) return;
	}
	bus.current.set(key, { attemptId, progress: update.progress, ...(fallback ? { owner: fallback.owner, ownerGeneration: fallback.generation } : {}) });
	for (const listener of bus.listeners) {
		try { listener(update); } catch { /* presentation observers never affect workers */ }
	}
}

/** Publish volatile process activity without mutating the durable agent registry. */
export function publishAgentLiveProgress(registryRoot: string, agentId: string, attemptId: string, progress: AgentProgress): void {
	publishLiveProgress(registryRoot, agentId, attemptId, progress);
}

/** Drop only the matching attempt/source so a stale manager cannot erase a newer publisher. */
export function clearAgentLiveProgress(registryRoot: string, agentId: string, attemptId?: string, owner?: string): void {
	const key = liveProgressKey(registryRoot, agentId);
	const cached = liveProgressBus().current.get(key);
	if (!cached || (attemptId && cached.attemptId !== attemptId) || (owner && cached.owner !== owner)) return;
	liveProgressBus().current.delete(key);
}

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

export function projectAgentLive(agent: SessionAgentRecord, liveProgress?: AgentProgress): AgentLiveProjection {
	const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
	const progress = liveProgress ?? attempt?.progress;
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
			...(progress ? { progress: structuredClone(progress) } : {}),
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

	private project(agent: SessionAgentRecord): AgentLiveProjection {
		const progress = isAgentProcessActive(agent)
			? cachedLiveProgress(this.registry.root, agent.id, agent.currentAttemptId)
			: undefined;
		return projectAgentLive(agent, progress);
	}

	async list(): Promise<AgentLiveProjection[]> {
		return (await this.registry.list()).map((agent) => this.project(agent));
	}

	async watch(listener: AgentLiveListener, signal?: AbortSignal): Promise<() => void> {
		let closed = false;
		let unsubscribeRegistry: () => void = () => undefined;
		const bus = liveProgressBus();
		const fallbackOwner = randomUUID();
		const fallbackGeneration = ++bus.nextFallbackGeneration;
		const fallbackObservers = new Map<string, JsonlObserver>();
		const fallbackAttempts = new Map<string, { agentId: string; attemptId: string }>();
		const releaseFallback = (key: string, observer?: JsonlObserver) => {
			const owned = fallbackAttempts.get(key);
			fallbackAttempts.delete(key);
			fallbackObservers.delete(key);
			if (owned) clearAgentLiveProgress(this.registry.root, owned.agentId, owned.attemptId, fallbackOwner);
			if (observer) void observer.close();
		};
		const closeFallbacks = (agentId: string, currentAttemptId?: string) => {
			for (const [key, owned] of fallbackAttempts) {
				if (owned.agentId !== agentId || owned.attemptId === currentAttemptId) continue;
				releaseFallback(key, fallbackObservers.get(key));
			}
		};
		const attachFallback = async (agent: SessionAgentRecord) => {
			const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
			if (closed || !attempt || !isAgentProcessActive(agent)) return;
			const cached = cachedLiveProgressEntry(this.registry.root, agent.id, attempt.id);
			if (cached && !cached.owner) return;
			const key = `${agent.id}\0${attempt.id}`;
			if (fallbackAttempts.has(key)) return;
			fallbackAttempts.set(key, { agentId: agent.id, attemptId: attempt.id });
			let progress = initialAgentProgress(attempt.startedAt);
			if (attempt.state === "running" || attempt.pid) progress = markAgentProcessStarted(progress, attempt.timing?.processSpawnedAt ?? attempt.updatedAt);
			publishLiveProgress(this.registry.root, agent.id, attempt.id, progress, { owner: fallbackOwner, generation: fallbackGeneration });
			try {
				const observer = await observeJsonl(join(this.registry.root, "agents", agent.id, "attempts", attempt.id, "stdout.jsonl"), (event) => {
					if (closed || !fallbackAttempts.has(key)) return;
					const next = projectAgentProgress(progress, event);
					if (next === progress) return;
					progress = next;
					publishLiveProgress(this.registry.root, agent.id, attempt.id, progress, { owner: fallbackOwner, generation: fallbackGeneration });
				});
				if (closed || !fallbackAttempts.has(key)) void observer.close();
				else fallbackObservers.set(key, observer);
			} catch {
				releaseFallback(key);
				// A launching attempt retries attachment after agent.running.
			}
		};
		const emit = async (agentId: string) => {
			if (closed) return;
			const agent = await this.registry.get(agentId);
			if (closed) return;
			const active = isAgentProcessActive(agent);
			closeFallbacks(agent.id, active ? agent.currentAttemptId : undefined);
			if (!active) clearAgentLiveProgress(this.registry.root, agent.id, agent.currentAttemptId);
			listener(this.project(agent));
			await attachFallback(agent);
		};
		const onLiveProgress = (update: LiveProgressUpdate) => {
			if (closed || update.registryRoot !== this.registry.root) return;
			if (update.source === "launcher") {
				const key = `${update.agentId}\0${update.attemptId}`;
				if (fallbackAttempts.has(key)) releaseFallback(key, fallbackObservers.get(key));
			}
			void emit(update.agentId).catch(() => undefined);
		};
		const dispose = () => {
			if (closed) return;
			closed = true;
			bus.listeners.delete(onLiveProgress);
			unsubscribeRegistry();
			for (const [key, owned] of [...fallbackAttempts]) releaseFallback(key, fallbackObservers.get(key));
		};
		bus.listeners.add(onLiveProgress);
		if (signal) {
			if (signal.aborted) dispose();
			else signal.addEventListener("abort", dispose, { once: true });
		}
		try {
			unsubscribeRegistry = await this.registry.watch((event) => {
				if (event.data.agentId) void emit(event.data.agentId).catch(() => undefined);
			}, signal);
			for (const agent of await this.registry.list()) {
				if (closed) break;
				const active = isAgentProcessActive(agent);
				if (!active) clearAgentLiveProgress(this.registry.root, agent.id, agent.currentAttemptId);
				listener(this.project(agent));
				await attachFallback(agent);
			}
			return dispose;
		} catch (error) {
			dispose();
			throw error;
		}
	}
}
