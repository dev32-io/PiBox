import { createVisualCompanionBackend, type VisualCompanionBackend, type VisualCompanionSelection, type VisualCompanionViewer } from "./backend.mjs";

export interface VisualCompanionPlatformOptions {
	createBackend?: () => Promise<VisualCompanionBackend>;
}

/** Session-local lifecycle boundary shared by /services and direct-open tools. */
export function createVisualCompanionPlatform(options: VisualCompanionPlatformOptions = {}) {
	const createBackend = options.createBackend ?? (() => createVisualCompanionBackend());
	let backend: VisualCompanionBackend | undefined;
	let operationTail: Promise<void> = Promise.resolve();
	let shuttingDown = false;

	const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = operationTail;
		let release!: () => void;
		operationTail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try { return await operation(); }
		finally { release(); }
	};

	const startUnlocked = async (signal?: AbortSignal): Promise<{ backend: VisualCompanionBackend; reused: boolean }> => {
		if (shuttingDown) throw new Error("The visual companion session is shutting down.");
		signal?.throwIfAborted();
		if (backend) return { backend, reused: true };
		// No viewer factory or discovery callback runs until this await completes:
		// the common shell is the platform's first observable startup milestone.
		const created = await createBackend();
		if (shuttingDown || signal?.aborted) {
			await created.close();
			signal?.throwIfAborted();
			throw new Error("The visual companion start was cancelled during session shutdown.");
		}
		backend = created;
		return { backend, reused: false };
	};

	return {
		beginSession() {
			shuttingDown = false;
		},
		start(signal?: AbortSignal) {
			return serial(() => startUnlocked(signal));
		},
		status() {
			return backend ? { state: "running" as const, url: backend.url, port: backend.port } : { state: "stopped" as const };
		},
		open(input: { viewer: VisualCompanionViewer | (() => VisualCompanionViewer); artifactPath?: string; signal?: AbortSignal }): Promise<VisualCompanionSelection & { reused: boolean }> {
			return serial(async () => {
				const started = await startUnlocked(input.signal);
				input.signal?.throwIfAborted();
				const viewer = typeof input.viewer === "function" ? input.viewer() : input.viewer;
				if (!started.backend.viewers.includes(viewer.id)) started.backend.registerViewer(viewer);
				return { ...started.backend.show({ viewerId: viewer.id, ...(input.artifactPath ? { artifactPath: input.artifactPath } : {}) }), reused: started.reused };
			});
		},
		stop() {
			return serial(async () => {
				const current = backend;
				backend = undefined;
				if (current) await current.close();
				return { state: "stopped" as const };
			});
		},
		shutdown() {
			shuttingDown = true;
			return serial(async () => {
				const current = backend;
				backend = undefined;
				if (current) await current.close();
			});
		},
	};
}

export type VisualCompanionPlatform = ReturnType<typeof createVisualCompanionPlatform>;
