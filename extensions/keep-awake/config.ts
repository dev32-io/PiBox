import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const KEEP_AWAKE_ENTRY_TYPE = "pibox-keep-awake";
export const DEFAULT_KEEP_AWAKE_ENABLED = true;

export function resolveKeepAwakeDefault(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_KEEP_AWAKE_ENABLED;
	const enabled = (value as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? enabled : DEFAULT_KEEP_AWAKE_ENABLED;
}

/** A machine-level preference: repository settings cannot override the user's default. */
export function loadKeepAwakeDefault(cwd: string, agentDir: string = getAgentDir()): boolean {
	try {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings() as { keepAwake?: unknown };
		return resolveKeepAwakeDefault(settings.keepAwake);
	} catch { return DEFAULT_KEEP_AWAKE_ENABLED; }
}

export function restoreKeepAwakeEnabled(ctx: ExtensionContext, defaultEnabled: boolean): boolean {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: { schemaVersion?: unknown; enabled?: unknown } };
		if (entry.type === "custom" && entry.customType === KEEP_AWAKE_ENTRY_TYPE
			&& entry.data?.schemaVersion === 1 && typeof entry.data.enabled === "boolean") return entry.data.enabled;
	}
	return defaultEnabled;
}
