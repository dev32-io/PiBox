import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
import { DEFAULT_SPINNER_CONFIG } from "./config.js";
import { nextVerb } from "./verbs.js";

function duration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function assistantMessage(message: unknown): AssistantMessage | undefined {
	if (typeof message !== "object" || message === null || !("role" in message) || message.role !== "assistant") return undefined;
	return message as AssistantMessage;
}

function responseCharacters(message: unknown): number {
	const assistant = assistantMessage(message);
	if (!assistant) return 0;
	return assistant.content.reduce((total, block) => {
		if (block.type === "text") return total + block.text.length;
		if (block.type === "thinking") return total + block.thinking.length;
		return total;
	}, 0);
}

function normalizeThinkingStatus(value: string): string {
	const text = value
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)/, "")
		.replace(/[*~]/g, "")
		.replace(/(?<=\w)_(?=\w)/g, " ")
		.replace(/_/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
}

function latestThinking(message: unknown): string | undefined {
	const assistant = assistantMessage(message);
	if (!assistant) return undefined;
	for (let index = assistant.content.length - 1; index >= 0; index--) {
		const block = assistant.content[index];
		if (block?.type === "thinking") {
			const lines = block.thinking.split(/\r?\n/);
			for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
				const line = lines[lineIndex];
				if (!line) continue;
				const text = normalizeThinkingStatus(line);
				if (text) return text;
			}
		}
	}
	return undefined;
}

function shimmer(value: string, phase: number, theme: Theme): string {
	const characters = [...value];
	const center = phase % (characters.length + 8) - 4;
	return characters.map((character, index) => {
		const distance = Math.abs(index - center);
		const colored = theme.fg("accent", character);
		if (distance <= 1) return theme.bold(colored);
		if (distance <= 3) return colored;
		return `\x1b[2m${colored}\x1b[22m`;
	}).join("");
}

// The provider does not stream request-token usage. Animate Pi's per-call
// context estimate during the request so the working row still communicates
// outbound progress before the first response token arrives.
const INPUT_ESTIMATE_ANIMATION_MS = 1_200;

const COMPLETION_WORDS = [
	"Cooked",
	"Brewed",
	"Crafted",
	"Forged",
	"Polished",
	"Synthesized",
	"Tinkered",
] as const;

interface RoundSummary {
	word: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	cost?: number;
}

function tokenCount(value: number): string {
	return value.toLocaleString("en-US");
}

function liveUsageDetail(startedAt: number, characters: number, inputEstimate: number, tokensPerCharacter: number): string {
	const elapsedMs = Math.max(0, Date.now() - startedAt);
	const outputTokens = Math.round(characters / tokensPerCharacter);
	if (outputTokens === 0) {
		const sent = Math.round(inputEstimate * Math.min(1, elapsedMs / INPUT_ESTIMATE_ANIMATION_MS));
		return `${duration(elapsedMs)}${inputEstimate > 0 ? ` · ↑ ${tokenCount(sent)}` : ""}`;
	}
	const rate = elapsedMs >= 1_000 ? ` (${(outputTokens / (elapsedMs / 1_000)).toFixed(1)} tok/s)` : "";
	return `${duration(elapsedMs)} · ↓ ${tokenCount(outputTokens)}${rate}`;
}

function roundUsage(messages: unknown[]): { inputTokens: number; outputTokens: number; cost?: number } {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost = 0;
	let hasCost = false;
	for (const message of messages) {
		const assistant = assistantMessage(message);
		if (!assistant) continue;
		inputTokens += assistant.usage?.input ?? 0;
		outputTokens += assistant.usage?.output ?? 0;
		cost += assistant.usage?.cost.total ?? 0;
		hasCost ||= (assistant.usage?.cost.total ?? 0) > 0;
	}
	return { inputTokens, outputTokens, ...(hasCost ? { cost } : {}) };
}

