import assert from "node:assert/strict";
import test from "node:test";
import { attachInteractiveFooter, moveInteractiveFooterSelection, selectedInteractiveFooterId } from "../controller.js";
import { showInteractiveFooterDialog } from "../dialog.js";
import { listInteractiveFooterItems, registerInteractiveFooterItem, resetInteractiveFooterRegistryForTests } from "../registry.js";

const rows = [
	["work-mode"],
	["permissions", "effort", "tier-profile", "fast-mode"],
	["service:mem0", "service:searxng", "service:visual-companion"],
];

test("moves from mode into settings and exits only above the mode icon", () => {
	let selection = { row: 0, column: 0 };
	assert.equal(selectedInteractiveFooterId(rows, selection), "work-mode");
	selection = moveInteractiveFooterSelection(rows, selection, "down")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "permissions");
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "effort");
	selection = moveInteractiveFooterSelection(rows, selection, "down")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "service:searxng");
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "service:visual-companion", "right clamps at the row edge");
	selection = moveInteractiveFooterSelection(rows, selection, "up")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "tier-profile");
	selection = moveInteractiveFooterSelection(rows, selection, "up")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "work-mode");
	assert.equal(moveInteractiveFooterSelection(rows, selection, "up"), undefined);
});

test("Down enters the footer only from an empty editor", () => {
	let terminalInput!: (data: string) => { consume?: boolean } | undefined;
	let editorText = "draft";
	const ctx = {
		mode: "tui",
		ui: {
			getEditorText: () => editorText,
			onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => {}; },
		},
	} as any;
	const controller = attachInteractiveFooter(ctx, { rows: () => [["work-mode"]], requestRender() {} });
	assert.equal(terminalInput("\x1b[B"), undefined, "Down remains available to navigate a non-empty editor");
	assert.equal(controller.active, false);
	editorText = "";
	assert.equal(terminalInput("\x1b[B")?.consume, true);
	assert.equal(controller.active, true);
	controller.dispose();
});

test("Escape exits footer mode and cancels pending dialog resolution", async () => {
	resetInteractiveFooterRegistryForTests();
	let resolveSpec!: (value: { title: string; rows: any[] }) => void;
	const spec = new Promise<{ title: string; rows: any[] }>((resolve) => { resolveSpec = resolve; });
	const registration = registerInteractiveFooterItem({ id: "permissions", section: "settings", order: 10, status: () => ({ label: "Permissions" }), dialog: () => spec });
	let terminalInput!: (data: string) => { consume?: boolean } | undefined;
	let overlayMounted = false;
	const ctx = {
		mode: "tui",
		ui: {
			onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => {}; },
			notify() {},
			custom() { overlayMounted = true; return Promise.resolve(); },
		},
	} as any;
	const controller = attachInteractiveFooter(ctx, { rows: () => [["permissions"]], requestRender() {} });
	assert.equal(terminalInput("\x1b[B")?.consume, true, "Down enters footer mode");
	assert.equal(controller.active, true);
	assert.equal(terminalInput("\x1b")?.consume, true, "the first Escape exits footer mode");
	assert.equal(controller.active, false);
	assert.equal(terminalInput("\x1b"), undefined, "later Escape reaches Pi's interrupt handler");

	assert.equal(terminalInput("\x1b[B")?.consume, true);
	assert.equal(terminalInput("\r")?.consume, true);
	assert.equal(terminalInput("\x1b")?.consume, true, "Escape cancels an unresolved footer dialog");
	assert.equal(controller.active, false);
	assert.equal(terminalInput("\x1b"), undefined, "later Escape reaches Pi after resolving was cancelled");
	resolveSpec({ title: "Permissions", rows: [{ kind: "setting", id: "mode", label: "Mode", value: () => "Enforced", values: ["Enforced", "Bypass"], setValue() {} }] });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(overlayMounted, false, "a cancelled late dialog result cannot mount an overlay");
	controller.dispose();
	registration.unregister();
	resetInteractiveFooterRegistryForTests();
});

