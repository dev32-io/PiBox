import type { WorkflowAdapter } from "./api.js";

export const WORKFLOW_ADAPTER_PROTOCOL_VERSION = 1 as const;

export interface WorkflowAdapterCapability {
	readonly protocolVersion: typeof WORKFLOW_ADAPTER_PROTOCOL_VERSION;
	readonly adapter: WorkflowAdapter;
}

export interface WorkflowAdapterRegistration extends WorkflowAdapterCapability {
	unregister(): boolean;
}

export type WorkflowAdapterRegistryListener = () => void;

interface RegistrySlot {
	capability: WorkflowAdapterCapability;
	registration: WorkflowAdapterRegistration;
}

/** Process-global workflow capability registry. Registrations are explicit and token-fenced. */
export class WorkflowAdapterCapabilityRegistry {
	private readonly slots = new Map<string, RegistrySlot>();
	private readonly listeners = new Set<WorkflowAdapterRegistryListener>();

	register(capability: WorkflowAdapterCapability, options: { replace?: boolean } = {}): WorkflowAdapterRegistration {
		this.assertCapability(capability);
		const id = capability.adapter.id;
		const current = this.slots.get(id);
		if (current?.capability.adapter === capability.adapter) return current.registration;
		if (current && !options.replace) throw new Error(`Workflow adapter ${id} is already registered`);

		let registration!: WorkflowAdapterRegistration;
		registration = {
			...capability,
			unregister: () => {
				const slot = this.slots.get(id);
				if (!slot || slot.registration !== registration) return false;
				this.slots.delete(id);
				this.changed();
				return true;
			},
		};
		this.slots.set(id, { capability, registration });
		this.changed();
		return registration;
	}

	resolve(ref: string, protocolVersion: number = WORKFLOW_ADAPTER_PROTOCOL_VERSION): WorkflowAdapter | undefined {
		this.assertVersion(protocolVersion);
		const matches = this.list(protocolVersion).filter((adapter) => adapter.canHandle(ref));
		if (matches.length > 1) throw new Error(`Workflow reference ${ref} is accepted by multiple adapters: ${matches.map((adapter) => adapter.id).join(", ")}`);
		return matches[0];
	}

	list(protocolVersion: number = WORKFLOW_ADAPTER_PROTOCOL_VERSION): WorkflowAdapter[] {
		this.assertVersion(protocolVersion);
		return [...this.slots.values()].map((slot) => slot.capability.adapter).sort((left, right) => left.id.localeCompare(right.id));
	}

	subscribe(listener: WorkflowAdapterRegistryListener): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	clear(): void {
		if (this.slots.size === 0) return;
		this.slots.clear();
		this.changed();
	}

	private changed(): void {
		for (const listener of [...this.listeners]) listener();
	}

	private assertCapability(capability: WorkflowAdapterCapability): void {
		this.assertVersion(capability.protocolVersion);
		if (!capability.adapter.id.trim()) throw new Error("Workflow adapter id must not be empty");
	}

	private assertVersion(version: number): asserts version is typeof WORKFLOW_ADAPTER_PROTOCOL_VERSION {
		if (version !== WORKFLOW_ADAPTER_PROTOCOL_VERSION) throw new Error(`Unsupported workflow adapter protocol version: ${version}`);
	}
}

const REGISTRY_KEY = Symbol.for("pibox:workflow-adapter-capability-registry:v1");
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: WorkflowAdapterCapabilityRegistry };

export function getWorkflowAdapterCapabilityRegistry(): WorkflowAdapterCapabilityRegistry {
	const root = globalThis as RegistryGlobal;
	return root[REGISTRY_KEY] ??= new WorkflowAdapterCapabilityRegistry();
}

export function registerWorkflowAdapter(adapter: WorkflowAdapter, options: { replace?: boolean } = { replace: true }): WorkflowAdapterRegistration {
	return getWorkflowAdapterCapabilityRegistry().register({ protocolVersion: WORKFLOW_ADAPTER_PROTOCOL_VERSION, adapter }, options);
}

export function resolveWorkflowAdapter(ref: string, protocolVersion?: number): WorkflowAdapter | undefined {
	return getWorkflowAdapterCapabilityRegistry().resolve(ref, protocolVersion);
}
