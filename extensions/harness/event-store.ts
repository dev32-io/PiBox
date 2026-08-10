import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { atomicWriteFile, readTextIfExists, type RepositoryIdentity } from "./repository.js";

export interface HarnessEvent<T = unknown> {
	sequence: number;
	at: string;
	type: string;
	data: T;
}

export class RepositoryEventStore {
	readonly identity: RepositoryIdentity;
	readonly eventsPath: string;
	#sequence = 0;
	#queue: Promise<void> = Promise.resolve();

	constructor(identity: RepositoryIdentity) {
		this.identity = identity;
		this.eventsPath = join(identity.privateRoot, "events.jsonl");
	}

	async initialize(): Promise<void> {
		await mkdir(this.identity.privateRoot, { recursive: true, mode: 0o700 });
		const existing = await readTextIfExists(this.eventsPath);
		if (existing) {
			for (const line of existing.split("\n")) {
				if (!line.trim()) continue;
				try {
					const event = JSON.parse(line) as { sequence?: unknown };
					if (typeof event.sequence === "number") this.#sequence = Math.max(this.#sequence, event.sequence);
				} catch {
					// Recovery reports malformed lines; initialization preserves the log.
				}
			}
		}
		await atomicWriteFile(
			join(this.identity.privateRoot, "repository.yaml"),
			stringify({ schemaVersion: 1, id: this.identity.id, root: this.identity.root }),
			0o600,
		);
	}

	append<T>(type: string, data: T): Promise<HarnessEvent<T>> {
		const event: HarnessEvent<T> = { sequence: ++this.#sequence, at: new Date().toISOString(), type, data };
		const operation = this.#queue.then(async () => {
			await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
		});
		this.#queue = operation.catch(() => undefined);
		return operation.then(() => event);
	}

	async readAll(): Promise<HarnessEvent[]> {
		await this.#queue;
		const content = await readFile(this.eventsPath, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
			throw error;
		});
		return content
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as HarnessEvent);
	}

	async flush(): Promise<void> {
		await this.#queue;
	}
}
