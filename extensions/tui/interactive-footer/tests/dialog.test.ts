import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { showInteractiveFooterDialog } from "../dialog.js";
import type { InteractiveFooterDialogSpec } from "../types.js";

interface MountedDialog {
	render(width: number): string[];
	handleInput(data: string): void;
}

function mountDialog(spec: InteractiveFooterDialogSpec, tones: Array<{ tone: string; text: string }> = [], terminalRows?: number) {
	let component: MountedDialog | undefined;
	let renders = 0;
	const ctx = {
		mode: "tui",
		ui: {
			custom(factory: any) {
				return new Promise<void>((resolve) => {
					component = factory(
						{ requestRender() { renders += 1; }, ...(terminalRows ? { terminal: { rows: terminalRows } } : {}) },
						{
							fg(tone: string, text: string) { tones.push({ tone, text }); return text; },
							bold(text: string) { return text; },
						},
						{},
						resolve,
					);
				});
			},
		},
	} as any;
	const closed = showInteractiveFooterDialog(ctx, spec);
	assert.ok(component);
	return { component, closed, renders: () => renders };
}

test("notice rows are dynamic, wrapped, toned, hidden, and non-selectable", async () => {
	let hidden = false;
	let noticeTone: "warning" | "error" = "warning";
	let secondValue = "off";
	const tones: Array<{ tone: string; text: string }> = [];
	const mounted = mountDialog({
		title: "Notices",
		rows: [
			{ kind: "setting", id: "first", label: "First", value: () => "off", values: ["off", "on"], setValue() {} },
			{ kind: "notice", text: () => "dynamic warning text", tone: () => noticeTone, hidden: () => hidden },
			{ kind: "setting", id: "second", label: "Second", value: () => secondValue, values: ["off", "on"], setValue(value) { secondValue = value; } },
		],
	}, tones);

	const rendered = mounted.component.render(20);
	assert.ok(rendered.filter((line) => /dynamic|warning|text/.test(line)).length > 1, "notice text wraps onto multiple lines");
	assert.deepEqual(
		tones.filter(({ tone, text }) => tone === "warning" && /dynamic|warning|text/.test(text)).map(({ text }) => text),
		["dynamic", "warning", "text"],
	);

	mounted.component.handleInput("\x1b[B");
	assert.equal(mounted.renders(), 1, "moving selection requests a rerender");
	mounted.component.handleInput("\x1b[C");
	assert.equal(secondValue, "off", "arrow selection is only a preview");
	assert.match(mounted.component.render(40).join("\n"), /Second\s+\[ on \]/);

	noticeTone = "error";
	mounted.component.render(40);
	assert.ok(tones.some(({ tone, text }) => tone === "error" && text.includes("dynamic warning text")), "dynamic tones refresh without reopening the dialog");
	hidden = true;
	assert.equal(mounted.component.render(40).some((line) => line.includes("dynamic warning text")), false);
	mounted.component.handleInput("\r");
	await mounted.closed;
	assert.equal(secondValue, "on", "Enter confirms the previewed value");
});

test("choice dialogs use a readable vertical list and only Enter confirms", async () => {
	let confirmed: string | undefined;
	const mounted = mountDialog({
		kind: "choice",
		title: "Work mode",
		description: "Choose how PiBox should work in this session.",
		value: () => "agent",
		choices: [
			{ value: "agent", marker: "A", label: "Agent", description: "Direct work." },
			{ value: "orchestrator", marker: "O", label: "Orchestrator", description: "Plan and delegate." },
			{ value: "workflow", marker: "W", label: "Workflow", description: "Managed delivery." },
			{ value: "designer", marker: "D", label: "Designer", description: "Visual design." },
		],
		confirm(value) { confirmed = value; },
	});
	const initial = mounted.component.render(76);
	for (const label of ["Agent", "Orchestrator", "Workflow", "Designer"]) assert.equal(initial.filter((line) => line.includes(label)).length, 1);
	assert.match(initial.join("\n"), /Agent\s+✓ active/);
	assert.match(initial.at(-2) ?? "", /Arrow keys select\s+·\s+Enter confirm\s+·\s+Esc cancel/);

	mounted.component.handleInput("\x1b[B");
	assert.match(mounted.component.render(76).join("\n"), /› O Orchestrator/);
	mounted.component.handleInput(" ");
	assert.equal(confirmed, undefined, "Space does not confirm");
	mounted.component.handleInput("\r");
	await mounted.closed;
	assert.equal(confirmed, "orchestrator");
});

