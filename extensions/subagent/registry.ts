import { runtimeOwnerForActivation, sameRuntimeOwner, type ActivationLifecycle } from "./activation.js";
import type { RuntimeOwner, SubagentService } from "./api.js";

export const SUBAGENT_PROTOCOL_VERSION = 1 as const;

export interface SubagentCapability {
	readonly protocolVersion: typeof SUBAGENT_PROTOCOL_VERSION;
	readonly owner: RuntimeOwner;
	readonly service: SubagentService;
}

/** A discoverable extension binding. Releasing it does not tear down its manager. */
export interface SubagentRegistration extends SubagentCapability {
	unregister(): Promise<boolean>;
}

export interface SubagentBindingRequest {
	readonly lifecycle: ActivationLifecycle;
	readonly sessionId: string;
	readonly processInstanceId: string;
	/** Required whenever a manager must be created; reload ignores it when rebinding succeeds. */
	readonly activationId?: string;
}

/** Safe consumer lookup key. Both fields are live-process facts, never durable adoption keys. */
export interface SubagentConsumerRequest {
	readonly sessionId: string;
	readonly processInstanceId: string;
}

interface RegistrySlot {
	capability: SubagentCapability;
	registration: SubagentRegistration | undefined;
}

export class SubagentCapabilityRegistry {
	private slot: RegistrySlot | undefined;
	private pending: Promise<void> = Promise.resolve();

	/**
	 * Bind an extension activation to a manager. A reload in the same process and
	 * session rebinds the existing manager. If no manager exists (for example when
	 * this extension is first introduced by /reload), reload creates a fresh
	 * activation rather than failing. Every other lifecycle also creates fresh.
	 */
	async acquire(
		request: SubagentBindingRequest,
		create: (owner: RuntimeOwner) => SubagentService | Promise<SubagentService>,
	): Promise<SubagentRegistration> {
		return this.exclusive(async () => {
			if (request.lifecycle === "reload") {
				const slot = this.slot;
				if (slot
					&& slot.capability.owner.sessionId === request.sessionId
					&& slot.capability.owner.processInstanceId === request.processInstanceId) {
					return this.bind(slot);
				}
			}

			const activationId = request.activationId;
			if (!activationId) {
				if (request.lifecycle === "reload") throw new Error("Reload has no manager to rebind and requires activationId to create a fresh activation");
				throw new Error(`${request.lifecycle} requires activationId`);
			}
			const nextOwner = runtimeOwnerForActivation({ ...request, lifecycle: request.lifecycle === "reload" ? "startup" : request.lifecycle, activationId });
			if (this.slot) await this.removeManager(this.slot);
			const nextService = await create(nextOwner);
			const capability = { protocolVersion: SUBAGENT_PROTOCOL_VERSION, owner: nextOwner, service: nextService } as const;
			this.assertCapability(capability);
			const slot: RegistrySlot = { capability, registration: undefined };
			this.slot = slot;
			return this.bind(slot);
		});
	}

	/** Low-level registration retained for manager implementations and tests. */
	async register(capability: SubagentCapability, options: { replace?: boolean } = {}): Promise<SubagentRegistration> {
		return this.exclusive(async () => {
			this.assertCapability(capability);
			const current = this.slot;
			if (current && current.capability.service === capability.service) {
				if (!sameRuntimeOwner(current.capability.owner, capability.owner)) throw new Error("A subagent service cannot be adopted by another activation");
				return current.registration ?? this.bind(current);
			}
			if (current && !options.replace) throw new Error("A subagent service is already registered");
			if (current) await this.removeManager(current);
			const slot: RegistrySlot = { capability, registration: undefined };
			this.slot = slot;
			return this.bind(slot);
		});
	}

	resolve(owner: RuntimeOwner, protocolVersion: number = SUBAGENT_PROTOCOL_VERSION): SubagentService | undefined {
		this.assertVersion(protocolVersion);
		if (!this.slot?.registration || !sameRuntimeOwner(owner, this.slot.capability.owner)) return undefined;
		return this.slot.capability.service;
	}

	/** Resolve only the currently registered capability in this exact session and OS process. */
	resolveConsumer(request: SubagentConsumerRequest, protocolVersion: number = SUBAGENT_PROTOCOL_VERSION): SubagentCapability | undefined {
		this.assertVersion(protocolVersion);
		const capability = this.slot?.registration ? this.slot.capability : undefined;
		if (!capability
			|| capability.owner.sessionId !== request.sessionId
			|| capability.owner.processInstanceId !== request.processInstanceId) return undefined;
		return capability;
	}

	/** Explicit manager teardown, distinct from releasing an extension binding. */
	async teardown(owner: RuntimeOwner): Promise<boolean> {
		return this.exclusive(async () => {
			if (!this.slot || !sameRuntimeOwner(owner, this.slot.capability.owner)) return false;
			return this.removeManager(this.slot);
		});
	}

	async clear(): Promise<void> {
		await this.exclusive(async () => {
			if (this.slot) await this.removeManager(this.slot);
		});
	}

	private bind(slot: RegistrySlot): SubagentRegistration {
		let registration!: SubagentRegistration;
		registration = {
			...slot.capability,
			unregister: () => this.exclusive(async () => {
				if (this.slot !== slot || slot.registration !== registration) return false;
				slot.registration = undefined;
				return true;
			}),
		};
		slot.registration = registration;
		return registration;
	}

	private async removeManager(slot: RegistrySlot): Promise<boolean> {
		if (this.slot !== slot) return false;
		this.slot = undefined;
		slot.registration = undefined;
		await slot.capability.service.teardown();
		return true;
	}

	private assertCapability(capability: SubagentCapability): void {
		this.assertVersion(capability.protocolVersion);
		if (capability.service.protocolVersion !== capability.protocolVersion) throw new Error("Subagent service protocol version does not match its registration");
		if (!sameRuntimeOwner(capability.owner, capability.service.owner)) throw new Error("Subagent service owner does not match its registration");
	}

	private assertVersion(version: number): asserts version is typeof SUBAGENT_PROTOCOL_VERSION {
		if (version !== SUBAGENT_PROTOCOL_VERSION) throw new Error(`Unsupported subagent protocol version: ${version}`);
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.pending.then(operation, operation);
		this.pending = result.then(() => undefined, () => undefined);
		return result;
	}
}

const REGISTRY_KEY = Symbol.for("pibox:subagent-capability-registry:v1");
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: SubagentCapabilityRegistry };

/** Process-global by design: module reloads rebind to this same in-memory object. */
export function getSubagentCapabilityRegistry(): SubagentCapabilityRegistry {
	const root = globalThis as RegistryGlobal;
	return root[REGISTRY_KEY] ??= new SubagentCapabilityRegistry();
}

export function acquireSubagentService(
	request: SubagentBindingRequest,
	create: (owner: RuntimeOwner) => SubagentService | Promise<SubagentService>,
): Promise<SubagentRegistration> {
	return getSubagentCapabilityRegistry().acquire(request, create);
}

export function registerSubagentService(capability: SubagentCapability, options?: { replace?: boolean }): Promise<SubagentRegistration> {
	return getSubagentCapabilityRegistry().register(capability, options);
}

export function resolveSubagentService(owner: RuntimeOwner, protocolVersion?: number): SubagentService | undefined {
	return getSubagentCapabilityRegistry().resolve(owner, protocolVersion);
}

export function resolveSubagentServiceForConsumer(request: SubagentConsumerRequest, protocolVersion?: number): SubagentCapability | undefined {
	return getSubagentCapabilityRegistry().resolveConsumer(request, protocolVersion);
}