test("terminal routing lets a focused footer overlay own Escape", async () => {
	resetInteractiveFooterRegistryForTests();
	const registration = registerInteractiveFooterItem({
		id: "permissions",
		section: "settings",
		order: 10,
		status: () => ({ label: "Permissions" }),
		dialog: () => ({ title: "Permissions", rows: [{ kind: "setting", id: "mode", label: "Mode", value: () => "Enforced", values: ["Enforced", "Bypass"], setValue() {} }] }),
	});
	let terminalInput!: (data: string) => { consume?: boolean } | undefined;
	let overlayComponent: { handleInput?(data: string): void } | undefined;
	const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		mode: "tui",
		ui: {
			onTerminalInput(handler: typeof terminalInput) { terminalInput = handler; return () => {}; },
			notify() {},
			custom(factory: any) {
				return new Promise<void>((resolve) => {
					overlayComponent = factory({ requestRender() {} }, theme, {}, () => { resolve(); });
				});
			},
		},
	} as any;
	const controller = attachInteractiveFooter(ctx, { rows: () => [["permissions"]], requestRender() {} });
	assert.equal(terminalInput("\x1b[B")?.consume, true);
	assert.equal(terminalInput("\r")?.consume, true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(terminalInput("\x1b"), undefined, "the mounted overlay receives terminal input directly");
	overlayComponent?.handleInput?.("\x1b[A");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(terminalInput("\x1b"), undefined, "Up on the first popup row does not close it");
	overlayComponent?.handleInput?.("\x1b");
	await new Promise((resolve) => setImmediate(resolve));
	controller.dispose();
	registration.unregister();
	resetInteractiveFooterRegistryForTests();
});

test("Escape aborts and closes a busy dialog action from any selected row", async () => {
	let component: { handleInput?(data: string): void } | undefined;
	let aborted = false;
	const ctx = {
		mode: "tui",
		ui: {
			custom(factory: any) {
				return new Promise<void>((resolve) => {
					component = factory({ requestRender() {} }, { fg: (_token: string, text: string) => text, bold: (text: string) => text }, {}, resolve);
				});
			},
		},
	} as any;
	const opened = showInteractiveFooterDialog(ctx, {
		title: "Service",
		rows: [
			{ kind: "action", id: "start", label: () => "Start", run() {} },
			{
				kind: "action",
				id: "refresh",
				label: () => "Refresh",
				run: (signal) => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })),
			},
		],
	});
	await new Promise((resolve) => setImmediate(resolve));
	component?.handleInput?.("\x1b[B");
	component?.handleInput?.("\r");
	component?.handleInput?.("\x1b");
	await opened;
	assert.equal(aborted, true);
});

test("registry state is shared across isolated extension module graphs", async () => {
	const first = await import(new URL("../registry.ts?graph=first", import.meta.url).href);
	const second = await import(new URL("../registry.ts?graph=second", import.meta.url).href);
	first.resetInteractiveFooterRegistryForTests();
	const registration = second.registerInteractiveFooterItem({ id: "effort", section: "settings", order: 20, status: () => ({ label: "Effort" }), dialog: () => ({ title: "Effort", rows: [] }) });
	assert.deepEqual(first.listInteractiveFooterItems().map((item: { id: string }) => item.id), ["effort"]);
	registration.unregister();
	first.resetInteractiveFooterRegistryForTests();
});

test("shared registry orders sections and stale cleanup cannot remove a replacement", () => {
	resetInteractiveFooterRegistryForTests();
	const stub = { status: () => ({ label: "item" }), dialog: () => ({ title: "item", rows: [] }) };
	const old = registerInteractiveFooterItem({ ...stub, id: "effort", section: "settings", order: 20 });
	const first = registerInteractiveFooterItem({ ...stub, id: "permissions", section: "settings", order: 10 });
	const replacement = registerInteractiveFooterItem({ ...stub, id: "effort", section: "settings", order: 20 });
	old.unregister();
	assert.deepEqual(listInteractiveFooterItems("settings").map((item) => item.id), ["permissions", "effort"]);
	first.unregister();
	replacement.unregister();
	resetInteractiveFooterRegistryForTests();
});
