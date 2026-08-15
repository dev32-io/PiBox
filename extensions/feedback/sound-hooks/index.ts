import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_FEEDBACK_EVENT, type WorkflowFeedbackEvent } from "../../workflow-runtime/api.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseSoundTheme,
	resolveSoundFile,
	RESPONSE_COMPLETE_EVENT,
	WORKFLOW_ERROR_EVENT,
	WORKFLOW_TASK_COMPLETED_EVENT,
	soundHooksConfig,
	type SoundTheme,
} from "./config.js";
import { playSound } from "./player.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function isSuccessfulAssistantStop(stopReason: string | undefined): boolean {
	return stopReason !== "aborted" && stopReason !== "error";
}

export function feedbackEventForWorkflow(event: WorkflowFeedbackEvent): typeof WORKFLOW_TASK_COMPLETED_EVENT | typeof WORKFLOW_ERROR_EVENT | undefined {
	if (event.type === "task-completed") return WORKFLOW_TASK_COMPLETED_EVENT;
	if (event.type === "error") return WORKFLOW_ERROR_EVENT;
	return undefined;
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
	let interactive = false;

	const playFeedback = (event: typeof RESPONSE_COMPLETE_EVENT | typeof WORKFLOW_TASK_COMPLETED_EVENT | typeof WORKFLOW_ERROR_EVENT) => {
		if (!interactive || !theme) return;
		const config = soundHooksConfig();
		if (!config.enabled || config.theme !== theme.id) return;
		const soundFile = resolveSoundFile(config.soundRoot, theme, event);
		if (!soundFile || !existsSync(soundFile)) return;
		playSound(soundFile);
	};

	pi.on("session_start", (_event, ctx) => {
		const config = soundHooksConfig();
		theme = config.enabled ? loadTheme(config.theme) : undefined;
		interactive = ctx.mode === "tui";
	});

	pi.on("agent_start", () => {
		completedSuccessfully = false;
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		completedSuccessfully = isSuccessfulAssistantStop(event.message.stopReason);
	});

	pi.on("agent_settled", () => {
		if (completedSuccessfully) playFeedback(RESPONSE_COMPLETE_EVENT);
	});

	pi.events.on(WORKFLOW_FEEDBACK_EVENT, (value: unknown) => {
		const feedbackEvent = feedbackEventForWorkflow(value as WorkflowFeedbackEvent);
		if (feedbackEvent) playFeedback(feedbackEvent);
	});

	pi.on("session_shutdown", () => {
		theme = undefined;
		interactive = false;
	});
}
