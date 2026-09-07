import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import chatInput from "../index.js";
import { frameEditorLines, isEditorRail, scrollLabel } from "../layout.js";

const identity = (value: string) => value;

test("recognizes native rails and viewport labels", () => {
	assert.equal(isEditorRail("────────"), true);
	assert.equal(isEditorRail("── ↑ 12 more ──"), true);
	assert.equal(scrollLabel("── ↓ 3 more ──"), "↓ 3 more");
	assert.equal(isEditorRail("ordinary text"), false);
});

test("frames body while leaving autocomplete outside", () => {
	const rendered = frameEditorLines(["──────────", "hello", "──────────", "completion"], {
		width: 18,
		contentWidth: 12,
		paddingX: 1,
		prefix: "❯",
		paintBorder: identity,
		paintPrefix: identity,
	});
	assert.ok(rendered);
	assert.equal(rendered[0], "┌────────────────┐");
	assert.match(rendered[1] ?? "", /^│ ❯ hello/);
	assert.equal(rendered.at(-1), " completion");
	for (const line of rendered) assert.ok(visibleWidth(line) <= 18);
});

test("editor does not inject a transcript action or mutate TUI input listeners", async () => {
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	let editorFactory: ((tui: any, theme: any, keybindings: any) => { setText(text: string): void; render(width: number): string[] }) | undefined;
	const pi = {
		on(name: string, handler: (event: unknown, ctx: any) => void) {
			if (name === "session_start") sessionStart = handler;
		},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI;
	chatInput(pi);

	await sessionStart?.({}, {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, value: string) => value },
			setEditorComponent(factory: typeof editorFactory) { editorFactory = factory; },
		},
	});
	assert.ok(editorFactory);

	const existingListener = () => undefined;
	const inputListeners = new Set([existingListener]);
	const editor = editorFactory(
		{
			mode: "fullscreen",
			isFollowingOutput: false,
			inputListeners,
			terminal: { rows: 40, columns: 80 },
			requestRender() {},
			scrollToBottom() {},
		},
		{ borderColor: identity, selectList: {} },
		{ matches: () => false },
	);
	editor.setText("hello");
	const rendered = editor.render(40).join("\n");

	assert.doesNotMatch(rendered, /Scroll to bottom/);
	assert.deepEqual([...inputListeners], [existingListener]);
});
