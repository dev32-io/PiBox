import type { WorkflowExecutionControl } from "./api.js";

export type WorkflowRunnerRestorer = (controls: readonly WorkflowExecutionControl[]) => Promise<void>;

interface RestorerSlot { token: symbol; restore: WorkflowRunnerRestorer }
const RESTORER_KEY = Symbol.for("pibox:workflow-runner-restorer:v1");
type RestorerGlobal = typeof globalThis & { [RESTORER_KEY]?: RestorerSlot };

/** Process-global, replacement-safe handoff from first workflow demand to the activation-local runner UI. */
export function registerWorkflowRunnerRestorer(restore: WorkflowRunnerRestorer): () => void {
	const root = globalThis as RestorerGlobal; const token = Symbol("workflow-runner-restorer"); root[RESTORER_KEY] = { token, restore };
	return () => { if (root[RESTORER_KEY]?.token === token) delete root[RESTORER_KEY]; };
}

export async function requestWorkflowRunnerRestore(controls: readonly WorkflowExecutionControl[]): Promise<boolean> {
	if (!controls.length) return false; const slot = (globalThis as RestorerGlobal)[RESTORER_KEY]; if (!slot) return false;
	await slot.restore(controls); return true;
}
