import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface SessionMetrics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost?: number;
	cacheHitPercent?: number;
	durationMs: number;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}

export function collectSessionMetrics(ctx: ExtensionContext, now = Date.now()): SessionMetrics {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let hasReportedCost = false;
	let firstTimestamp = now;

	for (const entry of ctx.sessionManager.getBranch()) {
		const timestamp = Date.parse(entry.timestamp);
		if (Number.isFinite(timestamp)) firstTimestamp = Math.min(firstTimestamp, timestamp);
		if (entry.type !== "message" || !isAssistantMessage(entry.message)) continue;
		const usage = entry.message.usage;
		input += usage.input;
		output += usage.output;
		cacheRead += usage.cacheRead;
		cacheWrite += usage.cacheWrite;
		cost += usage.cost.total;
		if (usage.cost.total > 0) hasReportedCost = true;
	}

	const cacheBase = input + cacheRead;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(hasReportedCost ? { cost } : {}),
		...(cacheBase > 0 ? { cacheHitPercent: (cacheRead / cacheBase) * 100 } : {}),
		durationMs: Math.max(0, now - firstTimestamp),
	};
}
