#!/usr/bin/env node
import { connect } from "node:net";
import { pathToFileURL } from "node:url";

export const MAX_FRAME_BYTES = 16 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function sanitizeTerminalText(value, limit = MAX_FRAME_BYTES) {
	let text = typeof value === "string" ? value : "";
	text = text.replace(CONTROL_CHARACTERS, "").replace(/\r/g, "");
	while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
	return text;
}

function finiteToken(value) { return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined; }
function singleLine(value, limit) { return sanitizeTerminalText(value, limit).replace(/[\n\t]/g, " "); }
function safeObject(value, depth = 0) {
	if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
	if (typeof value === "string") return sanitizeTerminalText(value);
	if (depth >= 8) return "…";
	if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeObject(item, depth + 1));
	if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const result = {};
	for (const [key, item] of Object.entries(value).slice(0, 100)) result[singleLine(key, 256)] = safeObject(item, depth + 1);
	return result;
}

export function normalizeFrame(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.type !== "string") return undefined;
	if (value.type === "close") return { type: "close" };
	if (value.type === "init" && typeof value.title === "string") return { type: "init", title: singleLine(value.title, 4096), ...(typeof value.cwd === "string" ? { cwd: singleLine(value.cwd, 4096) } : {}), ...(typeof value.limited === "boolean" ? { limited: value.limited } : {}) };
	if (value.type === "usage") return { type: "usage", inputTokens: finiteToken(value.inputTokens), outputTokens: finiteToken(value.outputTokens) };
	if (["text", "status", "notice"].includes(value.type) && typeof value.text === "string") return { type: value.type, text: sanitizeTerminalText(value.text) };
	if (value.type !== "display" || !value.frame || typeof value.frame !== "object") return undefined;
	const frame = value.frame;
	if (["display_ready", "assistant_start"].includes(frame.type)) return { type: "display", frame: { type: frame.type } };
	if (frame.type === "assistant_end") return { type: "display", frame: { type: frame.type, ...(typeof frame.error === "string" ? { error: sanitizeTerminalText(frame.error) } : {}) } };
	if (frame.type === "tool_start" && typeof frame.toolCallId === "string" && typeof frame.toolName === "string") return { type: "display", frame: {
		type: frame.type, toolCallId: singleLine(frame.toolCallId, 1024), toolName: singleLine(frame.toolName, 1024),
		...(frame.args && typeof frame.args === "object" && !Array.isArray(frame.args) ? { args: safeObject(frame.args) } : {}),
		...(typeof frame.argsText === "string" ? { argsText: sanitizeTerminalText(frame.argsText) } : {}), ...(frame.truncated === true ? { truncated: true } : {}),
	} };
	if (frame.type === "tool_end" && typeof frame.toolCallId === "string" && typeof frame.toolName === "string" && typeof frame.text === "string" && typeof frame.isError === "boolean") return { type: "display", frame: {
		type: frame.type, toolCallId: singleLine(frame.toolCallId, 1024), toolName: singleLine(frame.toolName, 1024), text: sanitizeTerminalText(frame.text), isError: frame.isError, ...(frame.truncated === true ? { truncated: true } : {}),
	} };
	return undefined;
}

export class FrameDecoder {
	constructor(onFrame, onError) { this.onFrame = onFrame; this.onError = onError; this.input = Buffer.alloc(0); this.failed = false; }
	push(chunk) {
		if (this.failed) return;
		if (this.input.length + chunk.length > 128 * 1024) return this.fail();
		this.input = Buffer.concat([this.input, chunk]); this.resume();
	}
	resume() {
		while (!this.failed) {
			const end = this.input.indexOf(10); if (end < 0) break;
			if (end > MAX_FRAME_BYTES) return this.fail();
			const line = this.input.subarray(0, end).toString("utf8"); this.input = this.input.subarray(end + 1);
			let parsed; try { parsed = JSON.parse(line); } catch { return this.fail(); }
			const frame = normalizeFrame(parsed); if (!frame) return this.fail();
			if (this.onFrame(frame) === false) return;
		}
		if (this.input.length > MAX_FRAME_BYTES) this.fail();
	}
	fail() { if (this.failed) return; this.failed = true; this.input = Buffer.alloc(0); this.onError(); }
}

export function plainFrameText(frame) {
	if (frame.type === "text") return frame.text;
	if (frame.type === "notice" || frame.type === "status") return `${frame.text}\n`;
	if (frame.type !== "display") return "";
	const event = frame.frame;
	if (event.type === "assistant_end" && event.error) return `\nError: ${event.error}\n`;
	if (event.type === "tool_start") return `\n[tool] ${event.toolName}${event.argsText ? `\n${event.argsText}` : event.args ? `\n${JSON.stringify(event.args, null, 2)}` : ""}\n`;
	if (event.type === "tool_end") return `${event.isError ? "Error: " : ""}${event.text}${event.truncated ? "\n… (truncated)" : ""}\n`;
	return "";
}

export async function runViewer(socketPath, token) {
	if (!socketPath || !token) return 2;
	const native = process.stdout.isTTY && process.stdin.isTTY ? (await import("./renderer.mjs")).createNativeViewer() : undefined;
	const socket = connect(socketPath);
	let closing = false; let blocked = false; let exited = false; let nativeStarted = false;
	const stop = () => { if (exited) return; exited = true; if (nativeStarted) native?.stop(); socket.destroy(); };
	const write = (text) => {
		if (!text || native) return;
		if (!process.stdout.write(text)) { blocked = true; socket.pause(); }
	};
	const decoder = new FrameDecoder((frame) => {
		if (frame.type === "close" && !closing) {
			closing = true; if (nativeStarted) native?.flush();
			process.stdout.write("", () => socket.end(`${JSON.stringify({ type: "drained" })}\n`));
			return false;
		}
		native?.apply(frame);
		if (native && !nativeStarted) { native.start(); nativeStarted = true; }
		write(plainFrameText(frame));
		return !blocked;
	}, () => socket.destroy());
	socket.on("connect", () => { socket.write(`${JSON.stringify({ type: "hello", token })}\n`); });
	socket.on("data", (chunk) => { decoder.push(chunk); });
	process.stdout.on("drain", () => { blocked = false; decoder.resume(); if (!decoder.failed && !blocked) socket.resume(); });
	socket.on("error", stop); socket.on("close", stop);
	process.once("SIGTERM", stop); process.once("SIGINT", stop);
	return 0;
}

const main = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main) {
	const code = await runViewer(...process.argv.slice(2));
	if (code) process.exit(code);
}
