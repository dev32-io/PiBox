import type { PiBoxWorkMode } from "./policy.js";

export interface WorkModeRuntimeSnapshot {
	sessionId: string;
	mode: PiBoxWorkMode;
	workflowToolsExposed: boolean;
	providerMode?: PiBoxWorkMode;
	generation: number;
}

export interface WorkModeRuntimeController {
	snapshot(): WorkModeRuntimeSnapshot;
}

const RUNTIME_KEY = Symbol.for("pibox:work-mode-runtime");
type RuntimeGlobal = typeof globalThis & { [RUNTIME_KEY]?: { token: symbol; controller: WorkModeRuntimeController } };

function store(): RuntimeGlobal {
	return globalThis as RuntimeGlobal;
}

export function installWorkModeRuntime(controller: WorkModeRuntimeController): () => void {
	const token = Symbol("pibox-work-mode-activation");
	store()[RUNTIME_KEY] = { token, controller };
	return () => {
		if (store()[RUNTIME_KEY]?.token === token) delete store()[RUNTIME_KEY];
	};
}

export function currentWorkModeSnapshot(): WorkModeRuntimeSnapshot | undefined {
	return store()[RUNTIME_KEY]?.controller.snapshot();
}

export function currentWorkMode(): PiBoxWorkMode {
	return currentWorkModeSnapshot()?.mode ?? "agent";
}

export function workflowModeActive(): boolean {
	return currentWorkMode() === "workflow";
}

export function requireWorkflowMode(): void {
	if (!workflowModeActive()) throw new Error("PiBox Workflow mode is required. Select the Workflow icon in the interactive footer, then retry.");
}
