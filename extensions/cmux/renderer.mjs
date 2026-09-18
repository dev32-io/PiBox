import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { ProcessTerminal, ScrollView, Text, TuiAltScreen, VStack, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const MAX_BLOCKS = 128;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const REDRAW_MS = 100;
const SAFE_NATIVE_TOOLS = new Map([
	["read", createReadToolDefinition], ["bash", createBashToolDefinition], ["grep", createGrepToolDefinition],
	["find", createFindToolDefinition], ["ls", createLsToolDefinition], ["write", createWriteToolDefinition],
]);
const OMITTED_TEXT = "… Earlier output omitted to keep viewer history bounded.";

initTheme(undefined, false);

export function formatTokens(value) {
	if (!Number.isFinite(value) || value < 0) return "—";
	if (value < 1_000) return String(Math.floor(value));
	const units = [[1_000_000_000, "B"], [1_000_000, "M"], [1_000, "k"]];
	const [size, suffix] = units.find(([size]) => value >= size);
	const scaled = value / size;
	return `${scaled >= 100 || Number.isInteger(scaled) ? Math.floor(scaled) : scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`;
}

export class Header {
	constructor() { this.title = "cmux viewer"; this.inputTokens = undefined; this.outputTokens = undefined; }
	setTitle(title) { this.title = String(title || "cmux viewer").replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " "); }
	setUsage(inputTokens, outputTokens) { this.inputTokens = inputTokens; this.outputTokens = outputTokens; }
	render(width) {
		if (width <= 0) return [""];
		const usage = `↑ ${formatTokens(this.inputTokens)} ↓ ${formatTokens(this.outputTokens)}`;
		let line = truncateToWidth(usage, width, "");
		if (visibleWidth(usage) < width) {
			const room = width - visibleWidth(usage) - 1;
			const title = truncateToWidth(this.title, room, room > 1 ? "…" : "");
			line = `${title}${" ".repeat(Math.max(0, room - visibleWidth(title)))} ${usage}`;
		}
		// Bold inverse video gives a full-row background using the terminal's own colors.
		return [`\x1b[1;7m${line}\x1b[0m`];
	}
	invalidate() {}
}

function assistantMessage(text, done, error) {
	return {
		role: "assistant", content: [{ type: "text", text }], api: "cmux", provider: "cmux", model: "viewer",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: error ? "error" : done ? "stop" : undefined, ...(error ? { errorMessage: error } : {}), timestamp: 0,
	};
}

function hasValidNativeArgs(name, args) {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	if (name === "bash") return typeof args.command === "string";
	if (name === "read") return typeof (args.path ?? args.file_path) === "string";
	if (name === "grep" || name === "find") return typeof args.pattern === "string";
	if (name === "write") return typeof (args.path ?? args.file_path) === "string" && typeof args.content === "string";
	return name === "ls";
}

function toolDefinition(name, argsText) {
	return {
		name, label: name, description: "", parameters: {},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold(name)) + (argsText ? `\n${theme.fg("toolOutput", argsText)}` : ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content.find((item) => item.type === "text")?.text ?? "";
			return new Text(theme.fg(text.startsWith("Error:") ? "error" : "toolOutput", text), 0, 0);
		},
	};
}

