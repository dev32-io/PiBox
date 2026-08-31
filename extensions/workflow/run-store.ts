import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { RepositoryEventStore } from "./event-store.js";
import { atomicWriteFile, readTextIfExists, type RepositoryIdentity } from "./repository.js";
import type { E2ECaseResult } from "./types.js";
import { WorkflowMutex } from "../workflow-runtime/storage.js";
import { WorkflowControlStore, type WorkflowControlFence } from "../workflow-runtime/control-store.js";

export type RunState =
	| "launching"
	| "running"
	| "submitted"
	| "awaiting_ci"
	| "changes_requested"
	| "completed"
	| "waiting_model"
	| "waiting_capacity"
	| "interrupted"
	| "failed"
	| "protocol_failed"
	| "cancelled";

export interface RunRecord {
	schemaVersion: 1;
	id: string;
	repositoryId: string;
	workItemId?: string;
	taskId?: string;
	evaluationId?: string;
	role: string;
	attempt: number;
	state: RunState;
	workspace: string;
	baseCommit: string;
	/** Exact feature-diff base for whole-branch reviews; baseCommit remains the launch HEAD. */
	reviewBaseCommit?: string;
	planningRevision?: number;
	/** Workflow activation fence captured for managed evaluator capabilities. */
	workflowGeneration?: number;
	workflowExecutionFence?: number;
	workflowOwnerProcessInstanceId?: string;
	workflowOwnerActivationId?: string;
	credentialHash: string;
	/** Current workflow logical-agent process attempt authorized to mutate this run. */
	currentAgentAttemptId?: string | undefined;
	currentAgentGeneration?: number | undefined;
	credentialRevokedAt?: string | undefined;
	requestedModel?: string;
	resolvedProvider?: string;
	resolvedModel?: string;
	resolvedEffort?: string;
	startedAt: string;
	updatedAt: string;
	exitCode?: number;
	error?: string;
}

export interface EvaluationHandoff {
	schemaVersion: 1;
	type: "evaluation_complete";
	runId: string;
	evaluationId: string;
	verdict: "pass" | "fail" | "blocked" | "not_applicable";
	report: string;
	caseResults?: E2ECaseResult[];
	evidence: Array<{ command?: string; result: string; path?: string; description?: string }>;
	residualRisks?: string[];
	findings: Array<{
		id: string;
		severity: "low" | "medium" | "high" | "critical";
		status: "open" | "accepted" | "rejected" | "duplicate" | "deferred" | "resolved" | "needs_user";
		criterion?: string;
		location?: string;
		summary: string;
		blocking: boolean;
	}>;
	completedAt: string;
}

export interface TaskHandoff {
	schemaVersion: 1;
	type: "task_complete";
	runId: string;
	taskId: string;
	summary: string;
	commits: string[];
	checks: Array<{ command: string; result: "passed" | "failed" | "skipped"; output?: string }>;
	expectedFailures: string[];
	risks: string[];
	completedAt: string;
}

function hashCredential(credential: string): string {
	return createHash("sha256").update(credential).digest("hex");
}

export function runWorkflowControlFence(record: RunRecord): WorkflowControlFence | undefined {
	const hasFence = record.workflowGeneration !== undefined || record.workflowExecutionFence !== undefined
		|| record.workflowOwnerProcessInstanceId !== undefined || record.workflowOwnerActivationId !== undefined;
	if (!hasFence) return undefined;
	if (!record.workItemId || record.workflowGeneration === undefined || record.workflowExecutionFence === undefined
		|| !record.workflowOwnerProcessInstanceId || !record.workflowOwnerActivationId) {
		throw new HarnessError("CAPABILITY_DENIED", `Run ${record.id} has an incomplete workflow control fence`);
	}
	return {
		workflowRef: `work-item:${record.workItemId}`,
		generation: record.workflowGeneration,
		executionFence: record.workflowExecutionFence,
		ownerProcessInstanceId: record.workflowOwnerProcessInstanceId,
		ownerActivationId: record.workflowOwnerActivationId,
	};
}

