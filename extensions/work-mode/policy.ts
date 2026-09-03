import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const WORK_MODES = ["agent", "orchestrator", "workflow", "designer"] as const;
export type PiBoxWorkMode = (typeof WORK_MODES)[number];

export const WORK_MODE_ICONS: Record<PiBoxWorkMode, string> = {
	agent: "",
	orchestrator: "󰒪",
	workflow: "󱄗",
	designer: "󰏘",
};
export const DEFAULT_WORK_MODE: PiBoxWorkMode = "agent";
export const WORK_MODE_ENTRY_TYPE = "pibox-work-mode-v1";
export const WORK_MODE_STATUS_KEY = "pibox-work-mode";
export const WORK_MODE_EVENT = "pibox:work-mode";

export interface WorkModeEntry {
	schemaVersion: 1;
	mode: PiBoxWorkMode;
	workflowToolsExposed: boolean;
	/** Mode used for the latest provider request; absent before the first request. */
	providerMode?: PiBoxWorkMode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isWorkMode(value: unknown): value is PiBoxWorkMode {
	return typeof value === "string" && (WORK_MODES as readonly string[]).includes(value);
}

export function parseWorkModeEntry(value: unknown): WorkModeEntry | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isWorkMode(value.mode) || typeof value.workflowToolsExposed !== "boolean") return undefined;
	if (value.providerMode !== undefined && !isWorkMode(value.providerMode)) return undefined;
	return {
		schemaVersion: 1,
		mode: value.mode,
		workflowToolsExposed: value.workflowToolsExposed,
		...(isWorkMode(value.providerMode) ? { providerMode: value.providerMode } : {}),
	};
}

export function restoreWorkMode(ctx: Pick<ExtensionContext, "sessionManager">): WorkModeEntry {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== WORK_MODE_ENTRY_TYPE) continue;
		const parsed = parseWorkModeEntry(entry.data);
		if (parsed) return parsed;
	}
	return { schemaVersion: 1, mode: DEFAULT_WORK_MODE, workflowToolsExposed: false };
}

export function requestedStartupMode(pi: Pick<ExtensionAPI, "getFlag">): PiBoxWorkMode | undefined {
	const requested = pi.getFlag("work-mode");
	if (typeof requested === "string" && requested.trim()) {
		const normalized = requested.trim().toLowerCase();
		if (!isWorkMode(normalized)) throw new Error(`Unknown PiBox mode \"${requested}\". Available modes: ${WORK_MODES.join(", ")}`);
		return normalized;
	}
	const legacy = pi.getFlag("profile");
	if (typeof legacy !== "string" || !legacy.trim()) return undefined;
	const normalized = legacy.trim().toLowerCase();
	if (normalized === "default") return "agent";
	if (normalized === "designer") return "designer";
	throw new Error(`Unknown deprecated PiBox profile \"${legacy}\". Use --work-mode with one of: ${WORK_MODES.join(", ")}`);
}

export function branchHasProviderHistory(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	return entries.some((entry: any) => {
		if (entry?.type === "compaction" || entry?.type === "branch_summary") return true;
		return entry?.type === "message" && entry?.message?.role === "assistant";
	});
}

export function serializeWorkModeStatus(mode: PiBoxWorkMode): string {
	return `mode:${mode}`;
}

export function parseWorkModeStatus(value: string | undefined): PiBoxWorkMode | undefined {
	if (!value?.startsWith("mode:")) return undefined;
	const mode = value.slice("mode:".length);
	return isWorkMode(mode) ? mode : undefined;
}

export function workModeLabel(mode: PiBoxWorkMode): string {
	return `${mode[0]!.toUpperCase()}${mode.slice(1)}`;
}
