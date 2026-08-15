import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ServiceState = "stopped" | "starting" | "running" | "unhealthy" | "updating" | "error";

export interface ServiceSnapshot {
	state: ServiceState;
	detail?: string;
	checkedAt?: string;
	error?: string;
}

export interface ServiceDescriptor {
	id: string;
	name: string;
	order: number;
	internal: boolean;
	stayAlive: boolean;
	singleton: boolean;
	perSession: boolean;
}

export interface ServiceOperationContext {
	ctx: ExtensionContext;
	signal?: AbortSignal;
}

export interface ServiceController {
	start?(operation: ServiceOperationContext): Promise<ServiceSnapshot>;
	stop?(operation: ServiceOperationContext): Promise<ServiceSnapshot>;
	health(operation: ServiceOperationContext): Promise<ServiceSnapshot>;
	update?(operation: ServiceOperationContext): Promise<ServiceSnapshot>;
}

export interface RegisteredService {
	descriptor: ServiceDescriptor;
	controller: ServiceController;
	snapshot: ServiceSnapshot;
}
