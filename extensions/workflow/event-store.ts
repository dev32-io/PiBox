import { mkdir, open, readFile } from "node:fs/promises";
import { watch as watchFileSystem } from "node:fs";
import { basename, join } from "node:path";
import { stringify } from "yaml";
import { WorkflowMutex } from "../workflow-runtime/storage.js";
import { atomicWriteFile, type RepositoryIdentity } from "./repository.js";

export interface HarnessEvent<T = unknown> {
	sequence: number;
	at: string;
	type: string;
	data: T;
}

export type RepositoryEventListener = (event: HarnessEvent) => void;

/**
 * Repository-scoped durable event log.
 *
 * The file is the source of truth. Subscribers are only low-latency wake-up
 * hints and consumers must use readSince() to recover anything they missed.
 */
export class RepositoryEventStore {
	readonly identity: RepositoryIdentity;
	readonly eventsPath: string;
	readonly mutex: WorkflowMutex;
	#queue: Promise<void> = Promise.resolve();
	readonly #listeners = new Set<RepositoryEventListener>();

	constructor(identity: RepositoryIdentity) {
		this.identity = identity;
		this.eventsPath = join(identity.privateRoot, "events.jsonl");
		// Keep event sequencing independent from the agent registry and canonical
		// Git transaction locks while still serializing every repository writer.
		this.mutex = new WorkflowMutex(join(identity.privateRoot, "event-store"));
	}

	async initialize(): Promise<void> {
		await mkdir(this.identity.privateRoot, { recursive: true, mode: 0o700 });
		// Validate existing history before accepting another append. Corruption is a
		// recovery condition and must not be silently skipped or sequenced over.
		await this.readAll();
		await atomicWriteFile(
			join(this.identity.privateRoot, "repository.yaml"),
			stringify({ schemaVersion: 1, id: this.identity.id, root: this.identity.root }),
			0o600,
		);
	}

	subscribe(listener: RepositoryEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Cross-process low-latency hint. Consumers still replay from a cursor. */
	watch(listener: () => void, signal?: AbortSignal): () => void {
		if (signal?.aborted) return () => undefined;
		const target = basename(this.eventsPath);
		const watcher = watchFileSystem(this.identity.privateRoot, { persistent: false }, (_event, filename) => {
			if (!filename || filename.toString() === target) listener();
		});
		const close = () => watcher.close();
		signal?.addEventListener("abort", close, { once: true });
		return close;
	}

	append<T>(type: string, data: T): Promise<HarnessEvent<T>> {
		if (!type.trim()) return Promise.reject(new Error("Repository event type is required"));
		const operation = this.#queue.then(() => this.mutex.run(`event:${type}:${process.pid}`, async () => {
			const existing = await this.readAllFromDisk();
			// Legacy repositories may contain duplicate/out-of-order sequences from
			// the former process-local allocator. New writers advance from the maximum
			// observed value; the shared lock guarantees the new suffix is monotonic.
			const sequence = Math.max(0, ...existing.map((event) => event.sequence)) + 1;
			const event: HarnessEvent<T> = { sequence, at: new Date().toISOString(), type, data };
			await mkdir(this.identity.privateRoot, { recursive: true, mode: 0o700 });
			const handle = await open(this.eventsPath, "a", 0o600);
			try {
				await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			// Publication happens only after the event is fsynced. Listener failures
			// cannot invalidate a committed workflow fact.
			for (const listener of this.#listeners) {
				try { listener(event); } catch { /* wake-up observers are isolated */ }
			}
			return event;
		}));
		this.#queue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async readSince(sequence: number): Promise<HarnessEvent[]> {
		if (!Number.isInteger(sequence) || sequence < 0) throw new Error("Repository event cursor must be a non-negative integer");
		await this.#queue;
		// Readers share the writer lock so they never mistake a partially appended
		// line for durable-log corruption.
		return this.mutex.run(`event-read:${process.pid}`, async () =>
			(await this.readAllFromDisk()).filter((event) => event.sequence > sequence));
	}

	async readAll(): Promise<HarnessEvent[]> {
		return this.readSince(0);
	}

	async flush(): Promise<void> {
		await this.#queue;
	}

	private async readAllFromDisk(): Promise<HarnessEvent[]> {
		const content = await readFile(this.eventsPath, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
			throw error;
		});
		const events: HarnessEvent[] = [];
		for (const [index, line] of content.split("\n").entries()) {
			if (!line.trim()) continue;
			let event: HarnessEvent;
			try { event = JSON.parse(line) as HarnessEvent; }
			catch { throw new Error(`Malformed repository event log at line ${index + 1}: invalid JSON`); }
			if (!Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.at !== "string" || typeof event.type !== "string" || !event.type) {
				throw new Error(`Malformed repository event log at line ${index + 1}: invalid event envelope`);
			}
			events.push(event);
		}
		return events;
	}
}
