import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MODEL_TIER_PROFILE,
	loadModelTierListProfiles,
	type ModelTierListProfilesConfig,
} from "./profiles.js";
import {
	MODEL_TIER_PROFILE_ENTRY_TYPE,
	MODEL_TIER_PROFILE_EVENT,
	MODEL_TIER_PROFILE_STATUS_KEY,
	normalizeModelTierProfilePolicy,
	serializeModelTierProfileStatus,
} from "./policy.js";

export interface ModelTierListProfilesSettings {
	defaultProfile?: string;
}

export function loadGlobalModelTierProfile(cwd: string): string | undefined {
	try {
		const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false }).getGlobalSettings() as {
			modelTierListProfiles?: ModelTierListProfilesSettings;
		};
		const profile = settings.modelTierListProfiles?.defaultProfile;
		return typeof profile === "string" && profile.trim() ? profile.trim() : undefined;
	} catch {
		return undefined;
	}
}

export function restoreModelTierProfile(ctx: Pick<ExtensionContext, "sessionManager">, profiles: ModelTierListProfilesConfig, configuredDefault?: string): string {
	const entries = ctx.sessionManager.getBranch();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== MODEL_TIER_PROFILE_ENTRY_TYPE) continue;
		const restored = normalizeModelTierProfilePolicy(entry.data);
		if (restored && profiles.profiles[restored.profile]) return restored.profile;
	}
	if (configuredDefault && profiles.profiles[configuredDefault]) return configuredDefault;
	return profiles.profiles[profiles.defaultProfile] ? profiles.defaultProfile : DEFAULT_MODEL_TIER_PROFILE;
}

export default function modelTierListProfiles(
	pi: ExtensionAPI,
	loadProfiles: (cwd: string, includeProject: boolean) => ModelTierListProfilesConfig = (cwd, includeProject) => loadModelTierListProfiles(cwd, { includeProject }),
	loadDefault: (cwd: string) => string | undefined = loadGlobalModelTierProfile,
): void {
	let config: ModelTierListProfilesConfig | undefined;
	let activeProfile = DEFAULT_MODEL_TIER_PROFILE;
	let sessionCtx: ExtensionContext | undefined;

	const publish = (persist: boolean) => {
		pi.events.emit(MODEL_TIER_PROFILE_EVENT, { profile: activeProfile });
		if (persist) pi.appendEntry(MODEL_TIER_PROFILE_ENTRY_TYPE, { profile: activeProfile });
		if (sessionCtx?.hasUI) sessionCtx.ui.setStatus(MODEL_TIER_PROFILE_STATUS_KEY, serializeModelTierProfileStatus({ profile: activeProfile }));
	};

	const restore = (ctx: ExtensionContext) => {
		sessionCtx = ctx;
		config = loadProfiles(ctx.cwd, ctx.isProjectTrusted());
		activeProfile = restoreModelTierProfile(ctx, config, loadDefault(ctx.cwd));
		publish(false);
	};

	const selectProfile = (profile: string, ctx: ExtensionContext) => {
		if (!config?.profiles[profile]) {
			ctx.ui.notify(`Unknown tier profile: ${profile}. Available: ${Object.keys(config?.profiles ?? {}).join(", ")}`, "error");
			return;
		}
		if (profile === activeProfile) {
			ctx.ui.notify(`Tier profile: ${profile}`, "info");
			return;
		}
		activeProfile = profile;
		publish(true);
		ctx.ui.notify(`Tier profile: ${profile}`, "info");
	};

	pi.registerCommand("tier-profile", {
		description: "Switch the session-scoped managed-agent model tier profile",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = Object.keys(config?.profiles ?? {}).sort().filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested) {
				selectProfile(requested, ctx);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Usage: /tier-profile <${Object.keys(config?.profiles ?? {}).join("|")}>`, "error");
				return;
			}
			const names = Object.keys(config?.profiles ?? {}).sort();
			const selected = await ctx.ui.select("Tier profile", names.map((name) => name === activeProfile ? `${name} (active)` : name));
			if (!selected) return;
			selectProfile(selected.replace(/ \(active\)$/, ""), ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			restore(ctx);
		} catch (error) {
			config = undefined;
			activeProfile = DEFAULT_MODEL_TIER_PROFILE;
			ctx.ui.notify(`Tier profile configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			publish(false);
		}
	});
	pi.on("session_tree", (_event, ctx) => {
		try { restore(ctx); }
		catch (error) { ctx.ui.notify(`Tier profile configuration failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(MODEL_TIER_PROFILE_STATUS_KEY, undefined);
		sessionCtx = undefined;
		config = undefined;
		activeProfile = DEFAULT_MODEL_TIER_PROFILE;
	});
}
