import { sameRuntimeOwner } from "./activation.js";
import type { RuntimeOwner, TerminalResult } from "./api.js";

export interface PendingBackgroundDelivery {
	readonly owner: RuntimeOwner;
	readonly agent: string;
	readonly agentId: string;
}

export type PendingBackgroundOutcome =
	| { readonly terminal: TerminalResult }
	| { readonly error: string };

export interface PendingBackgroundSettlement {
	readonly delivery: PendingBackgroundDelivery;
	readonly outcome: PendingBackgroundOutcome;
}

export interface PendingDeliveryBinding {
	release(): boolean;
}

type SingleDeliveryObserver = {
	readonly id: string;
	readonly mode: "single";
	deliver(record: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome): boolean;
};

type BatchedDeliveryObserver = {
	readonly id: string;
	readonly mode: "batch";
	deliver(settlements: readonly PendingBackgroundSettlement[]): boolean;
};

type DeliveryObserver = SingleDeliveryObserver | BatchedDeliveryObserver;

interface DeliveryRecord extends PendingBackgroundDelivery {
	outcome?: PendingBackgroundOutcome;
	observer?: DeliveryObserver;
	delivering?: boolean;
}

/** Process-lifetime obligations are independent of extension bindings and UI state. */
export class PendingSubagentDeliveryRegistry {
	private readonly records = new Map<string, DeliveryRecord>();
	private readonly observers = new Map<string, DeliveryObserver>();
	private readonly batchTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(private readonly batchDelayMs = 25, private readonly batchSize = 8) {
		if (!Number.isInteger(batchDelayMs) || batchDelayMs < 0) throw new Error("Background delivery batch delay must be a non-negative integer");
		if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Background delivery batch size must be a positive integer");
	}

	track(delivery: PendingBackgroundDelivery, result: Promise<TerminalResult>): void {
		const key = deliveryKey(delivery.owner, delivery.agentId);
		if (this.records.has(key)) throw new Error(`Background delivery is already tracked for ${delivery.agentId}`);
		const observer = this.observers.get(ownerKey(delivery.owner));
		const record: DeliveryRecord = {
			owner: structuredClone(delivery.owner),
			agent: delivery.agent,
			agentId: delivery.agentId,
			...(observer ? { observer } : {}),
		};
		this.records.set(key, record);
		void result.then(
			(terminal) => this.settle(key, { terminal: structuredClone(terminal) }),
			(error) => this.settle(key, { error: error instanceof Error ? error.message : String(error) }),
		);
	}

	/** Legacy one-at-a-time binding retained so a hot-reloaded extension can adopt a v1 process-global registry. */
	bind(
		owner: RuntimeOwner,
		id: string,
		deliver: (record: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome) => boolean,
	): PendingDeliveryBinding {
		return this.bindObserver(owner, { id, mode: "single", deliver });
	}

	/** Coalesce terminal obligations that settle within one short fixed window. */
	bindBatched(
		owner: RuntimeOwner,
		id: string,
		deliver: (settlements: readonly PendingBackgroundSettlement[]) => boolean,
	): PendingDeliveryBinding {
		return this.bindObserver(owner, { id, mode: "batch", deliver });
	}

	discard(owner: RuntimeOwner): number {
		const key = ownerKey(owner);
		this.observers.delete(key);
		this.clearBatchTimer(key);
		let discarded = 0;
		for (const [recordKey, record] of this.records) {
			if (!sameRuntimeOwner(record.owner, owner)) continue;
			this.records.delete(recordKey);
			discarded++;
		}
		return discarded;
	}

	count(owner?: RuntimeOwner): number {
		return owner ? [...this.records.values()].filter((record) => sameRuntimeOwner(record.owner, owner)).length : this.records.size;
	}

