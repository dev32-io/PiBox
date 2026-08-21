import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile, readTextIfExists, WorkflowMutex, WorkflowRuntimeError } from "./storage.js";
import type { AgentProgress } from "./agent-progress.js";

export type AgentState =
	| "reserved"
	| "launching"
	| "running"
	| "waiting_model"
	| "waiting_capacity"
	| "waiting_decision"
	| "blocked"
	| "paused"
	| "interrupted"
	| "recovery_required"
	| "reported"
	| "completed"
	| "failed"
	| "protocol_failed"
	| "cancelled";

export const TERMINAL_AGENT_STATES = new Set<AgentState>(["completed", "failed", "protocol_failed", "cancelled"]);
const RETRYABLE_AGENT_STATES = new Set<AgentState>(["failed", "protocol_failed", "reported", "recovery_required"]);

/** Detached-worker liveness is recovery fencing, not live telemetry. */
export const AGENT_HEARTBEAT_INTERVAL_MS = 30_000;
export const AGENT_HEARTBEAT_FRESH_MS = 90_000;

export function isAgentProcessActive(agent: SessionAgentRecord): boolean {
	if (agent.state === "reserved") return true;
	if (agent.state !== "launching" && agent.state !== "running") return false;
	const attempt = agent.attempts.find((candidate) => candidate.id === agent.currentAttemptId);
	return attempt?.state === "launching" || attempt?.state === "running";
}