test("Escape cancels a previewed choice", async () => {
	let confirmed = false;
	const mounted = mountDialog({
		kind: "choice",
		title: "Choice",
		value: () => "a",
		choices: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
		confirm() { confirmed = true; },
	});
	mounted.component.handleInput("\x1b[B");
	mounted.component.handleInput("\x1b");
	await mounted.closed;
	assert.equal(confirmed, false);
});

test("detail values wrap instead of losing staged preview text", async () => {
	const mounted = mountDialog({
		title: "Details",
		rows: [{ kind: "detail", label: "Behavior", value: () => "a long staged behavior preview that must remain visible" }],
	});
	const rendered = mounted.component.render(22).join("\n");
	for (const word of ["long", "staged", "behavior", "preview", "visible"]) assert.match(rendered, new RegExp(word));
	mounted.component.handleInput("\x1b");
	await mounted.closed;
});

test("short overlays keep the selected control visible while content scrolls", async () => {
	const mounted = mountDialog({
		title: "Scrollable",
		description: "A deliberately long dialog description must scroll with the body rather than hiding the active control on narrow terminals.",
		rows: [
			...Array.from({ length: 12 }, (_, index) => ({ kind: "notice" as const, text: () => `Notice ${index}` })),
			{ kind: "setting", id: "choice", label: "Choice", value: () => "A", values: ["A", "B"], setValue() {} },
			...Array.from({ length: 12 }, (_, index) => ({ kind: "detail" as const, label: "Detail", value: () => String(index) })),
			{ kind: "action", id: "apply", label: () => "Apply", run() {} },
		],
	}, [], 12);
	assert.match(mounted.component.render(20).join("\n"), /Choice/);
	mounted.component.handleInput("\x1b[B");
	assert.match(mounted.component.render(20).join("\n"), /Apply/);
	assert.ok(mounted.component.render(20).length <= Math.floor(12 * 0.9));
	mounted.component.handleInput("\x1b");
	await mounted.closed;
});

test("successful actions that remain open rely on refreshed state without a Done message", async () => {
	let state = "Stopped";
	const mounted = mountDialog({
		title: "Service",
		rows: [
			{ kind: "detail", label: "Status", value: () => state },
			{ kind: "action", id: "start", label: () => "Start service", closeOnSuccess: false, run() { state = "Running"; } },
		],
	});
	mounted.component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = mounted.component.render(60).join("\n");
	assert.match(rendered, /Running/);
	assert.doesNotMatch(rendered, /Done/);
	mounted.component.handleInput("\x1b");
	await mounted.closed;
});

test("short overlays scroll operation errors into view", async () => {
	const mounted = mountDialog({
		title: "Failure",
		rows: [
			...Array.from({ length: 16 }, (_, index) => ({ kind: "detail" as const, label: "Detail", value: () => String(index) })),
			{ kind: "action", id: "fail", label: () => "Confirm", run() { throw new Error("Visible operation failure"); } },
		],
	}, [], 12);
	mounted.component.handleInput("\r");
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = mounted.component.render(40).join("\n");
	assert.match(rendered, /Visible operation failure/);
	assert.match(rendered, /↑↓ select\s+·\s+Enter confirm\s+·\s+Esc close/);
	assert.doesNotMatch(rendered, /←→/);
	mounted.component.handleInput("\x1b");
	await mounted.closed;
});

test("rendered lines fit zero, one, and two column widths", async () => {
	const mounted = mountDialog({
		title: "A long title",
		description: "A long description",
		rows: [{ kind: "notice", text: () => "A long notice", tone: "muted" }],
	});

	for (const width of [0, 1, 2]) {
		for (const line of mounted.component.render(width)) assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}`);
	}
	mounted.component.handleInput("\x1b");
	await mounted.closed;
});
