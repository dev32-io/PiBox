interface ManagedWorkflowOperation {
	readonly workItemId: string;
	readonly controller: AbortController;
	readonly settled: Promise<void>;
	finish(): void;
}

export interface ManagedWorkflowOperationHandle {
	readonly signal: AbortSignal;
	finish(): void;
}

/**
 * Process-global ownership for adapter operations that can outlive an extension
 * instance during hot reload. A replacement adapter can therefore stop and await
 * pre-launch work instead of losing it when the old runner detaches.
 */
export class ManagedWorkflowOperationRegistry {
	readonly #operations = new Set<ManagedWorkflowOperation>();

	begin(workItemId: string, upstreamSignal?: AbortSignal): ManagedWorkflowOperationHandle {
		if (!workItemId) throw new Error("Managed workflow operation requires a work item");
		const controller = new AbortController();
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => { settle = resolve; });
		let finished = false;
		const operation: ManagedWorkflowOperation = {
			workItemId,
			controller,
			settled,
			finish: () => {
				if (finished) return;
				finished = true;
				this.#operations.delete(operation);
				settle();
			},
		};
		this.#operations.add(operation);
		const signal = upstreamSignal ? AbortSignal.any([upstreamSignal, controller.signal]) : controller.signal;
		return { signal, finish: operation.finish };
	}

	async stopWorkItem(workItemId: string, reason: unknown = new DOMException("Workflow stopped", "AbortError")): Promise<number> {
		let stopped = 0;
		// Operations register synchronously before their first await. Loop so an old
		// runner that was already entering runStep while stop began is also joined.
		for (;;) {
			const current = [...this.#operations].filter((operation) => operation.workItemId === workItemId);
			if (current.length === 0) return stopped;
			for (const operation of current) {
				if (!operation.controller.signal.aborted) {
					operation.controller.abort(reason);
					stopped++;
				}
			}
			await Promise.all(current.map((operation) => operation.settled));
		}
	}

	async stopAll(reason: unknown = new DOMException("Workflow runtime stopped", "AbortError")): Promise<number> {
		let stopped = 0;
		for (;;) {
			const current = [...this.#operations];
			if (current.length === 0) return stopped;
			for (const operation of current) {
				if (!operation.controller.signal.aborted) {
					operation.controller.abort(reason);
					stopped++;
				}
			}
			await Promise.all(current.map((operation) => operation.settled));
		}
	}

	activeCount(workItemId?: string): number {
		return workItemId === undefined ? this.#operations.size : [...this.#operations].filter((operation) => operation.workItemId === workItemId).length;
	}
}

const REGISTRY_KEY = Symbol.for("pibox.workflow-runtime.managed-operation-registry");

export function getManagedWorkflowOperationRegistry(): ManagedWorkflowOperationRegistry {
	const root = globalThis as typeof globalThis & { [REGISTRY_KEY]?: ManagedWorkflowOperationRegistry };
	return root[REGISTRY_KEY] ??= new ManagedWorkflowOperationRegistry();
}
