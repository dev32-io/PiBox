import { createHash } from "node:crypto";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile, readTextIfExists, WorkflowMutex, WorkflowRuntimeError } from "./storage.js";

export type WorkflowExecutionMode = "running" | "paused" | "stopped" | "completed";
export type WorkflowControlCommand = "start" | "pause" | "resume" | "stop" | "complete" | "detach" | "attach";

export interface WorkflowControlRecord {
	schemaVersion: 1;
	workflowRef: string;
	mode: WorkflowExecutionMode;
	generation: number;
	ownerSessionId?: string;
	lastOperationId: string;
	lastCommand: WorkflowControlCommand;
	updatedAt: string;
}

export interface WorkflowControlInput {
	workflowRef: string;
	command: WorkflowControlCommand;
	sessionId: string;
	operationId: string;
}

/** Durable execution ownership and fencing for one repository's workflows. */
export class WorkflowControlStore {
	readonly root: string;

	constructor(repositoryPrivateRoot: string) {
		this.root = join(repositoryPrivateRoot, "workflow-control");
	}

	async get(workflowRef: string): Promise<WorkflowControlRecord | undefined> {
		const content = await readTextIfExists(this.path(workflowRef));
		return content ? this.validate(parse(content), workflowRef) : undefined;
	}

	async list(): Promise<WorkflowControlRecord[]> {
		const { readdir } = await import("node:fs/promises");
		const records: WorkflowControlRecord[] = [];
		for (const entry of await readdir(this.root).catch(() => [])) {
			if (!entry.endsWith(".yaml")) continue;
			const content = await readTextIfExists(join(this.root, entry));
			if (content) records.push(this.validate(parse(content)));
		}
		return records.sort((left, right) => left.workflowRef.localeCompare(right.workflowRef));
	}

	async apply(input: WorkflowControlInput): Promise<WorkflowControlRecord> {
		this.validateInput(input);
		const mutex = this.mutex(input.workflowRef);
		return mutex.run(`workflow-control:${input.command}:${input.operationId}`, async () => {
			const current = await this.get(input.workflowRef);
			if (current?.lastOperationId === input.operationId) {
				if (current.lastCommand !== input.command) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Workflow operation ${input.operationId} was replayed with another command`);
				return current;
			}
			this.assertOwnership(current, input);
			const generation = (current?.generation ?? 0) + 1;
			const mode: WorkflowExecutionMode = input.command === "pause" ? "paused"
				: input.command === "stop" ? "stopped"
					: input.command === "complete" ? "completed"
						: input.command === "detach" || input.command === "attach" ? current!.mode
							: "running";
			const detached = input.command === "detach";
			const record: WorkflowControlRecord = {
				schemaVersion: 1,
				workflowRef: input.workflowRef,
				mode,
				generation,
				...(!detached ? { ownerSessionId: input.sessionId } : {}),
				lastOperationId: input.operationId,
				lastCommand: input.command,
				updatedAt: new Date().toISOString(),
			};
			await atomicWriteFile(this.path(input.workflowRef), stringify(record), 0o600);
			return record;
		});
	}

	async assertCurrent(workflowRef: string, sessionId: string, generation: number): Promise<WorkflowControlRecord> {
		const current = await this.get(workflowRef);
		if (!current || current.mode !== "running" || current.ownerSessionId !== sessionId || current.generation !== generation) {
			throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Stale workflow ownership for ${workflowRef}`);
		}
		return current;
	}

	private assertOwnership(current: WorkflowControlRecord | undefined, input: WorkflowControlInput): void {
		if (!current) {
			// One-time migration for workflows whose running/paused state predates
			// durable control records. The first explicit command establishes fence 1.
			if (!["start", "resume", "pause", "stop"].includes(input.command)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Workflow ${input.workflowRef} must be started before ${input.command}`);
			return;
		}
		if (input.command === "attach") {
			if (!["running", "paused"].includes(current.mode) || (current.ownerSessionId && current.ownerSessionId !== input.sessionId)) throw new WorkflowRuntimeError("RESOURCE_LOCKED", `Workflow ${input.workflowRef} is owned by ${current.ownerSessionId ?? "a terminal state"}`);
			return;
		}
		if (input.command === "start") {
			if (current.mode === "running") throw new WorkflowRuntimeError("RESOURCE_LOCKED", `Workflow ${input.workflowRef} is already running`);
			return;
		}
		if (current.ownerSessionId && current.ownerSessionId !== input.sessionId) throw new WorkflowRuntimeError("RESOURCE_LOCKED", `Workflow ${input.workflowRef} is owned by ${current.ownerSessionId}`);
		if (input.command === "resume" && current.mode !== "running" && current.mode !== "paused" && current.mode !== "stopped") throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Workflow ${input.workflowRef} cannot resume from ${current.mode}`);
		if (input.command === "pause" && current.mode !== "running") throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Workflow ${input.workflowRef} cannot pause from ${current.mode}`);
		if (input.command === "detach" && current.mode !== "running" && current.mode !== "paused") throw new WorkflowRuntimeError("CAPABILITY_DENIED", `Workflow ${input.workflowRef} cannot detach from ${current.mode}`);
	}

	private validateInput(input: WorkflowControlInput): void {
		if (!input.workflowRef || !input.sessionId || !input.operationId || /[\u0000-\u001f\u007f]/.test(input.operationId)) throw new WorkflowRuntimeError("CAPABILITY_DENIED", "Workflow control input is invalid");
	}

	private validate(value: unknown, expectedRef?: string): WorkflowControlRecord {
		const record = value as Partial<WorkflowControlRecord>;
		if (record.schemaVersion !== 1 || typeof record.workflowRef !== "string" || (expectedRef && record.workflowRef !== expectedRef) || !["running", "paused", "stopped", "completed"].includes(record.mode ?? "") || !Number.isInteger(record.generation) || (record.generation ?? 0) < 1 || typeof record.lastOperationId !== "string" || typeof record.lastCommand !== "string" || typeof record.updatedAt !== "string") {
			throw new WorkflowRuntimeError("INVALID_ARTIFACT", `Invalid workflow control record${expectedRef ? ` for ${expectedRef}` : ""}`);
		}
		return record as WorkflowControlRecord;
	}

	private key(workflowRef: string): string {
		return createHash("sha256").update(workflowRef).digest("hex");
	}

	private path(workflowRef: string): string {
		return join(this.root, `${this.key(workflowRef)}.yaml`);
	}

	private mutex(workflowRef: string): WorkflowMutex {
		return new WorkflowMutex(join(this.root, `${this.key(workflowRef)}.lock-root`));
	}
}