function sameWorkflowFence(left: WorkflowControlFence, right: WorkflowControlFence): boolean {
	return left.workflowRef === right.workflowRef && left.generation === right.generation && left.executionFence === right.executionFence
		&& left.ownerProcessInstanceId === right.ownerProcessInstanceId && left.ownerActivationId === right.ownerActivationId;
}

export class HarnessRunStore {
	readonly repositoryPrivateRoot: string;
	readonly workItemPrivateRoot: string;
	readonly #events?: RepositoryEventStore;
	readonly #mutex: WorkflowMutex;

	constructor(repository: string | RepositoryIdentity, readonly workItemId: string) {
		const privateRoot = typeof repository === "string" ? repository : repository.privateRoot;
		this.repositoryPrivateRoot = privateRoot;
		this.workItemPrivateRoot = join(privateRoot, "work-items", workItemId);
		this.#mutex = new WorkflowMutex(join(this.workItemPrivateRoot, "run-store"));
		if (typeof repository !== "string") this.#events = new RepositoryEventStore(repository);
	}

	runRoot(runId: string): string {
		if (!/^[a-f0-9-]{36}$/.test(runId)) throw new HarnessError("CAPABILITY_DENIED", "Invalid run identity");
		return join(this.workItemPrivateRoot, "runs", runId);
	}

	async create(input: Omit<RunRecord, "schemaVersion" | "id" | "credentialHash" | "startedAt" | "updatedAt">): Promise<{ record: RunRecord; credential: string }> {
		const id = randomUUID();
		const credential = randomBytes(32).toString("base64url");
		const now = new Date().toISOString();
		const record: RunRecord = {
			schemaVersion: 1,
			id,
			...input,
			credentialHash: hashCredential(credential),
			startedAt: now,
			updatedAt: now,
		};
		const root = this.runRoot(id);
		await mkdir(join(root, "commands"), { recursive: true, mode: 0o700 });
		await atomicWriteFile(join(root, "run.yaml"), stringify(record), 0o600);
		await this.appendEvent(id, "run.created", { state: record.state });
		return { record, credential };
	}

