import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HarnessError } from "./errors.js";
import { atomicWriteFile } from "./repository.js";

interface OperationRecord<T> {
	schemaVersion: 1;
	operationId: string;
	payloadDigest: string;
	completedAt: string;
	result: T;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class RepositoryMutex {
	readonly path: string;

	constructor(repositoryPrivateRoot: string) {
		this.path = join(repositoryPrivateRoot, "locks", "canonical");
	}

	async recoverStale(): Promise<boolean> {
		let owner: { pid?: number };
		try {
			owner = JSON.parse(await readFile(join(this.path, "owner"), "utf8")) as { pid?: number };
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
			return false;
		}
		if (owner.pid) {
			try {
				process.kill(owner.pid, 0);
				return false;
			} catch {
				// The recorded owner is dead; this lock is safe to reconcile.
			}
		}
		await rm(this.path, { recursive: true, force: true });
		return true;
	}

	async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		try {
			await mkdir(this.path);
			await atomicWriteFile(join(this.path, "owner"), `${JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 0o600);
		} catch {
			let currentOwner = "unknown";
			try {
				currentOwner = await readFile(join(this.path, "owner"), "utf8");
			} catch {
				// Preserve the lock and report it rather than guessing that it is stale.
			}
			throw new HarnessError("RESOURCE_LOCKED", `Canonical repository operation is locked by ${currentOwner.trim()}`);
		}
		try {
			return await operation();
		} finally {
			await rm(this.path, { recursive: true, force: true });
		}
	}
}

export class IdempotencyStore {
	readonly root: string;

	constructor(repositoryPrivateRoot: string) {
		this.root = join(repositoryPrivateRoot, "operations");
	}

	async execute<T>(operationId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(operationId)) {
			throw new HarnessError("INVALID_ARTIFACT", "operationId must be 8-128 safe characters");
		}
		const payloadDigest = digest(payload);
		const path = join(this.root, `${operationId}.json`);
		const lock = join(this.root, `${operationId}.lock`);
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const existing = await this.read<T>(path);
		if (existing) return this.resolve(existing, payloadDigest);
		try {
			await mkdir(lock);
		} catch {
			const raced = await this.waitFor<T>(path);
			if (raced) return this.resolve(raced, payloadDigest);
			throw new HarnessError("CAPABILITY_DENIED", `Operation is already in progress: ${operationId}`);
		}
		try {
			const afterLock = await this.read<T>(path);
			if (afterLock) return this.resolve(afterLock, payloadDigest);
			const result = await operation();
			const record: OperationRecord<T> = { schemaVersion: 1, operationId, payloadDigest, completedAt: new Date().toISOString(), result };
			await atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`, 0o600);
			return result;
		} finally {
			await rm(lock, { recursive: true, force: true });
		}
	}

	private async read<T>(path: string): Promise<OperationRecord<T> | undefined> {
		try {
			return JSON.parse(await readFile(path, "utf8")) as OperationRecord<T>;
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private resolve<T>(record: OperationRecord<T>, payloadDigest: string): T {
		if (record.payloadDigest !== payloadDigest) throw new HarnessError("CAPABILITY_DENIED", `operationId ${record.operationId} was already used with a different payload`);
		return record.result;
	}

	private async waitFor<T>(path: string): Promise<OperationRecord<T> | undefined> {
		for (let attempt = 0; attempt < 20; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			const record = await this.read<T>(path);
			if (record) return record;
		}
		return undefined;
	}
}
