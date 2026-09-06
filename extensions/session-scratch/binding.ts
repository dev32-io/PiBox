import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionScratchBinding } from "./types.js";

export const SESSION_SCRATCH_ENTRY_TYPE = "pibox-session-scratch-v1";

export interface ScratchEntry {
	schemaVersion: 1;
	binding: SessionScratchBinding | null;
}

function parseEntry(value: unknown): ScratchEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Partial<ScratchEntry>;
	if (candidate.schemaVersion !== 1) return undefined;
	if (candidate.binding === null) return { schemaVersion: 1, binding: null };
	const binding = candidate.binding as Partial<SessionScratchBinding> | undefined;
	if (!binding || typeof binding.workspaceId !== "string" || typeof binding.sessionId !== "string") return undefined;
	return { schemaVersion: 1, binding: { workspaceId: binding.workspaceId, sessionId: binding.sessionId } };
}

export function restoreScratchEntry(ctx: Pick<ExtensionContext, "sessionManager">): ScratchEntry {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== SESSION_SCRATCH_ENTRY_TYPE) continue;
		const parsed = parseEntry(entry.data);
		if (parsed) return parsed;
	}
	return { schemaVersion: 1, binding: null };
}

/** Inspect the current branch's binding without creating scratch or inheriting a fork's notes. */
export function currentSessionScratchBinding(ctx: Pick<ExtensionContext, "sessionManager">): SessionScratchBinding | undefined {
	const binding = restoreScratchEntry(ctx).binding;
	return binding?.sessionId === ctx.sessionManager.getSessionId() ? binding : undefined;
}
