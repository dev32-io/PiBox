import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RegisteredService, ServiceController, ServiceDescriptor, ServiceSnapshot, ServiceState } from "./types.js";

const services = new Map<string, RegisteredService>();

export function serviceStatusKey(descriptor: ServiceDescriptor): string {
	return `service:${String(descriptor.order).padStart(4, "0")}:${descriptor.id}`;
}

export function formatServiceStatus(ctx: ExtensionContext, service: RegisteredService): string {
	const { state } = service.snapshot;
	const indicator = state === "running"
		? ctx.ui.theme.fg("success", "●")
		: state === "stopped"
			? ctx.ui.theme.fg("dim", "○")
			: state === "starting" || state === "updating"
				? ctx.ui.theme.fg("warning", "◌")
				: ctx.ui.theme.fg("error", "!");
	const label = ctx.ui.theme.fg(state === "unhealthy" || state === "error" ? "error" : "dim", service.descriptor.name);
	return `${indicator} ${label}`;
}

export function publishService(ctx: ExtensionContext, service: RegisteredService): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(serviceStatusKey(service.descriptor), formatServiceStatus(ctx, service));
}

export function registerService(descriptor: ServiceDescriptor, controller: ServiceController): () => void {
	if (services.has(descriptor.id)) throw new Error(`Service already registered: ${descriptor.id}`);
	const registration = { descriptor, controller, snapshot: { state: "stopped" } } satisfies RegisteredService;
	services.set(descriptor.id, registration);
	return () => {
		if (services.get(descriptor.id) === registration) services.delete(descriptor.id);
	};
}

export function getService(id: string): RegisteredService | undefined {
	return services.get(id);
}

export function listServices(): RegisteredService[] {
	return [...services.values()].sort((left, right) => left.descriptor.order - right.descriptor.order || left.descriptor.id.localeCompare(right.descriptor.id));
}

export function listServiceDetails(): Array<{ descriptor: ServiceDescriptor; snapshot: ServiceSnapshot }> {
	return listServices().map(({ descriptor, snapshot }) => ({
		descriptor: { ...descriptor },
		snapshot: { ...snapshot },
	}));
}

export function setServiceSnapshot(id: string, snapshot: ServiceSnapshot, ctx?: ExtensionContext): ServiceSnapshot {
	const service = services.get(id);
	if (!service) throw new Error(`Unknown service: ${id}`);
	service.snapshot = { ...snapshot, checkedAt: snapshot.checkedAt ?? new Date().toISOString() };
	if (ctx) publishService(ctx, service);
	return service.snapshot;
}

export function setServiceState(id: string, state: ServiceState, ctx?: ExtensionContext, detail?: string): ServiceSnapshot {
	return setServiceSnapshot(id, { state, ...(detail ? { detail } : {}) }, ctx);
}

export async function operateService(id: string, action: "start" | "stop" | "health" | "update", operation: Parameters<ServiceController["health"]>[0]): Promise<ServiceSnapshot> {
	const service = services.get(id);
	if (!service) throw new Error(`Unknown service: ${id}`);
	const method = service.controller[action];
	if (!method) throw new Error(`${service.descriptor.name} does not support ${action}.`);
	const pending: ServiceState = action === "update" ? "updating" : action === "stop" ? service.snapshot.state : "starting";
	if (action !== "health") setServiceState(id, pending, operation.ctx);
	try {
		const snapshot = await method.call(service.controller, operation);
		return setServiceSnapshot(id, snapshot, operation.ctx);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		setServiceSnapshot(id, { state: "error", error: message }, operation.ctx);
		throw error;
	}
}

export function resetServiceRegistryForTests(): void {
	services.clear();
}
