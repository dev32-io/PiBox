import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider, type TuiMouseEvent } from "@earendil-works/pi-tui";
import chatInput from "../index.js";
import { DEFAULT_CHAT_INPUT_CONFIG } from "../config.js";

const GUTTER = DEFAULT_CHAT_INPUT_CONFIG.paddingX + 1 + 1; // padding + "❯" + space

const strip = (line: string) => line.replace(/\x1b(?:\[[0-9;]*m|_[^\x07]*\x07)/g, "");

async function createEditor(): Promise<any> {
	let sessionStart: ((event: unknown, ctx: any) => void) | undefined;
	let factory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
	chatInput({
		on(name: string, handler: (event: unknown, ctx: any) => void) {
			if (name === "session_start") sessionStart = handler;
		},
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	await sessionStart?.({}, {
		mode: "tui",
		ui: { theme: { fg: (_c: string, v: string) => v }, setEditorComponent: (f: typeof factory) => { factory = f; } },
	});
	assert.ok(factory);
	return factory(
		{ terminal: { rows: 40, columns: 80 }, requestRender() {} },
		{ borderColor: (v: string) => v, selectList: { selectedPrefix: (v: string) => v, selectedText: (v: string) => v, description: (v: string) => v, scrollInfo: (v: string) => v, noMatch: (v: string) => v } },
		{ matches: () => false },
	);
}

function click(editor: any, x: number, y: number, width: number): unknown {
	const event: TuiMouseEvent = {
		type: "click", button: "left", x, y, screenX: x, screenY: y, width, height: 20, shift: false, alt: false, ctrl: false,
	} as TuiMouseEvent;
	return editor.handleMouse(event);
}

test("click lands on the clicked character, including wrapped rows", async () => {
	const editor = await createEditor();
	const width = 24;
	const text = "abcdefghij klmnopqrstuvwxyz";
	editor.setText(text);
	const rows = editor.render(width).map(strip);
	click(editor, GUTTER + 4, 1, width);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 4 });
	const second = rows[2].slice(GUTTER).trimEnd();
	assert.ok(second.length > 3 && text.includes(second), `wrapped row ${JSON.stringify(second)}`);
	click(editor, GUTTER + 3, 2, width);
	assert.deepEqual(editor.getCursor(), { line: 0, col: text.indexOf(second) + 3 });
});

test("gutter click places cursor at column 0 of that row", async () => {
	const editor = await createEditor();
	editor.setText("hello world");
	editor.render(40);
	click(editor, GUTTER + 5, 1, 40);
	assert.equal(editor.getCursor().col, 5);
	for (const x of [0, 1, GUTTER - 1]) {
		click(editor, x, 1, 40);
		assert.equal(editor.getCursor().col, 0, `x=${x}`);
	}
});

test("autocomplete click selects the clicked menu row", async () => {
	const editor = await createEditor();
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([{ name: "alpha" }, { name: "alps" }, { name: "beta" }], process.cwd(), null));
	editor.handleInput("/");
	editor.handleInput("a");
	await new Promise((resolve) => setTimeout(resolve, 100));
	const rows = editor.render(40).map(strip);
	assert.ok(editor.isShowingAutocomplete());
	const menuStart = rows.findIndex((l: string) => l.includes("alps"));
	assert.ok(menuStart > 0);
	click(editor, 3, menuStart, 40);
	assert.equal(editor.getText(), "/alps ");
});

test("unboxed fallback keeps stock coordinates", async () => {
	const editor = await createEditor();
	editor.setText("hello world");
	editor.render(10); // below minBoxWidth: stock render
	click(editor, 4, 1, 10);
	assert.equal(editor.getCursor().col, 4);
});
