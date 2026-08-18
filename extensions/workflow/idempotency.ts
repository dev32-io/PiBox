import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

const activeTransactions = new AsyncLocalStorage<Set<string>>();

export class RepositoryMutex {
	readonly path: string;
	readonly waitTimeoutMs: number;
	#tail: Promise<void> = Promise.resolve();

	constructor(repositoryPrivateRoot: string, waitTimeoutMs = 30_000) {
		// A repository-local .pibox is intentionally untracked; placing the lock in
		// it would make clean-state validation race with the lock receipt itself.
		// All canonical callers use this one common-Git-directory location. The
		// fallback keeps the small standalone mutex API useful in unit tests.
		// Repository callers pass the discovered Git common directory (or the
		// explicit .pibox root used by standalone mutex tests). Never derive the
		// identity from a repository basename: linked worktrees share this path.
		this.path = join(resolve(repositoryPrivateRoot), "locks", "canonical");
		this.waitTimeoutMs = waitTimeoutMs;
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
		// Higher-level resource transactions and store methods intentionally share one
		// coordinator. Re-entry is safe within one async transaction and avoids the
		// deadlock that separate API layers would otherwise create.
		const inherited = activeTransactions.getStore();
		if (inherited?.has(this.path)) return operation();
		const previous = this.#tail;
		let releaseQueue!: () => void;
		this.#tail = new Promise<void>((resolve) => (releaseQueue = resolve));
		await previous;
		try {
			await this.acquire(owner);
			try {
				const scope = new Set(inherited ?? []); scope.add(this.path);
				return await activeTransactions.run(scope, operation);
			} finally {
				await rm(this.path, { recursive: true, force: true });
			}
		} finally {
			releaseQueue();
		}
	}

	private async acquire(owner: string): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + this.waitTimeoutMs;
		while (true) {
			try {
				await mkdir(this.path);
				try {
					await atomicWriteFile(join(this.path, "owner"), `${JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, 0o600);
					return;
				} catch (error) {
					await rm(this.path, { recursive: true, force: true });
					throw error;
				}
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			}
			if (await this.recoverStale()) continue;
			if (Date.now() >= deadline) {
				let currentOwner = "unknown";
				try {
					currentOwner = await readFile(join(this.path, "owner"), "utf8");
				} catch {
					// The owner may still be writing its receipt; timeout remains fail-closed.
				}
				throw new HarnessError("RESOURCE_LOCKED", `Timed out waiting for canonical repository operation held by ${currentOwner.trim()}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

export class IdempotencyStore {
	readonly root: string;

	constructor(repositoryPrivateRoot: string) {
		this.root = join(repositoryPrivateRoot, "operations");
	}

	async execute<T>(operationId: string, payload: unknown, operation: () => Promise<T>): Promise<T> {
		if (!operationId || operationId.length > 512 || /[\u0000-\u001f\u007f]/.test(operationId)) {
			throw new HarnessError("INVALID_ARTIFACT", "operationId must be a non-empty value of at most 512 characters without control bytes");
		}
		const payloadDigest = digest(payload);
		const storageKey = createHash("sha256").update(operationId).digest("hex");
		const path = join(this.root, `${storageKey}.json`);
		const lock = join(this.root, `${storageKey}.lock`);
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
