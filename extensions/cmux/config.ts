import { getAgentDir, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CMUX_PANES_ENTRY_TYPE = "pibox-cmux-panes";
export const DEFAULT_CMUX_PANES_ENABLED = true;

export function resolveCmuxPanesDefault(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_CMUX_PANES_ENABLED;
	const enabled = (value as { enabled?: unknown }).enabled;
	return typeof enabled === "boolean" ? enabled : DEFAULT_CMUX_PANES_ENABLED;
}

/** Machine-level preference: repository settings cannot override user's default. */
export function loadCmuxPanesDefault(cwd: string, agentDir: string = getAgentDir()): boolean {
	try {
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getGlobalSettings() as { cmuxPanes?: unknown };
		return resolveCmuxPanesDefault(settings.cmuxPanes);
	} catch { return DEFAULT_CMUX_PANES_ENABLED; }
}

export function restoreCmuxPanesEnabled(ctx: ExtensionContext, defaultEnabled: boolean): boolean {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: string; customType?: string; data?: { schemaVersion?: unknown; enabled?: unknown } };
		if (entry.type === "custom" && entry.customType === CMUX_PANES_ENTRY_TYPE
			&& entry.data?.schemaVersion === 1 && typeof entry.data.enabled === "boolean") return entry.data.enabled;
	}
	return defaultEnabled;
}
