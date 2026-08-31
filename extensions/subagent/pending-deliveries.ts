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

export interface PendingDeliveryBinding {
	release(): boolean;
}

interface DeliveryRecord extends PendingBackgroundDelivery {
	outcome?: PendingBackgroundOutcome;
	observer?: { id: string; deliver(record: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome): boolean };
	delivering?: boolean;
}

/** Process-lifetime obligations are independent of extension bindings and UI state. */
export class PendingSubagentDeliveryRegistry {
	private readonly records = new Map<string, DeliveryRecord>();
	private readonly observers = new Map<string, { id: string; deliver(record: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome): boolean }>();

	track(delivery: PendingBackgroundDelivery, result: Promise<TerminalResult>): void {
		const key = deliveryKey(delivery.owner, delivery.agentId);
		if (this.records.has(key)) throw new Error(`Background delivery is already tracked for ${delivery.agentId}`);
		const record: DeliveryRecord = {
			owner: structuredClone(delivery.owner),
			agent: delivery.agent,
			agentId: delivery.agentId,
			...(this.observers.get(ownerKey(delivery.owner)) ? { observer: this.observers.get(ownerKey(delivery.owner))! } : {}),
		};
		this.records.set(key, record);
		void result.then(
			(terminal) => this.settle(key, { terminal: structuredClone(terminal) }),
			(error) => this.settle(key, { error: error instanceof Error ? error.message : String(error) }),
		);
	}

	bind(
		owner: RuntimeOwner,
		id: string,
		deliver: (record: PendingBackgroundDelivery, outcome: PendingBackgroundOutcome) => boolean,
	): PendingDeliveryBinding {
		if (!id) throw new Error("Pending delivery binding id is required");
		const observer = { id, deliver };
		this.observers.set(ownerKey(owner), observer);
		for (const record of this.records.values()) {
			if (!sameRuntimeOwner(record.owner, owner)) continue;
			record.observer = observer;
			this.flush(record);
		}
		let active = true;
		return {
			release: () => {
				if (!active) return false;
				active = false;
				let released = this.observers.get(ownerKey(owner))?.id === id;
				if (released) this.observers.delete(ownerKey(owner));
				for (const record of this.records.values()) {
					if (record.observer?.id !== id || !sameRuntimeOwner(record.owner, owner)) continue;
					delete record.observer;
					released = true;
				}
				return released;
			},
		};
	}

	discard(owner: RuntimeOwner): number {
		let discarded = 0;
		this.observers.delete(ownerKey(owner));
		for (const [key, record] of this.records) {
			if (!sameRuntimeOwner(record.owner, owner)) continue;
			this.records.delete(key);
			discarded++;
		}
		return discarded;
	}

	count(owner?: RuntimeOwner): number {
		return owner ? [...this.records.values()].filter((record) => sameRuntimeOwner(record.owner, owner)).length : this.records.size;
	}

	private settle(key: string, outcome: PendingBackgroundOutcome): void {
		const record = this.records.get(key);
		if (!record || record.outcome) return;
		record.outcome = outcome;
		this.flush(record);
	}

	private flush(record: DeliveryRecord): void {
		if (!record.outcome || !record.observer || record.delivering) return;
		record.delivering = true;
		let accepted = false;
		try { accepted = record.observer.deliver(record, record.outcome); } catch { accepted = false; }
		if (accepted) this.records.delete(deliveryKey(record.owner, record.agentId));
		else record.delivering = false;
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
