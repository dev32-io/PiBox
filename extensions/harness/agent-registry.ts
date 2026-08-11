import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { RepositoryMutex } from "./idempotency.js";
import { atomicWriteFile, readTextIfExists } from "./repository.js";

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

const TRANSITIONS: Record<AgentState, ReadonlySet<AgentState>> = {
	reserved: new Set(["launching", "waiting_model", "waiting_capacity", "failed", "cancelled"]),
	launching: new Set(["running", "waiting_model", "waiting_capacity", "interrupted", "failed", "cancelled"]),
	running: new Set(["waiting_decision", "blocked", "paused", "interrupted", "recovery_required", "reported", "failed", "protocol_failed", "cancelled"]),
	waiting_model: new Set(["launching", "cancelled", "failed"]),
	waiting_capacity: new Set(["launching", "cancelled", "failed"]),
	waiting_decision: new Set(["launching", "cancelled", "failed"]),
	blocked: new Set(["launching", "cancelled", "failed"]),
	paused: new Set(["launching", "cancelled", "failed"]),
	interrupted: new Set(["launching", "recovery_required", "reported", "cancelled", "failed"]),
	recovery_required: new Set(["launching", "reported", "cancelled", "failed"]),
	reported: new Set(["launching", "blocked", "interrupted", "completed", "protocol_failed", "failed", "cancelled"]),
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

export interface ProcessAttempt {
	id: string;
	sequence: number;
	state: "launching" | "running" | "exited" | "failed";
	pid?: number;
	startedAt: string;
	updatedAt: string;
	exitedAt?: string;
	exitCode?: number;
}

export interface SessionAgentRecord extends AgentScope {
	schemaVersion: 1;
	id: string;
	sessionId: string;
	parentAgentId: string;
	depth: number;
	role: string;
	state: AgentState;
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

export interface ReserveAgentInput extends AgentScope {
	operationId: string;
	parentAgentId: string;
	parentDepth: number;
	role: string;
	provider: string;
	model: string;
	effort: string;
	assignment: unknown;
}

export class SessionAgentRegistry {
	readonly root: string;
	readonly snapshotPath: string;
	readonly eventsPath: string;
	readonly mutex: RepositoryMutex;

	constructor(
		repositoryPrivateRoot: string,
		readonly sessionId: string,
		readonly maxActiveAgents = 16,
		readonly maxSubagentDepth = 1,
	) {
		if (!sessionId || /[\\/\0]/.test(sessionId)) throw new HarnessError("CAPABILITY_DENIED", "Invalid main session identity");
		this.root = join(repositoryPrivateRoot, "sessions", sessionId);
		this.snapshotPath = join(this.root, "agents.yaml");
		this.eventsPath = join(this.root, "agent-events.jsonl");
		this.mutex = new RepositoryMutex(this.root);
	}

	async initialize(mainAgentId = `main:${this.sessionId}`): Promise<void> {
		await this.mutex.run("agent-registry:init", async () => {
			if (await readTextIfExists(this.snapshotPath)) return;
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
		});
	}

	async reserve(input: ReserveAgentInput): Promise<SessionAgentRecord> {
		return this.mutex.run(`agent-registry:reserve:${input.operationId}`, async () => {
			const snapshot = await this.read();
			if (!input.operationId || input.operationId.length > 512 || /[\u0000-\u001f\u007f]/.test(input.operationId)) throw new HarnessError("INVALID_ARTIFACT", "Agent operation ID is invalid");
			const assignmentDigest = createHash("sha256").update(JSON.stringify(input.assignment)).digest("hex");
			const replay = snapshot.agents.find((agent) => agent.operationId === input.operationId);
			if (replay) {
				if (replay.assignmentDigest !== assignmentDigest) throw new HarnessError("CAPABILITY_DENIED", `Agent operation ${input.operationId} was replayed with a different assignment`);
				return replay;
			}
			const depth = input.parentDepth + 1;
			if (depth > snapshot.maxSubagentDepth) throw new HarnessError("CAPABILITY_DENIED", `SUBAGENT_DEPTH_EXCEEDED: depth ${depth} exceeds ${snapshot.maxSubagentDepth}`);
			const active = snapshot.agents.filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state)).length;
			if (active >= snapshot.maxActiveAgents) throw new HarnessError("RESOURCE_LOCKED", `SUBAGENT_LIMIT_REACHED: ${active} of ${snapshot.maxActiveAgents} logical agents are active`);
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
			if (TERMINAL_AGENT_STATES.has(agent.state)) throw new HarnessError("CAPABILITY_DENIED", "Cannot bind a terminal agent to another run");
			if (scope.workItemId !== undefined) agent.workItemId = scope.workItemId;
			if (scope.taskId !== undefined) agent.taskId = scope.taskId;
			if (scope.evaluationId !== undefined) agent.evaluationId = scope.evaluationId;
			if (scope.runId !== undefined) agent.runId = scope.runId;
			if (scope.workspace !== undefined) agent.workspace = scope.workspace;
		})).agent;
	}

	async startAttempt(agentId: string): Promise<{ agent: SessionAgentRecord; attempt: ProcessAttempt }> {
		return this.mutate(agentId, "agent.attempt_started", (agent) => {
			if (!TRANSITIONS[agent.state].has("launching")) throw this.invalidTransition(agent.state, "launching");
			const now = new Date().toISOString();
			const attempt: ProcessAttempt = { id: randomUUID(), sequence: agent.attempts.length + 1, state: "launching", startedAt: now, updatedAt: now };
			agent.state = "launching";
			agent.currentAttemptId = attempt.id;
			agent.attempts.push(attempt);
			return attempt;
		}).then(({ agent, value }) => ({ agent, attempt: value }));
	}

	async markRunning(agentId: string, attemptId: string, pid: number): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.running", (agent) => {
			if (agent.state !== "launching") throw this.invalidTransition(agent.state, "running");
			const attempt = this.attempt(agent, attemptId);
			attempt.state = "running";
			attempt.pid = pid;
			attempt.updatedAt = new Date().toISOString();
			agent.state = "running";
		})).agent;
	}

	async transition(agentId: string, state: AgentState, update: Pick<SessionAgentRecord, "summary" | "error"> = {}): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, `agent.${state}`, (agent) => {
			if (!TRANSITIONS[agent.state].has(state)) throw this.invalidTransition(agent.state, state);
			agent.state = state;
			if (update.summary !== undefined) agent.summary = update.summary;
			if (update.error !== undefined) agent.error = update.error;
			if (TERMINAL_AGENT_STATES.has(state)) agent.completedAt = new Date().toISOString();
		})).agent;
	}

	async recordExit(agentId: string, attemptId: string, exitCode: number): Promise<SessionAgentRecord> {
		return (await this.mutate(agentId, "agent.process_exited", (agent) => {
			const attempt = this.attempt(agent, attemptId);
			attempt.state = exitCode === 0 ? "exited" : "failed";
			attempt.exitCode = exitCode;
			attempt.exitedAt = new Date().toISOString();
			attempt.updatedAt = attempt.exitedAt;
		})).agent;
	}

	async recordMessage(agentId: string, input: Omit<AgentMessageRecord, "schemaVersion" | "id" | "payloadDigest" | "agentId" | "status" | "createdAt" | "updatedAt">): Promise<AgentMessageRecord> {
		return this.mutex.run(`agent-message:${agentId}:${randomUUID()}`, async () => {
			const snapshot = await this.read();
			const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
			if (!agent) throw new HarnessError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			if (TERMINAL_AGENT_STATES.has(agent.state)) throw new HarnessError("CAPABILITY_DENIED", "Terminal agents cannot create messages");
			if (!input.operationId) throw new HarnessError("INVALID_ARTIFACT", "Agent message operation ID is required");
			const payloadDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
			const messageRoot = join(this.root, "agents", agentId, "messages");
			for (const entry of await readdir(messageRoot).catch(() => [])) {
				const content = await readTextIfExists(join(messageRoot, entry));
				if (!content) continue;
				const existing = JSON.parse(content) as AgentMessageRecord;
				if (existing.operationId === input.operationId) {
					if (existing.payloadDigest !== payloadDigest) throw new HarnessError("CAPABILITY_DENIED", `Agent message operation ${input.operationId} was replayed with a different payload`);
					return existing;
				}
			}
			const now = new Date().toISOString();
			const message: AgentMessageRecord = { schemaVersion: 1, id: randomUUID(), payloadDigest, agentId, status: "open", createdAt: now, updatedAt: now, ...input };
			if (input.blocking) {
				const target: AgentState = input.type === "change_request" ? "waiting_decision" : "blocked";
				if (!TRANSITIONS[agent.state].has(target)) throw this.invalidTransition(agent.state, target);
				agent.state = target;
				agent.summary = input.summary;
				agent.updatedAt = now;
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
			if (!agent) throw new HarnessError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			const path = join(this.root, "agents", agentId, "messages", `${messageId}.json`);
			const content = await readTextIfExists(path);
			if (!content) throw new HarnessError("CAPABILITY_DENIED", `Unknown agent message: ${messageId}`);
			const message = JSON.parse(content) as AgentMessageRecord;
			if (message.status !== "open") throw new HarnessError("CAPABILITY_DENIED", `Agent message ${messageId} is already ${message.status}`);
			message.status = "answered";
			message.response = response;
			message.updatedAt = new Date().toISOString();
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
		if (!agent) throw new HarnessError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
		return structuredClone(agent);
	}

	async activeCount(): Promise<number> {
		return (await this.read()).agents.filter((agent) => !TERMINAL_AGENT_STATES.has(agent.state)).length;
	}

	private async mutate<T>(agentId: string, event: string, mutation: (agent: SessionAgentRecord) => T): Promise<{ agent: SessionAgentRecord; value: T }> {
		return this.mutex.run(`${event}:${agentId}`, async () => {
			const snapshot = await this.read();
			const agent = snapshot.agents.find((candidate) => candidate.id === agentId);
			if (!agent) throw new HarnessError("CAPABILITY_DENIED", `Unknown session agent: ${agentId}`);
			const value = mutation(agent);
			agent.updatedAt = new Date().toISOString();
			await this.commit(snapshot, event, { agentId, state: agent.state });
			return { agent: structuredClone(agent), value };
		});
	}

	private attempt(agent: SessionAgentRecord, attemptId: string): ProcessAttempt {
		const attempt = agent.attempts.find((candidate) => candidate.id === attemptId);
		if (!attempt || agent.currentAttemptId !== attemptId) throw new HarnessError("CAPABILITY_DENIED", `Unknown current process attempt: ${attemptId}`);
		return attempt;
	}

	private invalidTransition(from: AgentState, to: AgentState): HarnessError {
		return new HarnessError("CAPABILITY_DENIED", `Invalid agent transition: ${from} -> ${to}`);
	}

	private async read(): Promise<RegistrySnapshot> {
		const content = await readTextIfExists(this.snapshotPath);
		if (!content) throw new HarnessError("CAPABILITY_DENIED", `Session agent registry is not initialized: ${this.sessionId}`);
		const snapshot = parse(content) as RegistrySnapshot;
		if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== this.sessionId || !Array.isArray(snapshot.agents)) throw new HarnessError("CAPABILITY_DENIED", "Session agent registry is invalid");
		return snapshot;
	}

	private async write(snapshot: RegistrySnapshot): Promise<void> {
		await atomicWriteFile(this.snapshotPath, stringify(snapshot), 0o600);
	}

	private async commit(snapshot: RegistrySnapshot, type: string, data: unknown): Promise<void> {
		snapshot.revision += 1;
		snapshot.eventSequence += 1;
		await this.write(snapshot);
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		await appendFile(this.eventsPath, `${JSON.stringify({ sequence: snapshot.eventSequence, at: new Date().toISOString(), type, data })}\n`, { mode: 0o600 });
	}
}
