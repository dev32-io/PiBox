import { randomUUID } from "node:crypto";

const PROCESS_INSTANCE_KEY = Symbol.for("pibox:subagent-process-instance-id:v1");
type ProcessInstanceGlobal = typeof globalThis & { [PROCESS_INSTANCE_KEY]?: string };

/** Stable for this OS process and intentionally absent from persisted session state. */
export function getSubagentProcessInstanceId(): string {
	const root = globalThis as ProcessInstanceGlobal;
	return root[PROCESS_INSTANCE_KEY] ??= randomUUID();
}
