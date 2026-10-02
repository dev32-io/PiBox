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

function responseCharacters(message: AssistantMessage): number {
	return message.content.reduce((total, block) => {
		if (block.type === "text") return total + block.text.length;
		if (block.type === "thinking") return total + block.thinking.length;
		if (block.type === "toolCall") return total + JSON.stringify(block.arguments).length;
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
	averageTokensPerSecond?: number;
	cacheHitPercent?: number;
	cost?: number;
}

function tokenCount(value: number): string {
	return value.toLocaleString("en-US");
}

function roundUsage(messages: unknown[]): { cost?: number; cacheHitPercent?: number } {
	let cost = 0;
	let hasCost = false;
	let input = 0;
	let cacheRead = 0;
	for (const message of messages) {
		const assistant = assistantMessage(message);
		if (!assistant) continue;
		cost += assistant.usage?.cost.total ?? 0;
		hasCost ||= (assistant.usage?.cost.total ?? 0) > 0;
		input += (assistant.usage?.input ?? 0) + (assistant.usage?.cacheRead ?? 0) + (assistant.usage?.cacheWrite ?? 0);
		cacheRead += assistant.usage?.cacheRead ?? 0;
	}
	return { ...(hasCost ? { cost } : {}), ...(input > 0 ? { cacheHitPercent: cacheRead / input * 100 } : {}) };
}

export default function spinners(pi: ExtensionAPI): void {
	const config = DEFAULT_SPINNER_CONFIG;
	let lastCompletionWord = "";
	let activeContext: ExtensionContext | undefined;
	let startedAt = 0;
	let requestStartedAt: number | undefined;
	let completedDetail: string | undefined;
	let inputCharacters = 0;
	let inputBase = 0;
	let inputTarget = 0;
	let outputTarget = 0;
	let completedOutput = 0;
	let measuredOutputTokens = 0;
	let measuredRequestMs = 0;
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
		const elapsedMs = Math.max(0, requestStartedAt === undefined ? Date.now() - startedAt : performance.now() - requestStartedAt);
		// Count only messages emitted in this run, never history or provider full-context input.
		const input = Math.round(inputBase + (inputTarget - inputBase) * Math.min(1, elapsedMs / 1_200));
		const rate = outputTarget / Math.max(1, elapsedMs / 1_000);
		const detail = completedDetail ?? `${duration(elapsedMs)} · ↑ ${tokenCount(input)} · ↓ ${tokenCount(completedOutput + outputTarget)} · ${rate.toFixed(1)} tok/s`;
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
		requestStartedAt = undefined;
		completedDetail = undefined;
		inputCharacters = 0;
		inputBase = 0;
		inputTarget = 0;
		outputTarget = 0;
		completedOutput = 0;
		measuredOutputTokens = 0;
		measuredRequestMs = 0;
		hasLiveThinking = false;
	};

	pi.registerEntryRenderer<RoundSummary>("pibox-round-summary", (entry, _options, theme) => {
		const summary = entry.data;
		if (!summary) return undefined;
		const metrics = [`↑ ${tokenCount(summary.inputTokens)}`, `↓ ${tokenCount(summary.outputTokens)}`];
		if (summary.cacheHitPercent !== undefined) metrics.push(`cache ${Number(summary.cacheHitPercent.toFixed(2))}%`);
		if (summary.cost !== undefined) metrics.push(`$${summary.cost.toFixed(2)}`);
		if (summary.averageTokensPerSecond !== undefined) metrics.push(`${summary.averageTokensPerSecond.toFixed(1)} tok/s`);
		const text = `◒ ${summary.word} for ${duration(summary.durationMs)} · ${metrics.join(" · ")}`;
		return new Text(theme.fg("dim", text), 1, 0);
	});

	pi.on("session_start", (_event, ctx) => {
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
	pi.on("before_provider_request", () => {
		if (!activeContext) return;
		requestStartedAt = performance.now();
		completedDetail = undefined;
		inputBase = inputTarget;
		// ponytail: text-only chars/4 for the cosmetic ramp; model-aware counting needed for images.
		// Provider input usage includes replayed context, so never use it for this turn-local counter.
		inputTarget = Math.round(inputCharacters / 4);
		outputTarget = 0;
		update();
	});
	pi.on("message_end", (event) => {
		if (!activeContext) return;
		const message = event.message;
		if (message.role === "user" || message.role === "toolResult" || message.role === "custom") {
			const content = message.content;
			inputCharacters += typeof content === "string" ? content.length
				: content.reduce((total, block) => total + (block.type === "text" ? block.text.length : 0), 0);
			return;
		}
		const assistant = assistantMessage(message);
		if (!assistant) return;
		const elapsedMs = requestStartedAt === undefined ? undefined : Math.max(0, performance.now() - requestStartedAt);
		requestStartedAt = undefined;
		const usage = assistant.usage;
		const hasUsage = usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0;
		completedOutput += hasUsage ? usage.output : Math.round(responseCharacters(assistant) / 4);
		outputTarget = 0;
		const metrics = [duration(elapsedMs ?? Date.now() - startedAt), `↑ ${tokenCount(Math.round(inputCharacters / 4))}`, `↓ ${tokenCount(completedOutput)}`];
		// Zero-only usage also represents providers that did not report usage.
		if (hasUsage) {
			const input = usage.input + usage.cacheRead + usage.cacheWrite;
			if (input > 0) metrics.push(`cache ${Number((usage.cacheRead / input * 100).toFixed(2))}%`);
			if (elapsedMs !== undefined && elapsedMs > 0 && assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
				// End-to-end request throughput includes prefill/network time, never tool execution.
				metrics.push(`${(usage.output / (elapsedMs / 1_000)).toFixed(1)} tok/s`);
				measuredOutputTokens += usage.output;
				measuredRequestMs += elapsedMs;
			}
		}
		completedDetail = metrics.join(" · ");
		update();
	});
	pi.on("message_update", (event) => {
		if (!activeContext) return;
		const assistant = assistantMessage(event.message);
		if (assistant) outputTarget = Math.round(responseCharacters(assistant) / 4);
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
				inputTokens: Math.round(inputCharacters / 4),
				outputTokens: completedOutput,
				...(measuredRequestMs > 0 ? { averageTokensPerSecond: measuredOutputTokens / (measuredRequestMs / 1_000) } : {}),
			} satisfies RoundSummary);
		}
		stop();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stop();
		if (ctx.mode === "tui") {
			ctx.ui.setWorkingIndicator();
			ctx.ui.setHiddenThinkingLabel();
		}
	});
}
