import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./types.js";

export interface PermissionRuntimeController {
	getMode(): PermissionMode;
	setMode(mode: PermissionMode, source: "shortcut" | "command" | "workflow"): void;
	confirmWorkflowStart(ctx: ExtensionContext, ref: string): Promise<boolean>;
	confirmCriticalRisk?(ctx: ExtensionContext, ref: string, findingIds: string[]): Promise<boolean>;
}

const RUNTIME_KEY = Symbol.for("pibox:permission-runtime");
type RuntimeGlobal = typeof globalThis & { [RUNTIME_KEY]?: PermissionRuntimeController };

function runtimeGlobal(): RuntimeGlobal {
	return globalThis as RuntimeGlobal;
}

export function installPermissionRuntime(next: PermissionRuntimeController): () => void {
	runtimeGlobal()[RUNTIME_KEY] = next;
	return () => {
		if (runtimeGlobal()[RUNTIME_KEY] === next) delete runtimeGlobal()[RUNTIME_KEY];
	};
}

export function currentPermissionMode(): PermissionMode | undefined {
	return runtimeGlobal()[RUNTIME_KEY]?.getMode();
}

export async function confirmWorkflowBypass(ctx: ExtensionContext, ref: string): Promise<boolean> {
	const controller = runtimeGlobal()[RUNTIME_KEY];
	if (!controller) throw new Error("PiBox permission extension is unavailable; refusing to start an unattended workflow without explicit bypass confirmation.");
	return controller.confirmWorkflowStart(ctx, ref);
}

export async function confirmCriticalRisk(ctx: ExtensionContext, ref: string, findingIds: string[]): Promise<boolean> {
	const controller = runtimeGlobal()[RUNTIME_KEY];
	if (!controller?.confirmCriticalRisk) return false;
	return controller.confirmCriticalRisk(ctx, ref, findingIds);
}

export function activateWorkflowBypass(): void {
	const controller = runtimeGlobal()[RUNTIME_KEY];
	if (!controller) throw new Error("PiBox permission extension is unavailable; cannot activate workflow bypass mode.");
	controller.setMode("bypass", "workflow");
}