class NativeBlock {
	constructor(kind, data, ui, cwd) { this.kind = kind; this.data = data; this.ui = ui; this.cwd = cwd; this.component = undefined; this.dirty = true; this.done = false; this.cachedWidth = undefined; this.cachedLines = undefined; }
	invalidate() { this.cachedWidth = undefined; this.cachedLines = undefined; this.component?.invalidate(); }
	render(width) {
		if (!this.component) {
			if (this.kind === "assistant") this.component = new AssistantMessageComponent(undefined, true, undefined, undefined, 1);
			else if (this.kind === "tool") {
				const renderer = this.data.native ? SAFE_NATIVE_TOOLS.get(this.data.name)(this.cwd) : toolDefinition(this.data.name, this.data.argsText);
				this.component = new ToolExecutionComponent(this.data.name, this.data.id, this.data.args, { showImages: false }, renderer, this.ui, this.cwd);
				this.component.markExecutionStarted();
			}
			else this.component = new Text(this.data.text, 1, 0);
		}
		if (this.dirty) {
			if (this.kind === "assistant") this.component.updateContent(assistantMessage(this.data.text, this.done, this.data.error), !this.done);
			else if (this.kind === "tool" && this.data.result !== undefined) {
				this.component.updateResult({ content: [{ type: "text", text: `${this.data.isError ? "Error: " : ""}${this.data.result}` }], isError: this.data.isError }, false);
				this.component.setExpanded(true);
			}
			this.dirty = false; this.cachedWidth = undefined; this.cachedLines = undefined;
		}
		if (!this.done) return this.component.render(width);
		if (this.cachedWidth !== width) { this.cachedWidth = width; this.cachedLines = this.component.render(width); }
		return this.cachedLines;
	}
}

const bytes = (text) => Buffer.byteLength(text ?? "", "utf8");
function tailBytes(text, limit) {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= limit) return text;
	let start = buffer.length - limit;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

export class Transcript {
	constructor(requestRender = () => {}, cwd = process.cwd()) { this.blocks = []; this.tools = new Map(); this.current = undefined; this.omission = undefined; this.totalBytes = 0; this.requestRender = requestRender; this.cwd = cwd; }
	add(kind, data, textBytes = 0) {
		const block = new NativeBlock(kind, data, { requestRender() {} }, this.cwd);
		block.textBytes = textBytes; this.blocks.push(block); this.totalBytes += textBytes; this.trim(); return block;
	}
	remove(block) {
		const index = this.blocks.indexOf(block); if (index < 0) return;
		this.blocks.splice(index, 1); this.totalBytes -= block.textBytes;
		if (this.current === block) this.current = undefined;
		for (const [id, value] of this.tools) if (value === block) this.tools.delete(id);
	}
	markOmitted() {
		if (this.omission) return;
		this.omission = new NativeBlock("notice", { text: OMITTED_TEXT }, { requestRender() {} }, this.cwd);
		this.omission.done = true; this.omission.textBytes = bytes(OMITTED_TEXT);
		this.blocks.unshift(this.omission); this.totalBytes += this.omission.textBytes;
	}
	trim() {
		if (this.blocks.length <= MAX_BLOCKS && this.totalBytes <= MAX_TEXT_BYTES) return;
		this.markOmitted();
		while (this.blocks.length > MAX_BLOCKS) this.remove(this.blocks.find((block) => block !== this.omission && block !== this.current) ?? this.blocks.find((block) => block !== this.omission));
		while (this.totalBytes > MAX_TEXT_BYTES) {
			const removable = this.blocks.find((block) => block !== this.omission && block !== this.current);
			if (removable) { this.remove(removable); continue; }
			if (!this.current) break;
			const limit = Math.max(0, MAX_TEXT_BYTES - this.omission.textBytes);
			this.current.data.text = tailBytes(this.current.data.text, limit);
			this.totalBytes -= this.current.textBytes; this.current.textBytes = bytes(this.current.data.text); this.totalBytes += this.current.textBytes;
			this.current.dirty = true; this.current.cachedWidth = undefined; this.current.cachedLines = undefined;
		}
	}
	startAssistant() { if (this.current) this.endAssistant(); this.current = this.add("assistant", { text: "" }); }
	appendText(text) {
		if (!this.current) this.startAssistant();
		this.current.data.text += text; const added = bytes(text); this.current.textBytes += added; this.totalBytes += added; this.current.dirty = true; this.trim();
	}
	endAssistant(error) { if (!this.current) this.startAssistant(); this.current.done = true; this.current.data.error = error; this.current.dirty = true; this.current = undefined; }
	apply(frame) {
		if (frame.type === "text") this.appendText(frame.text);
		else if (frame.type === "notice" || frame.type === "status") this.add("notice", { text: frame.text }, bytes(frame.text)).done = true;
		else if (frame.type === "display") {
			const event = frame.frame;
			if (event.type === "assistant_start") this.startAssistant();
			else if (event.type === "assistant_end") this.endAssistant(event.error);
			else if (event.type === "tool_start") {
				const argsText = `${event.argsText ?? (event.args ? JSON.stringify(event.args, null, 2) : "")}${event.truncated ? "\n… (truncated)" : ""}`;
				const native = !event.truncated && event.argsText === undefined && SAFE_NATIVE_TOOLS.has(event.toolName) && hasValidNativeArgs(event.toolName, event.args);
				const block = this.add("tool", { id: event.toolCallId, name: event.toolName, args: event.args ?? {}, argsText, native }, bytes(argsText));
				this.tools.set(event.toolCallId, block);
			} else if (event.type === "tool_end") {
				let block = this.tools.get(event.toolCallId);
				if (!block) block = this.add("tool", { id: event.toolCallId, name: event.toolName, args: {}, argsText: "(start omitted)" }, 15);
				block.data.result = `${event.text}${event.truncated ? "\n… (truncated)" : ""}`; block.data.isError = event.isError; block.textBytes += bytes(block.data.result); this.totalBytes += bytes(block.data.result); block.done = true; block.dirty = true; this.trim();
			}
		}
		this.requestRender();
	}
	render(width) { return this.blocks.flatMap((block) => block.render(width)); }
	invalidate() { for (const block of this.blocks) block.invalidate(); }
}