	private bindObserver(owner: RuntimeOwner, observer: DeliveryObserver): PendingDeliveryBinding {
		if (!observer.id) throw new Error("Pending delivery binding id is required");
		const key = ownerKey(owner);
		this.clearBatchTimer(key);
		this.observers.set(key, observer);
		for (const record of this.records.values()) {
			if (!sameRuntimeOwner(record.owner, owner)) continue;
			record.observer = observer;
			if (observer.mode === "single") this.flushSingle(record);
		}
		if (observer.mode === "batch") this.scheduleBatch(owner, observer);
		let active = true;
		return {
			release: () => {
				if (!active) return false;
				active = false;
				let released = this.observers.get(key)?.id === observer.id;
				if (released) {
					this.observers.delete(key);
					this.clearBatchTimer(key);
				}
				for (const record of this.records.values()) {
					if (record.observer?.id !== observer.id || !sameRuntimeOwner(record.owner, owner)) continue;
					delete record.observer;
					record.delivering = false;
					released = true;
				}
				return released;
			},
		};
	}

	private settle(key: string, outcome: PendingBackgroundOutcome): void {
		const record = this.records.get(key);
		if (!record || record.outcome) return;
		record.outcome = outcome;
		if (record.observer?.mode === "batch") this.scheduleBatch(record.owner, record.observer);
		else this.flushSingle(record);
	}

	private flushSingle(record: DeliveryRecord): void {
		if (!record.outcome || !record.observer || record.observer.mode !== "single" || record.delivering) return;
		record.delivering = true;
		let accepted = false;
		try { accepted = record.observer.deliver(record, record.outcome); } catch { accepted = false; }
		if (accepted) this.records.delete(deliveryKey(record.owner, record.agentId));
		else record.delivering = false;
	}

	private scheduleBatch(owner: RuntimeOwner, observer: BatchedDeliveryObserver): void {
		const key = ownerKey(owner);
		if (this.batchTimers.has(key)) return;
		const hasSettled = [...this.records.values()].some((record) => sameRuntimeOwner(record.owner, owner) && record.outcome && record.observer?.id === observer.id);
		if (!hasSettled) return;
		this.batchTimers.set(key, setTimeout(() => {
			this.batchTimers.delete(key);
			this.flushBatch(owner, observer);
		}, this.batchDelayMs));
	}

	private flushBatch(owner: RuntimeOwner, observer: BatchedDeliveryObserver): void {
		if (this.observers.get(ownerKey(owner))?.id !== observer.id) return;
		const records = [...this.records.values()].filter((record) =>
			sameRuntimeOwner(record.owner, owner)
			&& Boolean(record.outcome)
			&& record.observer?.id === observer.id
			&& !record.delivering,
		).slice(0, this.batchSize);
		if (records.length === 0) return;
		for (const record of records) record.delivering = true;
		const settlements = records.map((record) => ({
			delivery: { owner: structuredClone(record.owner), agent: record.agent, agentId: record.agentId },
			outcome: structuredClone(record.outcome!),
		}));
		let accepted = false;
		try { accepted = observer.deliver(settlements); } catch { accepted = false; }
		for (const record of records) {
			if (accepted) this.records.delete(deliveryKey(record.owner, record.agentId));
			else record.delivering = false;
		}
		if (accepted) this.scheduleBatch(owner, observer);
	}

	private clearBatchTimer(key: string): void {
		const timer = this.batchTimers.get(key);
		if (timer === undefined) return;
		clearTimeout(timer);
		this.batchTimers.delete(key);
	}
}

function ownerKey(owner: RuntimeOwner): string {
	return [owner.processInstanceId, owner.activationId, owner.sessionId].join("\0");
}

function deliveryKey(owner: RuntimeOwner, agentId: string): string {
	return `${ownerKey(owner)}\0${agentId}`;
}

const PENDING_DELIVERY_REGISTRY_KEY = Symbol.for("pibox:subagent-pending-delivery-registry:v1");
type PendingRegistryGlobal = typeof globalThis & { [PENDING_DELIVERY_REGISTRY_KEY]?: PendingSubagentDeliveryRegistry };

export function getPendingSubagentDeliveryRegistry(): PendingSubagentDeliveryRegistry {
	const root = globalThis as PendingRegistryGlobal;
	return root[PENDING_DELIVERY_REGISTRY_KEY] ??= new PendingSubagentDeliveryRegistry();
}
