import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_REPORT_PATH_ENV = "PIBOX_SUBAGENT_REPORT_PATH";
export const SUBAGENT_EVENT_FD_ENV = "PIBOX_SUBAGENT_EVENT_FD";
export const SUBAGENT_EVENT_FD = 3;
export const SUBAGENT_PROMPT_PATH_ENV = "PIBOX_SUBAGENT_PROMPT_PATH";
export const SUBAGENT_PROMPT_TOKEN = "pibox-subagent-user-prompt";

const MAX_DELTA_CHARACTERS = 16 * 1024;
const MAX_ERROR_CHARACTERS = 2 * 1024;
let temporarySequence = 0;

/**
 * Child-only bridge: restores the exact file-backed user prompt, keeps large
 * native JSON events on stdout, and publishes bounded lifecycle records on fd 3.
 */
export default function subagentReportBridge(pi: ExtensionAPI): void {
	const reportPath = process.env[SUBAGENT_REPORT_PATH_ENV];
	const promptPath = process.env[SUBAGENT_PROMPT_PATH_ENV];
	const configuredFd = Number(process.env[SUBAGENT_EVENT_FD_ENV]);
	if (!reportPath || !promptPath || configuredFd !== SUBAGENT_EVENT_FD) return;

	const emit = (value: Readonly<Record<string, unknown>>): void => {
		try { writeChannel(configuredFd, value); }
		catch { /* Missing harness channel is detected by the parent lifecycle validator. */ }
	};

	pi.on("input", (event) => {
		if (event.text !== SUBAGENT_PROMPT_TOKEN) return { action: "continue" };
		try {
			const prompt = readFileSync(promptPath, "utf8");
			rmSync(promptPath, { force: true });
			return { action: "transform", text: prompt };
		} catch (error) {
			emit({ type: "report_error", error: `user prompt sidecar: ${boundedError(error)}` });
			return { action: "handled" };
		}
	});

	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
		if (update.type !== "text_delta" || typeof update.delta !== "string" || !update.delta) return;
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: update.delta.slice(0, MAX_DELTA_CHARACTERS) } });
	});
	pi.on("tool_execution_start", (event) => {
		emit({ type: "tool_execution_start", toolName: safeToolName(event.toolName) });
	});
	pi.on("tool_execution_end", (event) => {
		emit({ type: "tool_execution_end", toolName: safeToolName(event.toolName), isError: event.isError === true });
	});
	pi.on("turn_end", (event) => {
		const message = event.message as unknown as Record<string, unknown>;
		emit({ type: "turn_end", message: { usage: compactUsage(message.usage) } });
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as unknown as Record<string, unknown>;
		if (!Array.isArray(message.content)) {
			emit({ type: "report_error", error: "assistant message content was not an array" });
			return;
		}
		const text = assistantText(message.content);
		try {
			await writeReportAtomically(reportPath, text);
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
					...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage.slice(0, MAX_ERROR_CHARACTERS) } : {}),
				},
				report: {
					bytes: Buffer.byteLength(text, "utf8"),
					sha256: createHash("sha256").update(text, "utf8").digest("hex"),
				},
			});
		} catch (error) {
			emit({ type: "report_error", error: boundedError(error) });
		}
	});
	pi.on("agent_settled", () => { emit({ type: "agent_settled" }); });
}

function writeChannel(fd: number, value: Readonly<Record<string, unknown>>): void {
	const line = `${JSON.stringify(value)}\n`;
	let offset = 0;
	const buffer = Buffer.from(line, "utf8");
	while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

async function writeReportAtomically(path: string, text: string): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${++temporarySequence}`;
	try {
		await writeFile(temporary, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await chmod(temporary, 0o600);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

function assistantText(content: unknown[]): string {
	return content.flatMap((part) => {
		if (!part || typeof part !== "object") return [];
		const value = part as Record<string, unknown>;
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("\n");
}

function compactUsage(value: unknown): Readonly<Record<string, number>> {
	if (!value || typeof value !== "object") return {};
	const usage = value as Record<string, unknown>;
	return Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite", "totalTokens"]
		.flatMap((key) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? [[key, usage[key] as number] as const] : []));
}

function safeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.replace(/[^a-zA-Z0-9_.:-]/g, "").slice(0, 32) || undefined;
}

function boundedError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_CHARACTERS);
}
