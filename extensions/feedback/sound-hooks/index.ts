import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_LIFECYCLE_EVENT, type WorkflowLifecycleEvent } from "../../workflow-runtime/api.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseSoundTheme,
	resolveSoundFile,
	RESPONSE_COMPLETE_EVENT,
	WORKFLOW_ERROR_EVENT,
	WORKFLOW_STAGE_COMPLETED_EVENT,
	soundHooksConfig,
	type SoundTheme,
} from "./config.js";
import { AudioArbiter, startSound, type AudioKind, type Playback } from "./player.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function isSuccessfulAssistantStop(stopReason: string | undefined): boolean {
	return stopReason !== "aborted" && stopReason !== "error";
}

export function feedbackEventForWorkflow(event: WorkflowLifecycleEvent): typeof WORKFLOW_STAGE_COMPLETED_EVENT | typeof WORKFLOW_ERROR_EVENT | undefined {
	if (event.type === "stage-completed") return WORKFLOW_STAGE_COMPLETED_EVENT;
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
	const arbiter = new AudioArbiter((kind: AudioKind): Playback | undefined => {
		if (!interactive || !theme) return undefined;
		const config = soundHooksConfig();
		if (!config.enabled || config.theme !== theme.id) return undefined;
		const event = kind === "response" ? RESPONSE_COMPLETE_EVENT : kind === "success" ? WORKFLOW_STAGE_COMPLETED_EVENT : WORKFLOW_ERROR_EVENT;
		const soundFile = resolveSoundFile(config.soundRoot, theme, event);
		if (!soundFile || !existsSync(soundFile)) return undefined;
		return startSound(soundFile, process.platform);
	}, { setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout) });

	const playFeedback = (event: typeof RESPONSE_COMPLETE_EVENT | typeof WORKFLOW_STAGE_COMPLETED_EVENT | typeof WORKFLOW_ERROR_EVENT, key?: string) => {
		const kind: AudioKind = event === RESPONSE_COMPLETE_EVENT ? "response" : event === WORKFLOW_STAGE_COMPLETED_EVENT ? "success" : "error";
		arbiter.request(kind, key ?? event);
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
		if (completedSuccessfully) playFeedback(RESPONSE_COMPLETE_EVENT, "turn");
	});

	pi.events.on(WORKFLOW_LIFECYCLE_EVENT, (value: unknown) => {
		const workflowEvent = value as WorkflowLifecycleEvent;
		const feedbackEvent = feedbackEventForWorkflow(workflowEvent);
		if (feedbackEvent) playFeedback(feedbackEvent, workflowEvent.correlationId ?? workflowEvent.workflowRef);
	});

	pi.on("session_shutdown", () => {
		arbiter.reset();
		theme = undefined;
		interactive = false;
	});
}