export default function spinners(pi: ExtensionAPI): void {
	const config = DEFAULT_SPINNER_CONFIG;
	let lastCompletionWord = "";
	let activeContext: ExtensionContext | undefined;
	let startedAt = 0;
	let requestStartedAt = 0;
	let inputEstimate = 0;
	let previousContextTokens: number | undefined;
	let previousContextSignature: string | undefined;
	let characters = 0;
	let currentMessage = "Analyzing";
	let hasLiveThinking = false;
	let shimmerPhase = 0;
	let cycleTimer: ReturnType<typeof setInterval> | undefined;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let shimmerTimer: ReturnType<typeof setInterval> | undefined;

	const clearTimers = () => {
		if (cycleTimer) clearInterval(cycleTimer);
		if (statusTimer) clearInterval(statusTimer);
		if (shimmerTimer) clearInterval(shimmerTimer);
		cycleTimer = undefined;
		statusTimer = undefined;
		shimmerTimer = undefined;
	};

	const update = () => {
		const ctx = activeContext;
		if (!ctx || ctx.mode !== "tui" || startedAt === 0) return;
		const detail = liveUsageDetail(requestStartedAt || startedAt, characters, inputEstimate, config.tokensPerCharacter);
		ctx.ui.setWorkingMessage(
			`${shimmer(currentMessage, shimmerPhase, ctx.ui.theme)}\n${ctx.ui.theme.fg("dim", "└─")} ${ctx.ui.theme.fg("dim", detail)}`,
		);
	};

	const nextCompletionWord = (): string => {
		const choices = COMPLETION_WORDS.filter((word) => word !== lastCompletionWord);
		lastCompletionWord = choices[Math.floor(Math.random() * choices.length)] ?? COMPLETION_WORDS[0];
		return lastCompletionWord;
	};

	const stop = (restore = true) => {
		clearTimers();
		if (restore && activeContext?.mode === "tui") activeContext.ui.setWorkingMessage();
		activeContext = undefined;
		startedAt = 0;
		requestStartedAt = 0;
		inputEstimate = 0;
		characters = 0;
		hasLiveThinking = false;
	};

	pi.registerEntryRenderer<RoundSummary>("pibox-round-summary", (entry, _options, theme) => {
		const summary = entry.data;
		if (!summary) return undefined;
		const metrics = [`↑ ${tokenCount(summary.inputTokens)}`, `↓ ${tokenCount(summary.outputTokens)}`, ...(summary.cost === undefined ? [] : [`$${summary.cost.toFixed(2)}`])];
		const text = `◒ ${summary.word} for ${duration(summary.durationMs)} · ${metrics.join(" · ")}`;
		return new Text(theme.fg("dim", text), 1, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		previousContextTokens = undefined;
		previousContextSignature = undefined;
		if (ctx.mode !== "tui") return;
		ctx.ui.setWorkingIndicator({
			frames: ["◒", "◐", "◓", "◑"].map((glyph) => ctx.ui.theme.fg("accent", glyph)),
			intervalMs: config.frameIntervalMs,
		});
		const key = getKeybindings().getKeys("app.thinking.toggle")[0] ?? "ctrl+t";
		ctx.ui.setHiddenThinkingLabel(`→ ${key} to show thinking`);
	});

	pi.on("agent_start", (_event, ctx) => {
		stop(false);
		if (ctx.mode !== "tui") return;
		activeContext = ctx;
		startedAt = Date.now();
		currentMessage = nextVerb("");
		shimmerPhase = 0;
		update();
		cycleTimer = setInterval(() => {
			if (hasLiveThinking) return;
			currentMessage = nextVerb(currentMessage);
			update();
		}, config.cycleIntervalMs);
		statusTimer = setInterval(update, config.statusIntervalMs);
		shimmerTimer = setInterval(() => {
			shimmerPhase++;
			update();
		}, config.frameIntervalMs);
	});

	pi.on("turn_start", () => {
		hasLiveThinking = false;
	});
	pi.on("context", (event, ctx) => {
		// This is presentation-only work. Headless agents must not inspect or retain
		// their context, and TUI sessions reuse Pi's existing token estimate instead
		// of serializing the complete message graph on every tool turn.
		if (!activeContext || ctx.mode !== "tui") return;
		const reportedTokens = ctx.getContextUsage()?.tokens;
		const tokens = typeof reportedTokens === "number" ? reportedTokens : undefined;
		const signature = `${event.messages.length}:${tokens ?? "unknown"}`;
		// Some providers build/inspect context more than once before sending. An
		// unchanged snapshot is not a new request and must not restart the meter.
		if (signature === previousContextSignature) return;
		inputEstimate = tokens === undefined || previousContextTokens === undefined ? 0 : Math.max(0, tokens - previousContextTokens);
		previousContextTokens = tokens;
		previousContextSignature = signature;
		requestStartedAt = Date.now();
		characters = 0;
		update();
	});
	pi.on("message_update", (event) => {
		characters = responseCharacters(event.message);
		const thinking = latestThinking(event.message);
		if (thinking) {
			hasLiveThinking = true;
			currentMessage = thinking;
		}
		update();
	});
	pi.on("agent_end", (event) => {
		if (startedAt > 0) {
			const usage = roundUsage(event.messages);
			pi.appendEntry("pibox-round-summary", {
				word: nextCompletionWord(),
				durationMs: Date.now() - startedAt,
				...usage,
			} satisfies RoundSummary);
		}
		stop();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		previousContextTokens = undefined;
		previousContextSignature = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setHiddenThinkingLabel();
		}
	});
}
