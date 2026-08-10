import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { DEFAULT_SPINNER_CONFIG } from "./config.js";
import { nextVerb } from "./verbs.js";

function duration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function responseCharacters(message: unknown): number {
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") return 0;
	const assistant = message as AssistantMessage;
	return assistant.content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
}

export default function spinners(pi: ExtensionAPI): void {
	const config = DEFAULT_SPINNER_CONFIG;
	let activeContext: ExtensionContext | undefined;
	let startedAt = 0;
	let characters = 0;
	let currentVerb = "Analyzing";
	let displayedVerb = currentVerb;
	let cycleTimer: ReturnType<typeof setInterval> | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let typeTimer: ReturnType<typeof setInterval> | undefined;

	const clearTimers = () => {
		if (cycleTimer) clearInterval(cycleTimer);
		if (statusTimer) clearInterval(statusTimer);
		if (typeTimer) clearInterval(typeTimer);
		cycleTimer = undefined;
		statusTimer = undefined;
		typeTimer = undefined;
	};

	const update = () => {
		const ctx = activeContext;
		if (!ctx || ctx.mode !== "tui" || startedAt === 0) return;
		const estimate = Math.round(characters / config.tokensPerCharacter);
		const detail = [duration(Date.now() - startedAt), ...(estimate > 0 ? [`≈${estimate.toLocaleString("en-US")} tokens`] : [])].join(" · ");
		ctx.ui.setWorkingMessage(
			`${ctx.ui.theme.fg("accent", `${displayedVerb}…`)}\n${ctx.ui.theme.fg("dim", "└─")} ${ctx.ui.theme.fg("dim", detail)}`,
		);
	};

	const animateVerb = (verb: string) => {
		if (typeTimer) clearInterval(typeTimer);
		if (!config.typewriter) {
			displayedVerb = verb;
			update();
			return;
		}
		let length = 1;
		displayedVerb = verb.slice(0, length);
		update();
		typeTimer = setInterval(() => {
			length++;
			displayedVerb = verb.slice(0, length);
			update();
			if (length >= verb.length && typeTimer) {
				clearInterval(typeTimer);
				typeTimer = undefined;
			}
		}, config.typewriterIntervalMs);
	};

	const stop = (restore = true) => {
		clearTimers();
		if (restore && activeContext?.mode === "tui") activeContext.ui.setWorkingMessage();
		activeContext = undefined;
		startedAt = 0;
		characters = 0;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({ frames: [...config.frames], intervalMs: config.frameIntervalMs });
		const key = getKeybindings().getKeys("app.thinking.toggle")[0] ?? "ctrl+t";
		ctx.ui.setHiddenThinkingLabel(`→ ${key} to show thinking`);
	});

	pi.on("agent_start", (_event, ctx) => {
		stop(false);
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		startedAt = Date.now();
		currentVerb = nextVerb("");
		animateVerb(currentVerb);
		cycleTimer = setInterval(() => {
			currentVerb = nextVerb(currentVerb);
			animateVerb(currentVerb);
		}, config.cycleIntervalMs);
		statusTimer = setInterval(update, config.statusIntervalMs);
	});

	pi.on("message_update", (event) => {
		characters = responseCharacters(event.message);
		update();
	});
	pi.on("agent_end", () => stop());
	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setHiddenThinkingLabel();
		}
	});
}
