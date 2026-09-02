import { randomUUID } from "node:crypto";
import { sameRuntimeOwner } from "./activation.js";
import type { LogicalAgentHandle, RuntimeOwner } from "./api.js";

interface CapabilityRecord<T> {
	readonly handle: LogicalAgentHandle;
	readonly value: T;
	reservation: symbol | undefined;
}

export interface ContinuationReservation<T> {
	readonly value: T;
	/** Permit another continuation attempt with this capability. */
	release(): void;
	/** Permanently consume the capability after continuation settles. */
	settle(): void;
}

/**
 * Manager-private transport lookup for opaque public handles. Reservations make
 * continuation single-flight; settlement and revocation make handles stale.
 */
export class ContinuationCapabilityStore<T> {
	private readonly records = new Map<string, CapabilityRecord<T>>();

	constructor(private readonly issueId: () => string = randomUUID) {}

	issue(owner: RuntimeOwner, agentId: string, value: T): LogicalAgentHandle {
		if (!agentId) throw new Error("agentId is required");
		let continuationCapability: string;
		do continuationCapability = this.issueId(); while (!continuationCapability || this.records.has(continuationCapability));
		const handle: LogicalAgentHandle = {
			owner: structuredClone(owner),
			agentId,
			continuationCapability,
		};
		this.records.set(continuationCapability, { handle, value, reservation: undefined });
		return structuredClone(handle);
	}

	reserve(owner: RuntimeOwner, handle: LogicalAgentHandle): ContinuationReservation<T> {
		const record = this.records.get(handle.continuationCapability);
		if (!record
			|| !sameRuntimeOwner(owner, record.handle.owner)
			|| !sameRuntimeOwner(handle.owner, record.handle.owner)
			|| handle.agentId !== record.handle.agentId) {
			throw new Error("Unknown or stale continuation capability");
		}
		if (record.reservation) throw new Error("Continuation capability is already reserved");
		const reservation = Symbol("continuation-reservation");
		record.reservation = reservation;
		let active = true;
		const finish = (settled: boolean): void => {
			if (!active || record.reservation !== reservation) throw new Error("Continuation reservation is no longer active");
			active = false;
			if (settled) this.records.delete(handle.continuationCapability);
			else record.reservation = undefined;
		};
		return {
			value: record.value,
			release: () => finish(false),
			settle: () => finish(true),
		};
	}

	revoke(owner: RuntimeOwner, handle: LogicalAgentHandle): boolean {
		const record = this.records.get(handle.continuationCapability);
		if (!record
			|| !sameRuntimeOwner(owner, record.handle.owner)
			|| !sameRuntimeOwner(handle.owner, record.handle.owner)
			|| handle.agentId !== record.handle.agentId
			|| record.reservation) return false;
		return this.records.delete(handle.continuationCapability);
	}

	/** Irrevocably invalidate every capability when its owner activation ends. */
	clear(): void {
		this.records.clear();
	}
}
