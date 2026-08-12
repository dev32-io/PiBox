import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export class WorkflowRuntimeError extends Error {
	constructor(readonly code: string, message: string) { super(message); }
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}

export async function atomicWriteFile(path: string, content: string, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
	const handle = await open(temporary, "wx", mode);
	try { await handle.writeFile(content, "utf8"); await handle.sync(); }
	finally { await handle.close(); }
	await rename(temporary, path);
}

/** Small cross-process mutex for the file-backed workflow registry. */
export class WorkflowMutex {
	readonly path: string;
	#tail: Promise<void> = Promise.resolve();
	constructor(root: string, readonly waitTimeoutMs = 30_000) { this.path = join(root, "locks", "registry"); }

	async recoverStale(): Promise<boolean> {
		let owner: { pid?: number };
		try { owner = JSON.parse(await readFile(join(this.path, "owner"), "utf8")) as { pid?: number }; }
		catch { return false; }
		if (owner.pid) {
			try { process.kill(owner.pid, 0); return false; }
			catch { /* dead owner */ }
		}
		await rm(this.path, { recursive: true, force: true });
		return true;
	}

	async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.#tail; let release!: () => void;
		this.#tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			await this.acquire(owner);
			try { return await operation(); }
			finally { await rm(this.path, { recursive: true, force: true }); }
		} finally { release(); }
	}

	private async acquire(owner: string): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + this.waitTimeoutMs;
		while (true) {
			try {
				await mkdir(this.path);
				try { await atomicWriteFile(join(this.path, "owner"), `${JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`); return; }
				catch (error) { await rm(this.path, { recursive: true, force: true }); throw error; }
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			}
			if (await this.recoverStale()) continue;
			if (Date.now() >= deadline) throw new WorkflowRuntimeError("RESOURCE_LOCKED", `Timed out waiting for workflow registry lock (${owner})`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}
