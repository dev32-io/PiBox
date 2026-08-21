import { mkdir, open, readFile, stat } from "node:fs/promises";
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

interface EventHead { schemaVersion: 1; sequence: number; bytes: number }

const MAX_EVENT_BYTES = 256 * 1024;

/**
 * Repository-scoped durable event log.
 *
 * The file is the source of truth. Subscribers are only low-latency wake-up
 * hints and consumers must use readSince() to recover anything they missed.
 */
export class RepositoryEventStore {
	readonly identity: RepositoryIdentity;
	readonly eventsPath: string;
	readonly headPath: string;
	readonly mutex: WorkflowMutex;
	#queue: Promise<void> = Promise.resolve();
	#cachedEvents: HarnessEvent[] | undefined;
	#cachedBytes = 0;
	readonly #listeners = new Set<RepositoryEventListener>();

	constructor(identity: RepositoryIdentity) {
		this.identity = identity;
		this.eventsPath = join(identity.privateRoot, "events.jsonl");
		this.headPath = join(identity.privateRoot, "events-head.json");
		// Keep event sequencing independent from the agent registry and canonical
		// Git transaction locks while still serializing every repository writer.
		this.mutex = new WorkflowMutex(join(identity.privateRoot, "event-store"));
	}

	async initialize(): Promise<void> {
		await mkdir(this.identity.privateRoot, { recursive: true, mode: 0o700 });
		// Validate existing history before accepting another append. Corruption is a
		// recovery condition and must not be silently skipped or sequenced over.
		await this.readAll();
		await this.mutex.run(`event-head-init:${process.pid}`, async () => {
			const events = await this.readIncrementalFromDisk();
			const bytes = (await stat(this.eventsPath).catch(() => undefined))?.size ?? 0;
			const sequence = Math.max(0, ...events.map((event) => event.sequence));
			await atomicWriteFile(this.headPath, `${JSON.stringify({ schemaVersion: 1, sequence, bytes })}\n`, 0o600);
		});
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
			const bytesBefore = (await stat(this.eventsPath).catch(() => undefined))?.size ?? 0;
			const head = await readFile(this.headPath, "utf8").then((content) => JSON.parse(content) as EventHead).catch(() => undefined);
			let maximum: number;
			if (head?.schemaVersion === 1 && Number.isInteger(head.sequence) && head.sequence >= 0 && head.bytes === bytesBefore) maximum = head.sequence;
			else {
				// Missing/stale heads occur only for legacy history or an interrupted
				// append. Repair once from validated history, then return to O(1) appends.
				maximum = Math.max(0, ...(await this.readIncrementalFromDisk()).map((event) => event.sequence));
			}
			const sequence = maximum + 1;
			const event: HarnessEvent<T> = { sequence, at: new Date().toISOString(), type, data };
			const line = `${JSON.stringify(event)}\n`;
			const lineBytes = Buffer.byteLength(line);
			if (lineBytes > MAX_EVENT_BYTES) throw new Error(`Repository event exceeds ${MAX_EVENT_BYTES} bytes; store large evidence as an artifact and reference it`);
			await mkdir(this.identity.privateRoot, { recursive: true, mode: 0o700 });
			const handle = await open(this.eventsPath, "a", 0o600);
			try {
				await handle.writeFile(line, "utf8");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await atomicWriteFile(this.headPath, `${JSON.stringify({ schemaVersion: 1, sequence, bytes: bytesBefore + lineBytes })}\n`, 0o600);
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
			(await this.readIncrementalFromDisk()).filter((event) => event.sequence > sequence));
	}

	async readAll(): Promise<HarnessEvent[]> {
		return this.readSince(0);
	}

	async flush(): Promise<void> {
		await this.#queue;
	}


	private parseLines(content: string, lineOffset = 0): HarnessEvent[] {
		const events: HarnessEvent[] = [];
		for (const [index, line] of content.split("\n").entries()) {
			if (!line.trim()) continue;
			let event: HarnessEvent;
			try { event = JSON.parse(line) as HarnessEvent; }
			catch { throw new Error(`Malformed repository event log at line ${lineOffset + index + 1}: invalid JSON`); }
			if (!Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.at !== "string" || typeof event.type !== "string" || !event.type) {
				throw new Error(`Malformed repository event log at line ${lineOffset + index + 1}: invalid event envelope`);
			}
			events.push(event);
		}
		return events;
	}

	private async readIncrementalFromDisk(): Promise<HarnessEvent[]> {
		const size = (await stat(this.eventsPath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}))?.size ?? 0;
		if (!this.#cachedEvents || size < this.#cachedBytes) {
			const content = await readFile(this.eventsPath, "utf8").catch(() => "");
			this.#cachedEvents = this.parseLines(content);
			this.#cachedBytes = Buffer.byteLength(content);
			return this.#cachedEvents;
		}
		if (size === this.#cachedBytes) return this.#cachedEvents;
		const file = await open(this.eventsPath, "r");
		try {
			const buffer = Buffer.alloc(size - this.#cachedBytes);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, this.#cachedBytes);
			const suffix = buffer.subarray(0, bytesRead).toString("utf8");
			const added = this.parseLines(suffix, this.#cachedEvents.length);
			this.#cachedEvents.push(...added);
			this.#cachedBytes += bytesRead;
			return this.#cachedEvents;
		} finally { await file.close(); }
	}

}
