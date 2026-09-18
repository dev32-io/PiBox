import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	MAX_SUBAGENT_DISPLAY_RECORD_BYTES,
	SUBAGENT_DISPLAY_ENV,
	type SubagentDisplayFrame,
} from "./display.js";

export const SUBAGENT_REPORT_PATH_ENV = "PIBOX_SUBAGENT_REPORT_PATH";
export const SUBAGENT_EVENT_FD_ENV = "PIBOX_SUBAGENT_EVENT_FD";
export const SUBAGENT_EVENT_FD = 3;
export const SUBAGENT_PROMPT_PATH_ENV = "PIBOX_SUBAGENT_PROMPT_PATH";
export const SUBAGENT_PROMPT_TOKEN = "pibox-subagent-user-prompt";

const MAX_DELTA_CHARACTERS = 16 * 1024;
const MAX_ERROR_CHARACTERS = 2 * 1024;
const MAX_TOOL_RESULT_BYTES = 4 * 1024;
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
	const displayEnabled = process.env[SUBAGENT_DISPLAY_ENV] === "1";

	const emit = (value: Readonly<Record<string, unknown>>): void => {
		try { writeChannel(configuredFd, value); }
		catch { /* Missing harness channel is detected by the parent lifecycle validator. */ }
	};
	const emitDisplay = (frame: SubagentDisplayFrame | undefined): void => {
		if (!displayEnabled || !frame) return;
		try { writeDisplayChannel(configuredFd, frame); }
		catch { /* Display is optional and must never affect worker execution. */ }
	};

	/* Rich handlers return before inspecting or serializing payloads when no observer was sampled. */
	pi.on("message_start", (event) => {
		if (!displayEnabled || event.message.role !== "assistant") return;
		emitDisplay({ type: "assistant_start" });
	});
	pi.on("tool_execution_start", (event) => {
		if (!displayEnabled) return;
		emitDisplay(toolStartFrame(event));
	});
	pi.on("tool_execution_end", (event) => {
		if (!displayEnabled) return;
		emitDisplay(toolEndFrame(event));
	});

	const emitCompact = (value: Readonly<Record<string, unknown>>): void => {
		emit(value);
	};

	pi.on("input", (event) => {
		if (event.text !== SUBAGENT_PROMPT_TOKEN) return { action: "continue" };
		try {
			const prompt = readFileSync(promptPath, "utf8");
			rmSync(promptPath, { force: true });
			return { action: "transform", text: prompt };
		} catch (error) {
			emitCompact({ type: "report_error", error: `user prompt sidecar: ${boundedError(error)}` });
			return { action: "handled" };
		}
	});

	pi.on("message_update", (event) => {
		const update = event.assistantMessageEvent as unknown as Record<string, unknown>;
		if (update.type !== "text_delta" || typeof update.delta !== "string" || !update.delta) return;
		emitCompact({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: update.delta.slice(0, MAX_DELTA_CHARACTERS) } });
	});
	pi.on("tool_execution_start", (event) => {
		emitCompact({ type: "tool_execution_start", toolName: safeToolName(event.toolName) });
	});
	pi.on("tool_execution_end", (event) => {
		emitCompact({ type: "tool_execution_end", toolName: safeToolName(event.toolName), isError: event.isError === true });
	});
	pi.on("turn_end", (event) => {
		const message = event.message as unknown as Record<string, unknown>;
		emitCompact({ type: "turn_end", message: { usage: compactUsage(message.usage) } });
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		const message = event.message as unknown as Record<string, unknown>;
		if (!Array.isArray(message.content)) {
			emitCompact({ type: "report_error", error: "assistant message content was not an array" });
			return;
		}
		const text = assistantText(message.content);
		try {
			await writeReportAtomically(reportPath, text);
			emitCompact({
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
			emitCompact({ type: "report_error", error: boundedError(error) });
		}
		emitDisplay({
			type: "assistant_end",
			...(typeof message.errorMessage === "string" ? { error: boundedUtf8(message.errorMessage, MAX_ERROR_CHARACTERS) } : {}),
		});
	});
	pi.on("agent_settled", () => { emitCompact({ type: "agent_settled" }); });
}

function writeChannel(fd: number, value: Readonly<Record<string, unknown>>): void {
	writeBuffer(fd, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
}

function writeDisplayChannel(fd: number, frame: SubagentDisplayFrame): void {
	let candidate = frame;
	let line = `${JSON.stringify({ type: "display", frame: candidate })}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_SUBAGENT_DISPLAY_RECORD_BYTES && candidate.type === "tool_end") {
		candidate = fitToolEnd(candidate);
		line = `${JSON.stringify({ type: "display", frame: candidate })}\n`;
	}
	if (Buffer.byteLength(line, "utf8") <= MAX_SUBAGENT_DISPLAY_RECORD_BYTES) writeBuffer(fd, Buffer.from(line, "utf8"));
}

function writeBuffer(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
}

function toolStartFrame(event: { toolCallId: string; toolName: string; args: unknown }): SubagentDisplayFrame | undefined {
	const toolCallId = boundedIdentifier(event.toolCallId, 128);
	const toolName = safeToolName(event.toolName);
	if (!toolCallId || !toolName) return undefined;
	return { type: "tool_start", toolCallId, toolName, ...safeToolArgs(toolName, event.args) };
}

function toolEndFrame(event: { toolCallId: string; toolName: string; result: unknown; isError?: boolean }): SubagentDisplayFrame | undefined {
	const toolCallId = boundedIdentifier(event.toolCallId, 128);
	const toolName = safeToolName(event.toolName);
	if (!toolCallId || !toolName) return undefined;
	const result = textResult(event.result);
	return { type: "tool_end", toolCallId, toolName, text: result.text, isError: event.isError === true, ...(result.truncated ? { truncated: true } : {}) };
}

const TOOL_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
	bash: ["command", "timeout"], read: ["path", "offset", "limit"], write: ["path", "content"],
	edit: ["path", "edits"], grep: ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"],
	find: ["pattern", "path", "limit"], ls: ["path", "limit"],
};

function safeToolArgs(toolName: string, value: unknown): Pick<Extract<SubagentDisplayFrame, { type: "tool_start" }>, "args" | "argsText" | "truncated"> {
	const keys = TOOL_ARG_KEYS[toolName];
	if (!keys || !value || typeof value !== "object" || Array.isArray(value)) return { argsText: "[unsupported arguments omitted]", truncated: true };
	const source = value as Record<string, unknown>;
	const allowed = new Set(keys);
	const args: Record<string, unknown> = {};
	let incomplete = false;
	for (const key of keys) {
		if (!(key in source)) continue;
		const sanitized = key === "edits" ? safeEdits(source[key]) : safeArgument(source[key], key === "command" || key === "content" ? 8 * 1024 : 2 * 1024);
		if (!sanitized.complete) incomplete = true;
		else args[key] = sanitized.value;
	}
	for (const key in source) {
		if (!allowed.has(key)) { incomplete = true; break; }
	}
	if (incomplete || Buffer.byteLength(JSON.stringify(args), "utf8") > 8 * 1024) return { argsText: "[arguments omitted: display limit]", truncated: true };
	return { args };
}

function safeArgument(value: unknown, maximumBytes: number): { complete: boolean; value?: unknown } {
	if (typeof value === "string") {
		const bounded = boundedUtf8(value, maximumBytes);
		return { complete: bounded === value, value: bounded };
	}
	if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return { complete: true, value };
	return { complete: false };
}

function safeEdits(value: unknown): { complete: boolean; value?: unknown } {
	if (!Array.isArray(value) || value.length > 4) return { complete: false };
	const edits: Record<string, string>[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return { complete: false };
		const edit = item as Record<string, unknown>;
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") return { complete: false };
		const oldText = boundedUtf8(edit.oldText, 2 * 1024);
		const newText = boundedUtf8(edit.newText, 2 * 1024);
		if (oldText !== edit.oldText || newText !== edit.newText) return { complete: false };
		edits.push({ oldText, newText });
	}
	return { complete: true, value: edits };
}

function textResult(value: unknown): { text: string; truncated: boolean } {
	const content = value && typeof value === "object" ? (value as Record<string, unknown>).content : undefined;
	const chunks: string[] = [];
	let bytes = 0;
	let truncated = false;
	const append = (text: string): void => {
		const separator = chunks.length > 0 ? 1 : 0;
		const remaining = MAX_TOOL_RESULT_BYTES - bytes - separator;
		if (remaining <= 0) { truncated = true; return; }
		const bounded = boundedUtf8(text, remaining);
		chunks.push(bounded);
		bytes += separator + Buffer.byteLength(bounded, "utf8");
		if (bounded !== text) truncated = true;
	};
	if (typeof content === "string") append(content);
	else if (Array.isArray(content)) {
		let index = 0;
		for (; index < content.length && index < 64 && bytes < MAX_TOOL_RESULT_BYTES; index += 1) {
			const part = content[index];
			if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string") append((part as Record<string, unknown>).text as string);
		}
		if (index < content.length) truncated = true;
	}
	return { text: chunks.join("\n"), truncated };
}

function fitToolEnd(frame: Extract<SubagentDisplayFrame, { type: "tool_end" }>): SubagentDisplayFrame {
	const points = Array.from(frame.text);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = { ...frame, text: points.slice(0, middle).join(""), truncated: true };
		if (Buffer.byteLength(JSON.stringify({ type: "display", frame: candidate }) + "\n", "utf8") <= MAX_SUBAGENT_DISPLAY_RECORD_BYTES) low = middle;
		else high = middle - 1;
	}
	return { ...frame, text: points.slice(0, low).join(""), truncated: true };
}

function boundedUtf8(value: string, maximumBytes: number): string {
	if (value.length <= maximumBytes && Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	const prefix = value.slice(0, maximumBytes);
	if (Buffer.byteLength(prefix, "utf8") <= maximumBytes) return prefix;
	let low = 0;
	let high = prefix.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(prefix.slice(0, middle), "utf8") <= maximumBytes) low = middle;
		else high = middle - 1;
	}
	while (low > 0 && /[\uD800-\uDBFF]/.test(prefix[low - 1]!)) low -= 1;
	return prefix.slice(0, low);
}

function boundedIdentifier(value: unknown, maximum: number): string | undefined {
	return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum) || undefined : undefined;
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
