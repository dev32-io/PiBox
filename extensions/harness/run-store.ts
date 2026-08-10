import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { HarnessError } from "./errors.js";
import { atomicWriteFile, readTextIfExists } from "./repository.js";

export type RunState =
	| "launching"
	| "running"
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
	planningRevision?: number;
	credentialHash: string;
	requestedModel?: string;
	resolvedProvider?: string;
	resolvedModel?: string;
	resolvedEffort?: string;
	pid?: number;
	startedAt: string;
	updatedAt: string;
	exitCode?: number;
	error?: string;
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

export class HarnessRunStore {
	readonly workItemPrivateRoot: string;

	constructor(repositoryPrivateRoot: string, workItemId: string) {
		this.workItemPrivateRoot = join(repositoryPrivateRoot, "work-items", workItemId);
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
		await appendFile(join(root, "events.jsonl"), `${JSON.stringify({ sequence: 1, at: now, type: "run.created", data: { state: record.state } })}\n`, { mode: 0o600 });
		return { record, credential };
	}

	async read(runId: string): Promise<RunRecord> {
		const content = await readTextIfExists(join(this.runRoot(runId), "run.yaml"));
		if (!content) throw new HarnessError("CAPABILITY_DENIED", "Run record does not exist");
		const record = parse(content) as RunRecord;
		if (record.schemaVersion !== 1 || record.id !== runId) throw new HarnessError("CAPABILITY_DENIED", "Run record is invalid");
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

	async update(runId: string, update: Partial<Omit<RunRecord, "schemaVersion" | "id" | "credentialHash">>, eventType: string): Promise<RunRecord> {
		const current = await this.read(runId);
		const next: RunRecord = { ...current, ...update, updatedAt: new Date().toISOString() };
		await atomicWriteFile(join(this.runRoot(runId), "run.yaml"), stringify(next), 0o600);
		await this.appendEvent(runId, eventType, update);
		return next;
	}

	async appendEvent(runId: string, type: string, data: unknown): Promise<void> {
		const path = join(this.runRoot(runId), "events.jsonl");
		const content = await readFile(path, "utf8").catch(() => "");
		const sequence = content.split("\n").filter(Boolean).length + 1;
		await appendFile(path, `${JSON.stringify({ sequence, at: new Date().toISOString(), type, data })}\n`, { mode: 0o600 });
	}

	async appendTranscript(runId: string, event: unknown): Promise<void> {
		await appendFile(join(this.runRoot(runId), "transcript.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });
	}

	async writeCheckpoint(runId: string, checkpoint: unknown): Promise<void> {
		await atomicWriteFile(join(this.runRoot(runId), "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`, 0o600);
		await this.appendEvent(runId, "run.checkpoint", {});
	}

	async writeHandoff(runId: string, handoff: TaskHandoff): Promise<void> {
		await atomicWriteFile(join(this.runRoot(runId), "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, 0o600);
		await this.appendEvent(runId, "run.handoff", { type: handoff.type });
	}

	async readHandoff(runId: string): Promise<TaskHandoff | undefined> {
		const content = await readTextIfExists(join(this.runRoot(runId), "handoff.json"));
		return content ? (JSON.parse(content) as TaskHandoff) : undefined;
	}
}