	async list(): Promise<RunRecord[]> {
		const root = join(this.workItemPrivateRoot, "runs");
		const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
			throw error;
		});
		const records: RunRecord[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			try {
				records.push(await this.read(entry.name));
			} catch {
				// Recovery surfaces valid records and leaves corrupt directories untouched.
			}
		}
		return records.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
	}

	async recoverInterrupted(currentRunIds: ReadonlySet<string> = new Set()): Promise<RunRecord[]> {
		const recovered: RunRecord[] = [];
		for (const run of await this.list()) {
			if (!(["running", "launching", "submitted", "awaiting_ci"] as RunState[]).includes(run.state) || currentRunIds.has(run.id)) continue;
			// A handoff remains evidence, not process ownership. After activation loss
			// the mutation credential is always revoked and explicit resume starts a
			// fresh attempt from canonical Git/checkpoint state.
			recovered.push(await this.update(run.id, {
				state: "interrupted",
				currentAgentAttemptId: undefined,
				currentAgentGeneration: undefined,
				credentialRevokedAt: new Date().toISOString(),
				error: "No current-activation service process owns this run",
			}, "run.recovered_interrupted"));
		}
		return recovered;
	}

	async cancelUnfinished(reason = "Workflow stop requested"): Promise<RunRecord[]> {
		const cancelled: RunRecord[] = [];
		for (const run of await this.list()) {
			if (!["running", "launching", "submitted", "awaiting_ci"].includes(run.state)) continue;
			cancelled.push(await this.update(run.id, {
				state: "cancelled",
				currentAgentAttemptId: undefined,
				currentAgentGeneration: undefined,
				credentialRevokedAt: new Date().toISOString(),
				error: reason,
			}, "run.stop_requested"));
		}
		return cancelled;
	}

	async read(runId: string): Promise<RunRecord> {
		const content = await readTextIfExists(join(this.runRoot(runId), "run.yaml"));
		if (!content) throw new HarnessError("CAPABILITY_DENIED", "Run record does not exist");
		const parsed = parse(content) as RunRecord & { pid?: number };
		if (parsed.schemaVersion !== 1 || parsed.id !== runId) throw new HarnessError("CAPABILITY_DENIED", "Run record is invalid");
		// Compatibility reader: older runs duplicated the child PID even though
		// agents.yaml owns process-attempt summaries. Never project it forward.
		const { pid: _legacyPid, ...record } = parsed;
		if (["completed", "failed", "protocol_failed", "cancelled"].includes(record.state)) {
			await Promise.all(["events.jsonl", "transcript.jsonl"].map((name) => rm(join(this.runRoot(runId), name), { force: true }).catch(() => undefined)));
		}
		return record;
	}

	async authorize(runId: string, credential: string): Promise<RunRecord> {
		const record = await this.read(runId);
		const expected = Buffer.from(record.credentialHash, "hex");
		const actual = Buffer.from(hashCredential(credential), "hex");
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
			throw new HarnessError("CAPABILITY_DENIED", "Run credential is invalid");
		}
		return record;
	}

	async authorizeMutation(runId: string, credential: string, agentAttemptId: string, generation: number): Promise<RunRecord> {
		const record = await this.authorize(runId, credential);
		const workflowFence = runWorkflowControlFence(record);
		if (workflowFence) {
			await new WorkflowControlStore(this.repositoryPrivateRoot).assertActiveAttempt(workflowFence, { allowGenerationAdvance: true }).catch(() => {
				throw new HarnessError("CAPABILITY_DENIED", "Run credential belongs to a stopped or replaced workflow activation");
			});
		}
		if (!agentAttemptId || record.currentAgentAttemptId !== agentAttemptId || record.currentAgentGeneration !== generation) {
			throw new HarnessError("CAPABILITY_DENIED", "Run credential belongs to a stale workflow agent attempt");
		}
		if (record.credentialRevokedAt || (record.state !== "launching" && record.state !== "running")) {
			throw new HarnessError("CAPABILITY_DENIED", `Run mutation is revoked while the run is ${record.state}`);
		}
		return record;
	}

	async bindAgentAttempt(runId: string, attemptId: string, generation: number, expectedWorkflowFence?: WorkflowControlFence): Promise<RunRecord> {
		if (!attemptId || !Number.isInteger(generation) || generation < 1) throw new HarnessError("CAPABILITY_DENIED", "Invalid workflow agent attempt fence");
		const bind = (currentWorkflowGeneration = expectedWorkflowFence?.generation) => this.#mutex.run(`run-bind:${runId}:${attemptId}`, async () => {
			const current = await this.read(runId);
			const durableFence = runWorkflowControlFence(current);
			if ((durableFence && (!expectedWorkflowFence || !sameWorkflowFence(durableFence, expectedWorkflowFence))) || (!durableFence && expectedWorkflowFence)) {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} belongs to another workflow control fence`);
			}
			if (current.state !== "launching" && current.state !== "running") {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} cannot bind an agent attempt while ${current.state}`);
			}
			if (current.credentialRevokedAt) throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} has a revoked mutation credential`);
			const exactRebind = current.currentAgentAttemptId === attemptId && current.currentAgentGeneration === generation;
			if (expectedWorkflowFence && currentWorkflowGeneration !== expectedWorkflowFence.generation) {
				if (exactRebind) return current;
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} belongs to a stale prelaunch workflow generation`);
			}
			if (current.currentAgentAttemptId || current.currentAgentGeneration) {
				if (exactRebind) return current;
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} already has a current workflow agent attempt`);
			}
			return this.updateUnlocked(runId, current, { currentAgentAttemptId: attemptId, currentAgentGeneration: generation }, "run.agent_attempt_bound");
		});
		return expectedWorkflowFence
			? new WorkflowControlStore(this.repositoryPrivateRoot).runIfCurrent(expectedWorkflowFence, (current) => bind(current.generation), { allowGenerationAdvance: true })
			: bind();
	}

	/** Canonical work-item mutation is scheduler-owned and therefore running-only. */
	async assertCanonicalMutationAllowed(runId: string): Promise<RunRecord> {
		const current = await this.read(runId);
		const fence = runWorkflowControlFence(current);
		if (fence) await new WorkflowControlStore(this.repositoryPrivateRoot).assertFence(fence, { allowGenerationAdvance: true });
		return current;
	}

	async assertAgentAttemptLaunchable(runId: string, attemptId: string, generation: number, expectedWorkflowFence?: WorkflowControlFence): Promise<RunRecord> {
		const assertCurrent = () => this.#mutex.run(`run-launch-fence:${runId}:${attemptId}`, async () => {
			const current = await this.read(runId);
			const durableFence = runWorkflowControlFence(current);
			if ((durableFence && (!expectedWorkflowFence || !sameWorkflowFence(durableFence, expectedWorkflowFence))) || (!durableFence && expectedWorkflowFence)) {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} belongs to another workflow control fence`);
			}
			if ((current.state !== "launching" && current.state !== "running") || current.credentialRevokedAt
				|| current.currentAgentAttemptId !== attemptId || current.currentAgentGeneration !== generation) {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} agent attempt is no longer launchable`);
			}
			return current;
		});
		return expectedWorkflowFence
			? new WorkflowControlStore(this.repositoryPrivateRoot).runIfCurrent(expectedWorkflowFence, assertCurrent)
			: assertCurrent();
	}

	async releaseAgentAttempt(runId: string, attemptId: string, generation: number, expectedWorkflowFence?: WorkflowControlFence, options: { allowGenerationAdvance?: boolean } = {}, eventType = "run.agent_attempt_released"): Promise<RunRecord> {
		const release = () => this.#mutex.run(`run-release:${runId}:${attemptId}`, async () => {
			const current = await this.read(runId);
			const durableFence = runWorkflowControlFence(current);
			if ((durableFence && (!expectedWorkflowFence || !sameWorkflowFence(durableFence, expectedWorkflowFence))) || (!durableFence && expectedWorkflowFence)) {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} belongs to another workflow control fence`);
			}
			if (current.credentialRevokedAt || current.currentAgentAttemptId !== attemptId || current.currentAgentGeneration !== generation) {
				throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} cannot release a stale or revoked workflow agent attempt`);
			}
			if (current.state !== "launching" && current.state !== "running" && current.state !== "submitted") throw new HarnessError("CAPABILITY_DENIED", `Run ${runId} cannot release an agent attempt while ${current.state}`);
			return this.updateUnlocked(runId, current, { currentAgentAttemptId: undefined, currentAgentGeneration: undefined }, eventType);
		});
		return expectedWorkflowFence
			? new WorkflowControlStore(this.repositoryPrivateRoot).runIfActiveAttempt(expectedWorkflowFence, release, { allowGenerationAdvance: options.allowGenerationAdvance === true })
			: release();
	}

	async revokeAgentAttempt(runId: string, attemptId: string, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash" | "currentAgentAttemptId" | "currentAgentGeneration">> = {}, eventType = "run.agent_attempt_revoked"): Promise<{ revoked: boolean; record: RunRecord }> {
		return this.#mutex.run(`run-revoke:${runId}:${attemptId}`, async () => {
			const current = await this.read(runId);
			if (current.currentAgentAttemptId !== attemptId) return { revoked: false, record: current };
			const record = await this.updateUnlocked(runId, current, { ...update, currentAgentAttemptId: undefined, currentAgentGeneration: undefined, credentialRevokedAt: new Date().toISOString() }, eventType);
			return { revoked: true, record };
		});
	}

	async updateForAgentAttempt(runId: string, attemptId: string, generation: number, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash" | "currentAgentAttemptId" | "currentAgentGeneration">>, eventType: string, expectedWorkflowFence?: WorkflowControlFence): Promise<{ updated: boolean; record: RunRecord }> {
		const updateAttempt = () => this.#mutex.run(`run-attempt-update:${runId}:${attemptId}`, async () => {
			const current = await this.read(runId);
			if (current.currentAgentAttemptId !== attemptId || current.currentAgentGeneration !== generation || current.credentialRevokedAt) return { updated: false, record: current };
			return { updated: true, record: await this.updateUnlocked(runId, current, update, eventType) };
		});
		return expectedWorkflowFence
			? new WorkflowControlStore(this.repositoryPrivateRoot).runIfCurrent(expectedWorkflowFence, updateAttempt, { allowGenerationAdvance: true })
			: updateAttempt();
	}

	async update(runId: string, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash">>, eventType: string): Promise<RunRecord> {
		return this.#mutex.run(`run-update:${runId}:${eventType}`, async () => this.updateUnlocked(runId, await this.read(runId), update, eventType));
	}

	private async updateUnlocked(runId: string, current: RunRecord, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash">>, eventType: string): Promise<RunRecord> {
		const next: RunRecord = { ...current, ...update, updatedAt: new Date().toISOString() };
		await atomicWriteFile(join(this.runRoot(runId), "run.yaml"), stringify(next), 0o600);
		await this.appendEvent(runId, eventType, update);
		return next;
	}

	async appendEvent(runId: string, type: string, data: unknown): Promise<void> {
		if (!this.#events) return;
		await this.#events.append(type, { schemaVersion: 1, workItemId: this.workItemId, runId, data });
	}


	async writeCheckpoint(runId: string, checkpoint: unknown): Promise<void> {
		await atomicWriteFile(join(this.runRoot(runId), "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`, 0o600);
		await this.appendEvent(runId, "run.checkpoint", {});
	}

	async writeHandoff(runId: string, handoff: TaskHandoff): Promise<void> {
		await atomicWriteFile(join(this.runRoot(runId), "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, 0o600);
		await this.appendEvent(runId, "run.handoff", { type: handoff.type });
	}

	async writeAuthorizedHandoff(runId: string, credential: string, agentAttemptId: string, generation: number, handoff: TaskHandoff): Promise<void> {
		await this.runWithActiveAttemptFence(runId, () => this.#mutex.run(`run-task-handoff:${runId}`, async () => {
			await this.authorizeMutation(runId, credential, agentAttemptId, generation);
			await this.writeHandoff(runId, handoff);
		}));
	}

	async readHandoff(runId: string): Promise<TaskHandoff | undefined> {
		const content = await readTextIfExists(join(this.runRoot(runId), "handoff.json"));
		return content ? (JSON.parse(content) as TaskHandoff) : undefined;
	}

	async writeEvaluationHandoff(runId: string, handoff: EvaluationHandoff): Promise<void> {
		await atomicWriteFile(join(this.runRoot(runId), "evaluation-handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, 0o600);
		await this.appendEvent(runId, "run.evaluation_handoff", { verdict: handoff.verdict });
	}

	async writeAuthorizedEvaluationHandoff(runId: string, credential: string, agentAttemptId: string, generation: number, handoff: EvaluationHandoff): Promise<void> {
		await this.runWithActiveAttemptFence(runId, () => this.#mutex.run(`run-evaluation-handoff:${runId}`, async () => {
			await this.authorizeMutation(runId, credential, agentAttemptId, generation);
			await this.writeEvaluationHandoff(runId, handoff);
		}));
	}

	async updateAuthorized(runId: string, credential: string, agentAttemptId: string, generation: number, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash">>, eventType: string): Promise<RunRecord> {
		return this.runWithActiveAttemptFence(runId, () => this.#mutex.run(`run-authorized-update:${runId}:${eventType}`, async () => {
			const current = await this.authorizeMutation(runId, credential, agentAttemptId, generation);
			return this.updateUnlocked(runId, current, update, eventType);
		}));
	}

	private async runWithActiveAttemptFence<T>(runId: string, operation: () => Promise<T>): Promise<T> {
		const fence = runWorkflowControlFence(await this.read(runId));
		return fence
			? new WorkflowControlStore(this.repositoryPrivateRoot).runIfActiveAttempt(fence, operation, { allowGenerationAdvance: true })
			: operation();
	}

	async readEvaluationHandoff(runId: string): Promise<EvaluationHandoff | undefined> {
		const content = await readTextIfExists(join(this.runRoot(runId), "evaluation-handoff.json"));
		return content ? (JSON.parse(content) as EvaluationHandoff) : undefined;
	}
}
