import assert from "node:assert/strict";
import test from "node:test";
import { attachInteractiveFooter, moveInteractiveFooterSelection, selectedInteractiveFooterId } from "../controller.js";
import { showInteractiveFooterDialog } from "../dialog.js";
import { listInteractiveFooterItems, registerInteractiveFooterItem, resetInteractiveFooterRegistryForTests } from "../registry.js";

const rows = [
	["permissions", "effort", "tier-profile", "fast-mode"],
	["service:mem0", "service:searxng", "service:visual-companion"],
];

test("moves within the footer grid and exits only above its first row", () => {
	let selection = { row: 0, column: 0 };
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "effort");
	selection = moveInteractiveFooterSelection(rows, selection, "down")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "service:searxng");
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	selection = moveInteractiveFooterSelection(rows, selection, "right")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "service:visual-companion", "right clamps at the row edge");
	selection = moveInteractiveFooterSelection(rows, selection, "up")!;
	assert.equal(selectedInteractiveFooterId(rows, selection), "tier-profile");
	assert.equal(moveInteractiveFooterSelection(rows, selection, "up"), undefined);
});

test("terminal routing consumes Escape in footer and while a dialog resolves, then lets the focused overlay own it", async () => {
	resetInteractiveFooterRegistryForTests();
	let resolveSpec!: (value: { title: string; rows: any[] }) => void;
	const spec = new Promise<{ title: string; rows: any[] }>((resolve) => { resolveSpec = resolve; });
	const registration = registerInteractiveFooterItem({ id: "permissions", section: "settings", order: 10, status: () => ({ label: "Permissions" }), dialog: () => spec });
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
	assert.equal(terminalInput("\x1b[1;3B")?.consume, true, "Alt+Down enters footer mode");
	assert.equal(terminalInput("\x1b")?.consume, true, "Escape is swallowed in footer mode");
	assert.equal(terminalInput("\r")?.consume, true);
	assert.equal(terminalInput("\x1b")?.consume, true, "Escape is swallowed while an async dialog specification resolves");
	resolveSpec({ title: "Permissions", rows: [{ kind: "setting", id: "mode", label: "Mode", value: () => "Enforced", values: ["Enforced", "Bypass"], setValue() {} }] });
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
