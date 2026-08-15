import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

export const RESPONSE_COMPLETE_EVENT = "response-complete" as const;
export const WORKFLOW_TASK_COMPLETED_EVENT = "workflow-task-completed" as const;
export const WORKFLOW_ERROR_EVENT = "workflow-error" as const;
export const FEEDBACK_EVENTS = [RESPONSE_COMPLETE_EVENT, WORKFLOW_TASK_COMPLETED_EVENT, WORKFLOW_ERROR_EVENT] as const;
export type FeedbackEvent = typeof FEEDBACK_EVENTS[number];

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

	const sounds: Partial<Record<FeedbackEvent, string>> = {};
	for (const event of FEEDBACK_EVENTS) {
		const filename = value.sounds[event];
		if (filename !== undefined && typeof filename !== "string") return undefined;
		if (filename !== undefined) sounds[event] = filename;
	}

	return { schemaVersion: 1, id: value.id, label: value.label, sounds };
}

export function resolveSoundFile(root: string, theme: SoundTheme, event: FeedbackEvent): string | undefined {
	const filename = theme.sounds[event];
	if (!filename || isAbsolute(filename)) return undefined;

	const themeDirectory = resolve(root, theme.id);
	const candidate = resolve(themeDirectory, filename);
	if (candidate !== themeDirectory && !candidate.startsWith(`${themeDirectory}${sep}`)) return undefined;
	return candidate;
}