export class RedrawScheduler {
	constructor(render, clock = { now: () => performance.now(), later: setTimeout, cancel: clearTimeout }) { this.render = render; this.clock = clock; this.last = -Infinity; this.timer = undefined; }
	request = () => {
		if (this.timer !== undefined) return;
		const delay = Math.max(0, REDRAW_MS - (this.clock.now() - this.last));
		this.timer = this.clock.later(() => { this.timer = undefined; this.last = this.clock.now(); this.render(); }, delay);
	};
	flush() { if (this.timer !== undefined) this.clock.cancel(this.timer); this.timer = undefined; this.last = this.clock.now(); this.render(); }
	stop() { if (this.timer !== undefined) this.clock.cancel(this.timer); this.timer = undefined; }
}

class ReadOnlyScreen extends TuiAltScreen {
	constructor(terminal) { super(terminal, false, undefined, { mouse: false }); }
	handleViewportInput(data) {
		if (matchesKey(data, "up")) this.scrollBy(-1);
		else if (matchesKey(data, "down")) this.scrollBy(1);
		else if (matchesKey(data, "pageUp")) this.scrollBy(-Math.max(1, this.terminal.rows - 5));
		else if (matchesKey(data, "pageDown")) this.scrollBy(Math.max(1, this.terminal.rows - 5));
		else if (matchesKey(data, "home")) this.scrollToTop();
		else if (matchesKey(data, "end")) this.scrollToBottom();
		return { consume: true };
	}
}

export function createNativeViewer({ terminal = new ProcessTerminal(), cwd = process.cwd() } = {}) {
	const screen = new ReadOnlyScreen(terminal);
	const scheduler = new RedrawScheduler(() => screen.renderNow());
	const header = new Header();
	const transcript = new Transcript(scheduler.request, cwd);
	const scroll = new ScrollView(transcript, { follow: "end", primary: true, scrollbar: "auto" });
	const root = new VStack([{ component: header, basis: 1, shrink: 0 }, { component: scroll, grow: 1, minSize: 0 }]);
	screen.setLayoutRoot(root);
	return {
		screen, header, transcript, scroll, root, scheduler,
		apply(frame) {
			if (frame.type === "init") {
				header.setTitle(frame.title);
				if (frame.limited) transcript.apply({ type: "notice", text: "Limited view: earlier rich detail unavailable." });
			} else if (frame.type === "usage") header.setUsage(frame.inputTokens, frame.outputTokens);
			else transcript.apply(frame);
			scheduler.request();
		},
		start() { terminal.setTitle(header.title); screen.start(); },
		stop() { scheduler.stop(); screen.stop({ preserveScreen: true }); },
		flush() { scheduler.flush(); },
	};
}
