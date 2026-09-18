import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const renderer: any = await import(new URL("../renderer.mjs", import.meta.url).href);
const viewer: any = await import(new URL("../viewer.mjs", import.meta.url).href);
const { Header, MAX_BLOCKS, MAX_TEXT_BYTES, REDRAW_MS, RedrawScheduler, Transcript, createNativeViewer, formatTokens } = renderer;
const { FrameDecoder, MAX_FRAME_BYTES, normalizeFrame, plainFrameText, sanitizeTerminalText } = viewer;

function clock() {
	let now = 0; let id = 0; const jobs = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		later(fn: () => void, delay: number) { jobs.set(++id, { at: now + delay, fn }); return id; },
		cancel(key: number) { jobs.delete(key); },
		advance(to: number) {
			for (;;) {
				const due = [...jobs].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, job]) => job.at <= to);
				if (!due) break; jobs.delete(due[0]); now = due[1].at; due[1].fn();
			}
			now = to;
		},
	};
}

const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("header stays fixed, width-safe, and formats unknown/cumulative usage", () => {
	assert.deepEqual([formatTokens(undefined), formatTokens(0), formatTokens(999), formatTokens(1_400_000), formatTokens(25_000)], ["—", "0", "999", "1.4M", "25k"]);
	const header = new Header(); header.setUsage(1_400_000, 25_000);
	for (const title of ["Long spawn title", "任务标题", "agent 🪨 task"]) {
		header.setTitle(title);
		for (const width of [1, 4, 12, 24, 80]) {
			const line = header.render(width)[0];
			assert.ok(visibleWidth(line) <= width);
			assert.ok(line.startsWith("\u001b[1;7m"), "bold, contrasting background spans header");
			assert.ok(line.endsWith("\u001b[0m"), "header styling cannot leak into transcript");
		}
		assert.equal(header.render(0)[0], "");
		assert.match(stripTerminalSequences(header.render(80)[0]), /↑ 1\.4M ↓ 25k$/);
		assert.equal(visibleWidth(header.render(80)[0]), 80, "Unicode title pads by terminal columns");
	}
	const fakeTerminal = { columns: 20, rows: 5, kittyProtocolActive: false, start() {}, stop() {}, drainInput: async () => {}, write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {} };
	const native = createNativeViewer({ terminal: fakeTerminal });
	native.apply({ type: "init", title: "Pinned", limited: true });
	assert.match(native.transcript.blocks[0].data.text, /Limited view/);
	for (let i = 0; i < 20; i++) native.transcript.apply({ type: "notice", text: `line ${i}` });
	const pinned = native.header.render(20)[0];
	native.scroll.updateLayout(20, 4, () => {}); native.scroll.scrollBy(-3);
	assert.equal(native.root.entries[0].component, native.header);
	assert.equal(native.root.entries[0].basis, 1);
	assert.equal(native.root.entries[1].component, native.scroll);
	assert.equal(native.header.render(20)[0], pinned);
	assert.ok(visibleWidth(native.header.render(8)[0]) <= 8, "resize remains width-safe");
	assert.ok(native.scroll.scrollTop > 0, "body scrolls independently");
});

test("assistant updates batch at 10Hz and completed blocks use one-width cache", () => {
	const time = clock(); let renders = 0;
	const scheduler = new RedrawScheduler(() => renders++, time);
	for (let index = 0; index < 100; index++) { time.advance(index * 5); scheduler.request(); }
	time.advance(700);
	assert.ok(renders <= Math.ceil(500 / REDRAW_MS) + 2);
	const transcript = new Transcript();
	transcript.apply({ type: "display", frame: { type: "assistant_start" } });
	for (let i = 0; i < 100; i++) transcript.apply({ type: "text", text: "word " });
	assert.equal(transcript.blocks[0].component, undefined, "no native rebuild per delta");
	transcript.apply({ type: "display", frame: { type: "assistant_end" } });
	transcript.render(40); const cache40 = transcript.blocks[0].cachedLines;
	transcript.render(40); assert.equal(transcript.blocks[0].cachedLines, cache40);
	transcript.render(20); assert.equal(transcript.blocks[0].cachedWidth, 20);
	assert.notEqual(transcript.blocks[0].cachedLines, cache40);
});

