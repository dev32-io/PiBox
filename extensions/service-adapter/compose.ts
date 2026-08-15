import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import type { ServiceController, ServiceOperationContext, ServiceSnapshot } from "./types.js";

export interface ComposeServiceConfig {
	id: string;
	composeFile: string;
	projectDirectory: string;
	healthUrl: string;
	healthTimeoutMs?: number;
	readinessTimeoutMs?: number;
	lockRoot: string;
	prepare?: () => Promise<void>;
	updateStrategy?: "pull" | "build";
}

class ServiceMutex {
	readonly path: string;
	#tail: Promise<void> = Promise.resolve();

	constructor(root: string, id: string) {
		this.path = join(root, `${id}.lock`);
	}

	async run<T>(operation: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#tail;
		let release!: () => void;
		this.#tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			await this.acquire(operation);
			try { return await task(); }
			finally { await rm(this.path, { recursive: true, force: true }); }
		} finally {
			release();
		}
	}

	private async acquire(operation: string): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const deadline = Date.now() + 30_000;
		while (true) {
			try {
				await mkdir(this.path);
				await writeFile(join(this.path, "owner.json"), `${JSON.stringify({ pid: process.pid, operation, acquiredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
				return;
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			}
			if (await this.recoverStale()) continue;
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${operation} service lock.`);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	private async recoverStale(): Promise<boolean> {
		try {
			const owner = JSON.parse(await readFile(join(this.path, "owner.json"), "utf8")) as { pid?: number };
			if (owner.pid) {
				try { process.kill(owner.pid, 0); return false; }
				catch { /* stale owner */ }
			}
			await rm(this.path, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
}

export async function probeServiceHealth(url: string, timeoutMs: number, signal?: AbortSignal): Promise<ServiceSnapshot> {
	const target = new URL(url);
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	return new Promise<ServiceSnapshot>((resolve, reject) => {
		const transport = target.protocol === "https:" ? httpsGet : httpGet;
		const request = transport(target, { signal: combined }, (response) => {
			response.resume();
			const status = response.statusCode ?? 0;
			resolve(status >= 200 && status < 300
				? { state: "running", detail: target.host }
				: { state: "unhealthy", detail: `HTTP ${status || "unknown"}` });
		});
		request.once("error", (error) => {
			if (signal?.aborted) reject(error);
			else resolve({ state: "stopped" });
		});
	});
}

export function createComposeServiceController(pi: ExtensionAPI, config: ComposeServiceConfig): ServiceController {
	const mutex = new ServiceMutex(config.lockRoot, config.id);
	const compose = async (args: string[], operation: ServiceOperationContext) => {
		operation.signal?.throwIfAborted();
		const result = await pi.exec("docker", ["compose", "-f", config.composeFile, ...args], {
			cwd: config.projectDirectory,
			timeout: 600_000,
			...(operation.signal ? { signal: operation.signal } : {}),
		});
		if (result.code !== 0) throw new Error(`docker compose ${args.join(" ")} failed: ${result.stderr.trim().slice(0, 500)}`);
	};
	const health = (operation: ServiceOperationContext) => probeServiceHealth(config.healthUrl, config.healthTimeoutMs ?? 3_000, operation.signal);
	const waitUntilReady = async (operation: ServiceOperationContext): Promise<ServiceSnapshot> => {
		const deadline = Date.now() + (config.readinessTimeoutMs ?? 60_000);
		while (Date.now() < deadline) {
			operation.signal?.throwIfAborted();
			const snapshot = await health(operation);
			if (snapshot.state === "running") return snapshot;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		return { state: "unhealthy", detail: "readiness timeout" };
	};
	return {
		health,
		start: (operation) => mutex.run("start", async () => {
			const current = await health(operation);
			if (current.state !== "running") await config.prepare?.();
			if (current.state === "running") return current;
			await compose(["up", "-d"], operation);
			return waitUntilReady(operation);
		}),
		stop: (operation) => mutex.run("stop", async () => {
			await compose(["stop"], operation);
			return { state: "stopped" };
		}),
		update: (operation) => mutex.run("update", async () => {
			await config.prepare?.();
			if (config.updateStrategy === "build") await compose(["build", "--pull"], operation);
			else await compose(["pull"], operation);
			await compose(["up", "-d"], operation);
			return waitUntilReady(operation);
		}),
	};
}