const TRANSITIONS: Record<AgentState, ReadonlySet<AgentState>> = {
	reserved: new Set(["launching", "waiting_model", "waiting_capacity", "failed", "cancelled"]),
	launching: new Set(["running", "waiting_model", "waiting_capacity", "interrupted", "failed", "cancelled"]),
	running: new Set(["waiting_model", "waiting_capacity", "waiting_decision", "blocked", "paused", "interrupted", "recovery_required", "reported", "failed", "protocol_failed", "cancelled"]),
	waiting_model: new Set(["launching", "cancelled", "failed"]),
	waiting_capacity: new Set(["launching", "cancelled", "failed"]),
	waiting_decision: new Set(["launching", "cancelled", "failed"]),
	blocked: new Set(["launching", "cancelled", "failed"]),
	paused: new Set(["launching", "cancelled", "failed"]),
	interrupted: new Set(["launching", "recovery_required", "reported", "cancelled", "failed"]),
	recovery_required: new Set(["launching", "reported", "cancelled", "failed"]),
	reported: new Set(["launching", "waiting_model", "waiting_capacity", "blocked", "interrupted", "completed", "protocol_failed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	protocol_failed: new Set(),
	cancelled: new Set(),
};

export interface AgentScope {
	workItemId?: string;
	taskId?: string;
	evaluationId?: string;
	runId?: string;
	workspace?: string;
}

export type WorkflowActivityDescriptor = {
	kind: "review" | "repair";
	generation: number;
};

export interface ProcessAttemptTiming {
	/** Logical reservation/eligibility boundary for this process attempt. */
	reservedAt?: string;
	attemptStartedAt: string;
	processSpawnedAt?: string;
	childReadyAt?: string;
	firstActivityAt?: string;
	firstToolAt?: string;
	lastActivityAt?: string;
	reportReadyAt?: string;
	processExitedAt?: string;
	outputDrainedAt?: string;
	settledAt?: string;
}

export interface ProcessAttempt {
	id: string;
	provider?: string;
	model?: string;
	effort?: string;
	/** Effective Fast-mode request policy for this resolved process route. */
	fast?: boolean;
	sequence: number;
	activity?: WorkflowActivityDescriptor;
	state: "launching" | "running" | "exited" | "failed";
	pid?: number;
	startedAt: string;
	updatedAt: string;
	exitedAt?: string;
	exitCode?: number;
	/** One bounded terminal summary; live tool/turn activity is not durably sampled. */
	progress?: AgentProgress;
	/** Detailed lifecycle boundaries persisted with attempt settlement. */
	timing?: ProcessAttemptTiming;
}

export interface SessionAgentRecord extends AgentScope {
	schemaVersion: 1;
	id: string;
	sessionId: string;
	parentAgentId: string;
	depth: number;
	role: string;
	state: AgentState;
	/** Original dynamic-spawn presentation. Managed workflow agents omit this. */
	presentation?: "foreground" | "background";
	provider: string;
	model: string;
	effort: string;
	operationId: string;
	assignmentDigest: string;
	assignmentPath: string;
	currentAttemptId?: string;
	attempts: ProcessAttempt[];
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	summary?: string;
	error?: string;
}

interface RegistrySnapshot {
	schemaVersion: 1;
	sessionId: string;
	mainAgentId: string;
	revision: number;
	eventSequence: number;
	maxActiveAgents: number;
	maxSubagentDepth: number;
	agents: SessionAgentRecord[];
}

export interface AgentMessageRecord {
	schemaVersion: 1;
	id: string;
	operationId: string;
	payloadDigest: string;
	agentId: string;
	type: "decision_report" | "change_request" | "blocked";
	status: "open" | "answered" | "closed";
	blocking: boolean;
	summary: string;
	rationale: string;
	evidence: Array<{ source: string; observation: string }>;
	options?: string[];
	recommendation?: string;
	response?: string;
	createdAt: string;
	updatedAt: string;
}

export interface AgentRegistryEvent {
	type: string;
	at: string;
	sequence: number;
	data: { agentId?: string; state?: AgentState; [key: string]: unknown };
}

export type AgentRegistryListener = (event: AgentRegistryEvent) => void;

export interface ReserveAgentInput extends AgentScope {
	operationId: string;
	parentAgentId: string;
	parentDepth: number;
	role: string;
	presentation?: "foreground" | "background";
	provider: string;
	model: string;
	effort: string;
	assignment: unknown;
}

export class SessionAgentRegistry {
	readonly root: string;
	readonly snapshotPath: string;
	/** Legacy journal location retained only for migration/tests; new sessions do not create it. */
	readonly eventsPath: string;
	readonly mutex: WorkflowMutex;
	private readonly listeners = new Set<AgentRegistryListener>();

	constructor(
		repositoryPrivateRoot: string,
		readonly sessionId: string,
		readonly maxActiveAgents = 16,
		readonly maxSubagentDepth = 1,
	) {
		if (!sessionId || /[\\/\0]/.test(sessionId)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", "Invalid main session identity");
		this.root = join(repositoryPrivateRoot, "sessions", sessionId);
		this.snapshotPath = join(this.root, "agents.yaml");
		this.eventsPath = join(this.root, "agent-events.jsonl");
		this.mutex = new WorkflowMutex(this.root);
	}

	subscribe(listener: AgentRegistryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Cross-instance lifecycle subscription. The durable registry snapshot is
	 * authoritative; atomic snapshot replacement is the wake-up signal. No
	 * second agent journal is needed for recovery or replay. */
	async watch(listener: AgentRegistryListener, signal?: AbortSignal): Promise<() => void> {
		let previous = await this.read();
		let cursor = previous.eventSequence;
		let closed = false;
		let replaying = false;
		let replayAgain = false;
		const accept = (event: AgentRegistryEvent) => {
			if (closed || event.sequence <= cursor) return;
			cursor = event.sequence;
			listener(event);
		};
		const unsubscribeLocal = this.subscribe(accept);
		const replay = async () => {
			if (replaying) { replayAgain = true; return; }
			replaying = true;
			try {
				do {
					replayAgain = false;
					const current = await this.read();
					if (current.eventSequence > cursor) {
						const prior = new Map(previous.agents.map((agent) => [agent.id, `${agent.updatedAt}:${agent.state}:${agent.currentAttemptId ?? ""}`]));
						const changed = current.agents.filter((agent) => prior.get(agent.id) !== `${agent.updatedAt}:${agent.state}:${agent.currentAttemptId ?? ""}`);
						if (changed.length === 0) accept({ type: "agent.snapshot_changed", at: new Date().toISOString(), sequence: current.eventSequence, data: {} });
						else for (const agent of changed) {
							if (current.eventSequence <= cursor) cursor = current.eventSequence - 1;
							accept({ type: "agent.snapshot_changed", at: agent.updatedAt, sequence: current.eventSequence, data: { agentId: agent.id, state: agent.state } });
						}
					}
					previous = current;
				} while (replayAgain && !closed);
			} finally { replaying = false; }
		};
		const watcher = watch(this.root, { persistent: false }, (_event, filename) => {
			if (!closed && filename?.toString() === "agents.yaml") void replay().catch(() => undefined);
		});
		watcher.on("error", () => { /* replacement sessions load the authoritative snapshot */ });
		// Close the read→subscribe attachment gap after both wake-up paths exist.
		await replay();
		const dispose = () => { if (closed) return; closed = true; unsubscribeLocal(); watcher.close(); };
		if (signal) {
			if (signal.aborted) dispose();
			else signal.addEventListener("abort", dispose, { once: true });
		}
		return dispose;
	}

	async initialize(mainAgentId = `main:${this.sessionId}`): Promise<void> {
		await this.mutex.run("agent-registry:init", async () => {
			if (await readTextIfExists(this.snapshotPath)) {
				await rm(this.eventsPath, { force: true }).catch(() => undefined);
				return;
			}
			const snapshot: RegistrySnapshot = {
				schemaVersion: 1,
				sessionId: this.sessionId,
				mainAgentId,
				revision: 0,
				eventSequence: 0,
				maxActiveAgents: this.maxActiveAgents,
				maxSubagentDepth: this.maxSubagentDepth,
				agents: [],
			};
			await this.write(snapshot);
			await rm(this.eventsPath, { force: true }).catch(() => undefined);
		});
	}

	async reserve(input: ReserveAgentInput): Promise<SessionAgentRecord> {
		return this.mutex.run(`agent-registry:reserve:${input.operationId}`, async () => {
			const snapshot = await this.read();
			if (!input.operationId || input.operationId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.operationId)) throw new WorkflowRuntimeError("INVALID_ARTIFACT", "Agent operation ID is invalid");
			const assignmentDigest = createHash("sha256").update(JSON.stringify(input.assignment)).digest("hex");
			const replay = snapshot.agents.find((agent) => agent.operationId === input.operationId);
			if (replay) {
				if (replay.assignmentDigest !== assignmentDigest) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Agent operation ${input.operationId} was replayed with a different assignment`);
				return replay;
			}
			const depth = input.parentDepth + 1;
			if (depth > snapshot.maxSubagentDepth) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `SUBAGENT_DEPTH_EXCEEDED: depth ${depth} exceeds ${snapshot.maxSubagentDepth}`);
			const active = snapshot.agents.filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state)).length;
			if (active >= snapshot.maxActiveAgents) throw new WorkflowRuntimeError("RESOURCE_LOCKED", `SUBAGENT_LIMIT_REACHED: ${active} of ${snapshot.maxActiveAgents} logical agents are active`);
			const id = randomUUID();
			const now = new Date().toISOString();
			const assignmentKey = createHash("sha256").update(input.operationId).digest("hex");
			const assignmentPath = join("agents", id, "assignments", `${assignmentKey}.json`);
			const agent: SessionAgentRecord = {
				schemaVersion: 1,
				id,
				sessionId: snapshot.sessionId,
				parentAgentId: input.parentAgentId,
				depth,
				role: input.role,
				state: "reserved",
				...(input.presentation ? { presentation: input.presentation } : {}),
				operationId: input.operationId,
				assignmentDigest,
				provider: input.provider,
				model: input.model,
				effort: input.effort,
				assignmentPath,
				attempts: [],
				startedAt: now,
				updatedAt: now,
				...(input.workItemId ? { workItemId: input.workItemId } : {}),
				...(input.taskId ? { taskId: input.taskId } : {}),
				...(input.evaluationId ? { evaluationId: input.evaluationId } : {}),
				...(input.runId ? { runId: input.runId } : {}),
				...(input.workspace ? { workspace: input.workspace } : {}),
			};
			await atomicWriteFile(join(this.root, assignmentPath), `${JSON.stringify(input.assignment, null, 2)}\n`, 0o600);
			snapshot.agents.push(agent);
			await this.commit(snapshot, "agent.reserved", { agentId: id, role: agent.role, depth });
			return agent;
		});
	}

	async bindScope(agentId: string, scope: AgentScope): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.scope_bound", (agent) => {
			if (TERMINAL_AGENT_STATES.has(agent.state)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", "Cannot bind a terminal agent to another run");
			if (scope.workItemId !== undefined) agent.workItemId = scope.workItemId;
			if (scope.taskId !== undefined) agent.taskId = scope.taskId;
			if (scope.evaluationId !== undefined) agent.evaluationId = scope.evaluationId;
			if (scope.runId !== undefined) agent.runId = scope.runId;
			if (scope.workspace !== undefined) agent.workspace = scope.workspace;
		})).agent;
	}

	async startAttempt(agentId: string, route?: { provider: string; model: string; effort: string }, activity?: WorkflowActivityDescriptor, fast?: boolean): Promise<{ agent: SessionAgentRecord; attempt: ProcessAttempt }> {
		return this.mutate(agentId, "agent.attempt_started", (agent) => {
			if (!TRANSITIONS[agent.state].has("launching")) throw this.invalidTransition(agent.state, "launching");
			const now = new Date().toISOString();
			const attempt: ProcessAttempt = {
				id: randomUUID(), sequence: agent.attempts.length + 1, state: "launching", startedAt: now, updatedAt: now,
				timing: { reservedAt: agent.updatedAt, attemptStartedAt: now },
				...(route ?? {}), ...(activity ? { activity } : {}), ...(fast !== undefined ? { fast } : {}),
			};
			if (route) { agent.provider = route.provider; agent.model = route.model; agent.effort = route.effort; }
			agent.state = "launching";
			agent.currentAttemptId = attempt.id;
			agent.attempts.push(attempt);
			return attempt;
		}).then(({ agent, value }) => ({ agent, attempt: value }));
	}

	async markRunning(agentId: string, attemptId: string, pid: number, observedAt = new Date().toISOString()): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.running", (agent) => {
			if (agent.state !== "launching") throw this.invalidTransition(agent.state, "running");
			const attempt = this.attempt(agent, attemptId);
			attempt.state = "running";
			attempt.pid = pid;
			attempt.updatedAt = observedAt;
			attempt.timing = { ...(attempt.timing ?? { attemptStartedAt: attempt.startedAt }), processSpawnedAt: observedAt };
			agent.state = "running";
		})).agent;
	}

	async prepareRetry(agentId: string): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.retry_prepared", (agent) => {
			if (!RETRYABLE_AGENT_STATES.has(agent.state)) throw this.invalidTransition(agent.state, "reserved");
			agent.state = "reserved";
			delete agent.error;
			delete agent.summary;
		})).agent;
	}

	async transition(agentId: string, state: AgentState, update: Pick<SessionAgentRecord, "summary" | "error"> = {}): Promise<SessionAgentRecord> {
		const result = (await this.mutate(agentId, `agent.${state}`, (agent) => {
			if (!TRANSITIONS[agent.state].has(state)) throw this.invalidTransition(agent.state, state);
			agent.state = state;
			if (update.summary !== undefined) agent.summary = update.summary;
			if (update.error !== undefined) agent.error = update.error;
			if (TERMINAL_AGENT_STATES.has(state)) agent.completedAt = new Date().toISOString();
		})).agent;
		if (state === "completed") await this.cleanupSuccessfulAttemptTransport(result);
		return result;
	}

	/** Compatibility checkpoint for explicit callers. LaunchCoordinator persists one
	 * terminal summary instead; progress checkpoints never append journal events. */
	async updateProgress(agentId: string, attemptId: string, progress: AgentProgress): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.progress", (agent) => {
			const attempt = this.attempt(agent, attemptId);
			attempt.progress = structuredClone(progress);
			attempt.updatedAt = progress.lastEventAt;
		}, false)).agent;
	}

	async recordExit(
		agentId: string,
		attemptId: string,
		exitCode: number,
		summary?: { progress?: AgentProgress; timing?: ProcessAttemptTiming },
	): Promise<SessionAgentRecord> {
		const result = (await this.mutate(agentId, "agent.process_exited", (agent) => {
			const attempt = this.attempt(agent, attemptId);
			const now = new Date().toISOString();
			attempt.state = exitCode === 0 ? "exited" : "failed";
			attempt.exitCode = exitCode;
			attempt.exitedAt = summary?.timing?.processExitedAt ?? now;
			attempt.updatedAt = summary?.timing?.settledAt ?? now;
			if (summary?.progress) attempt.progress = structuredClone(summary.progress);
			if (summary?.timing) attempt.timing = structuredClone(summary.timing);
		})).agent;
		if (exitCode !== 0) await this.boundFailedAttemptTransport(result, attemptId);
		return result;
	}

	async recordMessage(agentId: string, input: Omit<AgentMessageRecord, "schemaVersion" | "id" | "payloadDigest" | "agentId" | "status" | "createdAt" | "updatedAt">): Promise<AgentMessageRecord> {
		return this.mutex.run(`agent-message:${agentId}:${randomUUID()}`, async () => {
			const snapshot = await this.read();
			const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
			if (!agent) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			if (TERMINAL_AGENT_STATES.has(agent.state)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", "Terminal agents cannot create messages");
			if (!input.operationId) throw new WorkflowRuntimeError("INVALID_ARTIFACT", "Agent message operation ID is required");
			const payloadDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const messageRoot = join(this.root, "agents", agentId, "messages");
			for (const entry of await readdir(messageRoot).catch(() => [])) {
				const content = await readTextIfExists(join(messageRoot, entry));
				if (!content) continue;
				const existing = JSON.parse(content) as AgentMessageRecord;
				if (existing.operationId === input.operationId) {
					if (existing.payloadDigest !== payloadDigest) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Agent message operation ${input.operationId} was replayed with a different payload`);
					return existing;
				}
			}
			const now = new Date().toISOString();
			const message: AgentMessageRecord = { schemaVersion: 1, id: randomUUID(), payloadDigest, agentId, status: "open", createdAt: now, updatedAt: now, ...input };
			agent.updatedAt = now;
			if (input.blocking) {
				const target: AgentState = input.type === "change_request" ? "waiting_decision" : "blocked";
				if (!TRANSITIONS[agent.state].has(target)) throw this.invalidTransition(agent.state, target);
				agent.state = target;
				agent.summary = input.summary;
			}
			await atomicWriteFile(join(this.root, "agents", agentId, "messages", `${message.id}.json`), `${JSON.stringify(message, null, 2)}\n`, 0o600);
			await this.commit(snapshot, `agent.message_${input.type}`, { agentId, messageId: message.id, blocking: input.blocking });
			return message;
		});
	}

	async respondMessage(agentId: string, messageId: string, response: string): Promise<AgentMessageRecord> {
		return this.mutex.run(`agent-message-response:${messageId}`, async () => {
			const snapshot = await this.read();
			const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
			if (!agent) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			const path = join(this.root, "agents", agentId, "messages", `${messageId}.json`);
			const content = await readTextIfExists(path);
			if (!content) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown agent message: ${messageId}`);
			const message = JSON.parse(content) as AgentMessageRecord;
			if (message.status === "answered" && message.response === response) return message;
			if (message.status !== "open") throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Agent message ${messageId} is already ${message.status}`);
			message.status = "answered";
			message.response = response;
			message.updatedAt = new Date().toISOString();
			agent.updatedAt = message.updatedAt;
			await atomicWriteFile(path, `${JSON.stringify(message, null, 2)}\n`, 0o600);
			await this.commit(snapshot, "agent.message_answered", { agentId, messageId });
			return message;
		});
	}

	async listMessages(agentId?: string): Promise<AgentMessageRecord[]> {
		const agents = agentId ? [await this.get(agentId)] : await this.list();
		const messages: AgentMessageRecord[] = [];
		for (const agent of agents) {
			const root = join(this.root, "agents", agent.id, "messages");
			for (const entry of await readdir(root).catch(() => [])) {
				if (!entry.endsWith(".json")) continue;
				const content = await readTextIfExists(join(root, entry));
				if (content) messages.push(JSON.parse(content) as AgentMessageRecord);
			}
		}
		return messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	async list(): Promise<SessionAgentRecord[]> {
		return structuredClone((await this.read()).agents);
	}

	async get(agentId: string): Promise<SessionAgentRecord> {
		const agent = (await this.read()).agents.find((candidate) => candidate.id === agentId);
		if (!agent) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
		return structuredClone(agent);
	}

	async activeCount(): Promise<number> {
		return (await this.read()).agents.filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state)).length;
	}

	/** Remove raw process transport after the workflow has a durable final outcome.
	 * Pi sessions, handoffs, attempt summaries, and deterministic evidence remain. */
	async cleanupWorkItemTransport(workItemId: string): Promise<void> {
		const agents = (await this.read()).agents.filter((agent) => agent.workItemId === workItemId && TERMINAL_AGENT_STATES.has(agent.state));
		for (const agent of agents) for (const attempt of agent.attempts) {
			if (attempt.state !== "exited" && attempt.state !== "failed") continue;
			const root = this.attemptRoot(agent.id, attempt.id);
			await Promise.all(["stdout.jsonl", "stderr.log"].map((name) => rm(join(root, name), { force: true }).catch(() => undefined)));
		}
	}

	private async mutate<T>(agentId: string, event: string, mutation: (agent: SessionAgentRecord) => T, journal = true): Promise<{ agent: SessionAgentRecord; value: T }> {
		return this.mutex.run(`${event}:${agentId}`, async () => {
			const snapshot = await this.read();
			const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
			if (!agent) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			const value = mutation(agent);
			agent.updatedAt = new Date().toISOString();
			if (journal) await this.commit(snapshot, event, { agentId, state: agent.state });
			else { snapshot.revision += 1; await this.write(snapshot); }
			return { agent: structuredClone(agent), value };
		});
	}

	private attempt(agent: SessionAgentRecord, attemptId: string): ProcessAttempt {
		const attempt = agent.attempts.find((candidate) => candidate.id === attemptId);
		if (!attempt || agent.currentAttemptId !== attemptId) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Unknown current process attempt: ${attemptId}`);
		return attempt;
	}

	private invalidTransition(from: AgentState, to: AgentState): WorkflowRuntimeError {
		return new WorkflowRuntimeError("CAPABILITY_DENIED", `Invalid agent transition: ${from} -> ${to}`);
	}

	private attemptRoot(agentId: string, attemptId: string): string {
		return join(this.root, "agents", agentId, "attempts", attemptId);
	}

	private async cleanupSuccessfulAttemptTransport(agent: SessionAgentRecord): Promise<void> {
		for (const attempt of agent.attempts) {
			if (attempt.exitCode !== 0) continue;
			const root = this.attemptRoot(agent.id, attempt.id);
			await Promise.all(["stdout.jsonl", "stderr.log"].map((name) => rm(join(root, name), { force: true }).catch(() => undefined)));
		}
	}

	private async boundFailedAttemptTransport(agent: SessionAgentRecord, attemptId: string): Promise<void> {
		const maximum = 64 * 1024;
		for (const name of ["stdout.jsonl", "stderr.log"]) {
			const path = join(this.attemptRoot(agent.id, attemptId), name);
			const size = (await stat(path).catch(() => undefined))?.size ?? 0;
			if (size <= maximum) continue;
			const file = await open(path, "r");
			try {
				const buffer = Buffer.alloc(maximum);
				await file.read(buffer, 0, maximum, size - maximum);
				await writeFile(path, buffer, { mode: 0o600 });
			} finally { await file.close(); }
		}
	}

	private async read(): Promise<RegistrySnapshot> {
		const content = await readTextIfExists(this.snapshotPath);
		if (!content) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Session agent registry is not initialized: ${this.sessionId}`);
		const snapshot = parse(content) as RegistrySnapshot;
		if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== this.sessionId || !Array.isArray(snapshot.agents)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", "Session agent registry is invalid");
		return snapshot;
	}

	private async write(snapshot: RegistrySnapshot): Promise<void> {
		await atomicWriteFile(this.snapshotPath, stringify(snapshot), 0o600);
	}

	private async commit(snapshot: RegistrySnapshot, type: string, data: unknown): Promise<void> {
		snapshot.revision += 1;
		snapshot.eventSequence += 1;
		await this.write(snapshot);
		const at = new Date().toISOString();
		const event: AgentRegistryEvent = { sequence: snapshot.eventSequence, at, type, data: data as AgentRegistryEvent["data"] };
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* observers must not affect durable lifecycle transitions */ }
		}
	}
}