test("native tool cards show actual args, result, error, truncation, and never preview edit from disk", async () => {
	const transcript = new Transcript();
	transcript.apply({ type: "display", frame: { type: "tool_start", toolCallId: "read-1", toolName: "read", args: { path: "/tmp/example" } } });
	transcript.apply({ type: "display", frame: { type: "tool_end", toolCallId: "read-1", toolName: "read", text: "contents", isError: false } });
	transcript.apply({ type: "display", frame: { type: "tool_start", toolCallId: "bash-native", toolName: "bash", args: { command: "printf native" } } });
	transcript.apply({ type: "display", frame: { type: "tool_end", toolCallId: "bash-native", toolName: "bash", text: "native", isError: false } });
	for (const [toolName, args] of [["grep", { pattern: "needle" }], ["find", { pattern: "*.ts" }], ["ls", { path: "." }], ["write", { path: "/tmp/out", content: "text" }]] as const) {
		transcript.apply({ type: "display", frame: { type: "tool_start", toolCallId: `${toolName}-native`, toolName, args } });
		assert.equal(transcript.tools.get(`${toolName}-native`).data.native, true);
	}
	transcript.apply({ type: "display", frame: { type: "tool_start", toolCallId: "bash-1", toolName: "bash", argsText: "command: false", truncated: true } });
	transcript.apply({ type: "display", frame: { type: "tool_end", toolCallId: "bash-1", toolName: "bash", text: "exit 1", isError: true, truncated: true } });
	const rendered = clean(transcript.render(80));
	assert.equal(transcript.tools.get("read-1").data.native, true); assert.equal(transcript.tools.get("bash-native").data.native, true);
	assert.equal(transcript.tools.get("bash-1").data.native, false, "truncated args use generic passive card");
	assert.match(rendered, /read \/tmp\/example/, "safe read uses explicit native renderer");
	assert.match(rendered, /\$ printf native/, "safe bash uses explicit native renderer");
	assert.match(rendered, /contents/); assert.match(rendered, /command: false/); assert.match(rendered, /Error: exit 1/); assert.match(rendered, /truncated/);

	let fsReads = 0; const readFile = fs.promises.readFile;
	fs.promises.readFile = ((...args: Parameters<typeof readFile>) => { fsReads++; return readFile(...args); }) as typeof readFile; syncBuiltinESMExports();
	try {
		const passive = new Transcript();
		for (const [toolName, args] of [["read", { path: "/definitely/not/read" }], ["bash", { command: "true" }], ["grep", { pattern: "needle" }], ["find", { pattern: "*.ts" }], ["ls", { path: "." }], ["write", { path: "/definitely/not/written", content: "text" }]] as const) {
			passive.apply({ type: "display", frame: { type: "tool_start", toolCallId: `${toolName}-passive`, toolName, args } });
		}
		passive.apply({ type: "display", frame: { type: "tool_start", toolCallId: "edit-1", toolName: "edit", args: { path: "/definitely/not/read", edits: [{ oldText: "a", newText: "b" }] } } });
		assert.equal(passive.tools.get("edit-1").data.native, false, "edit always uses generic renderer");
		passive.render(80); await new Promise((resolve) => setImmediate(resolve));
	} finally { fs.promises.readFile = readFile; syncBuiltinESMExports(); }
	assert.equal(fsReads, 0, "observer must not read target paths while creating safe renderers or generic edit cards");
});

test("history and UTF-8 text caps retain a visible omission marker", () => {
	const transcript = new Transcript();
	for (let i = 0; i < MAX_BLOCKS + 20; i++) transcript.apply({ type: "notice", text: `${i}: ${"🪨".repeat(4096)}` });
	assert.ok(transcript.blocks.length <= MAX_BLOCKS);
	assert.ok(transcript.totalBytes <= MAX_TEXT_BYTES);
	assert.match(transcript.blocks[0].data.text, /Earlier output omitted/);
	assert.match(transcript.blocks.at(-1).data.text, new RegExp(`^${MAX_BLOCKS + 19}:`));

	const giant = new Transcript();
	giant.apply({ type: "display", frame: { type: "assistant_start" } });
	giant.apply({ type: "text", text: "🪨".repeat(MAX_TEXT_BYTES) });
	assert.ok(giant.totalBytes <= MAX_TEXT_BYTES); assert.equal(giant.blocks.length, 2);
	assert.match(giant.blocks[0].data.text, /Earlier output omitted/);
	assert.ok(giant.current.data.text.length > 0, "giant active block is tail-truncated, not silently removed");
});

test("viewer sanitizes controls and validates useful display frames", () => {
	const frame = normalizeFrame({ type: "display", frame: { type: "tool_start", toolCallId: "id\u001b]0;x\u0007", toolName: "bash\u001b[2J", args: { command: "echo\u001b[31m red", nested: { value: "ok\u0000" } } } });
	const output = JSON.stringify(frame);
	assert.doesNotMatch(output, /[\u001b\u0000\u0007]/);
	assert.match(plainFrameText(frame), /echo\[31m red/);
	assert.equal(sanitizeTerminalText("safe\n\u001b]title\u0007\u202eunsafe\u2066"), "safe\n]titleunsafe");
	assert.equal(normalizeFrame({ type: "usage", inputTokens: -1, outputTokens: 42.9 }).inputTokens, undefined);
	assert.equal(normalizeFrame({ type: "image", data: "base64" }), undefined);
});

test("frame decoder preserves split Unicode and rejects malformed/oversized input without throwing", () => {
	const frames: any[] = []; let failures = 0;
	const decoder = new FrameDecoder((frame: any) => { frames.push(frame); }, () => failures++);
	const encoded = Buffer.from(`${JSON.stringify({ type: "text", text: "A🪨B" })}\n`); const split = encoded.indexOf(Buffer.from("🪨")) + 2;
	decoder.push(encoded.subarray(0, split)); decoder.push(encoded.subarray(split));
	assert.deepEqual(frames, [{ type: "text", text: "A🪨B" }]); assert.equal(failures, 0);
	const malformed = new FrameDecoder(() => assert.fail(), () => failures++); assert.doesNotThrow(() => malformed.push(Buffer.from("{nope}\n")));
	const oversized = new FrameDecoder(() => assert.fail(), () => failures++);
	const wrapped = `${JSON.stringify({ type: "display", frame: { type: "tool_end", toolCallId: "id", toolName: "bash", text: "x".repeat(MAX_FRAME_BYTES), isError: false } })}\n`;
	assert.ok(Buffer.byteLength(wrapped) > MAX_FRAME_BYTES, "cap includes socket display wrapper");
	assert.doesNotThrow(() => oversized.push(Buffer.from(wrapped)));
	assert.equal(failures, 2);
});
