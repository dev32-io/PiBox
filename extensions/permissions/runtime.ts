import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./types.js";

export interface PermissionRuntimeController {
	getMode(): PermissionMode;
	setMode(mode: PermissionMode, source: "shortcut" | "command" | "workflow"): void;
	confirmWorkflowStart(ctx: ExtensionContext, ref: string): Promise<boolean>;
}

let controller: PermissionRuntimeController | undefined;

export function installPermissionRuntime(next: PermissionRuntimeController): () => void {
	controller = next;
	return () => {
		if (controller === next) controller = undefined;
	};
}

export function currentPermissionMode(): PermissionMode | undefined {
	return controller?.getMode();
}

export async function confirmWorkflowBypass(ctx: ExtensionContext, ref: string): Promise<boolean> {
	if (!controller) throw new Error("PiBox permission extension is unavailable; refusing to start an unattended workflow without explicit bypass confirmation.");
	return controller.confirmWorkflowStart(ctx, ref);
}

export function activateWorkflowBypass(): void {
	if (!controller) throw new Error("PiBox permission extension is unavailable; cannot activate workflow bypass mode.");
	controller.setMode("bypass", "workflow");
}
