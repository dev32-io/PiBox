import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export const RESPONSE_COMPLETE_EVENT = "response-complete" as const;
export type FeedbackEvent = typeof RESPONSE_COMPLETE_EVENT;

export interface SoundTheme {
	schemaVersion: 1;
	id: string;
	label: string;
	sounds: Partial<Record<FeedbackEvent, string>>;
}

export interface SoundHooksConfig {
	enabled: boolean;
	theme: string;
	soundRoot: string;
}

export const DEFAULT_SOUND_HOOKS_CONFIG: Readonly<SoundHooksConfig> = {
	enabled: true,
	theme: "eve-online",
	soundRoot: resolve(homedir(), ".pi", "agent", "pibox", "sounds"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function soundHooksConfig(env: NodeJS.ProcessEnv = process.env): SoundHooksConfig {
	return {
		enabled: env.PIBOX_SOUND_ENABLED !== "0" && env.PIBOX_SOUND_ENABLED !== "false",
		theme: env.PIBOX_SOUND_THEME?.trim() || DEFAULT_SOUND_HOOKS_CONFIG.theme,
		soundRoot: resolve(env.PIBOX_SOUND_ROOT?.trim() || DEFAULT_SOUND_HOOKS_CONFIG.soundRoot),
	};
}

export function parseSoundTheme(value: unknown): SoundTheme | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== "string" || typeof value.label !== "string") {
		return undefined;
	}
	if (!isRecord(value.sounds)) return undefined;

	const responseComplete = value.sounds[RESPONSE_COMPLETE_EVENT];
	if (responseComplete !== undefined && typeof responseComplete !== "string") return undefined;

	return {
		schemaVersion: 1,
		id: value.id,
		label: value.label,
		sounds: responseComplete === undefined ? {} : { [RESPONSE_COMPLETE_EVENT]: responseComplete },
	};
}

export function resolveSoundFile(root: string, theme: SoundTheme, event: FeedbackEvent): string | undefined {
	const filename = theme.sounds[event];
	if (!filename || isAbsolute(filename)) return undefined;

	const themeDirectory = resolve(root, theme.id);
	const candidate = resolve(themeDirectory, filename);
	if (candidate !== themeDirectory && !candidate.startsWith(`${themeDirectory}${sep}`)) return undefined;
	return candidate;
}
