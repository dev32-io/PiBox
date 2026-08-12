import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseSoundTheme,
	resolveSoundFile,
	RESPONSE_COMPLETE_EVENT,
	soundHooksConfig,
	type SoundTheme,
} from "./config.js";
import { playSound } from "./player.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function isSuccessfulAssistantStop(stopReason: string | undefined): boolean {
	return stopReason !== "aborted" && stopReason !== "error";
}

function loadTheme(themeId: string): SoundTheme | undefined {
	const manifestPath = resolve(PACKAGE_ROOT, "sound-themes", `${themeId}.json`);
	try {
		return parseSoundTheme(JSON.parse(readFileSync(manifestPath, "utf8")));
	} catch {
		return undefined;
	}
}

export default function soundHooks(pi: ExtensionAPI): void {
	let theme: SoundTheme | undefined;
	let completedSuccessfully = false;

	pi.on("session_start", () => {
		const config = soundHooksConfig();
		theme = config.enabled ? loadTheme(config.theme) : undefined;
	});

	pi.on("agent_start", () => {
		completedSuccessfully = false;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		completedSuccessfully = isSuccessfulAssistantStop(event.message.stopReason);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || !theme || !completedSuccessfully) return;
		const config = soundHooksConfig();
		if (!config.enabled || config.theme !== theme.id) return;
		const soundFile = resolveSoundFile(config.soundRoot, theme, RESPONSE_COMPLETE_EVENT);
		if (!soundFile || !existsSync(soundFile)) return;
		playSound(soundFile);
	});

	pi.on("session_shutdown", () => {
		theme = undefined;
	});
}
