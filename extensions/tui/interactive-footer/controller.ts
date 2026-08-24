import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { showInteractiveFooterDialog } from "./dialog.js";
import { getInteractiveFooterItem, subscribeInteractiveFooter } from "./registry.js";

export interface InteractiveFooterSurface {
	rows(): string[][];
	requestRender(): void;
}

export interface InteractiveFooterController {
	readonly selectedId: string | undefined;
	readonly active: boolean;
	dispose(): void;
}

interface Selection {
	row: number;
	column: number;
}

const ACTIVE_CONTROLLER_KEY = Symbol.for("pibox:interactive-footer-active-controller");
type ControllerGlobal = typeof globalThis & { [ACTIVE_CONTROLLER_KEY]?: { dispose(): void } };

function controllerGlobal(): ControllerGlobal {
	return globalThis as ControllerGlobal;
}

function availableRows(rows: string[][]): string[][] {
	return rows.map((row) => row.filter(Boolean)).filter((row) => row.length > 0);
}

export function selectedInteractiveFooterId(rows: string[][], selection: Selection | undefined): string | undefined {
	if (!selection) return undefined;
	const normalized = availableRows(rows);
	const row = normalized[selection.row];
	return row?.[Math.min(selection.column, Math.max(0, row.length - 1))];
}

export function moveInteractiveFooterSelection(rows: string[][], selection: Selection, direction: "left" | "right" | "up" | "down"): Selection | undefined {
	const normalized = availableRows(rows);
	if (normalized.length === 0) return undefined;
	const rowIndex = Math.min(selection.row, normalized.length - 1);
	const row = normalized[rowIndex] ?? [];
	const column = Math.min(selection.column, Math.max(0, row.length - 1));
	if (direction === "left") return { row: rowIndex, column: Math.max(0, column - 1) };
	if (direction === "right") return { row: rowIndex, column: Math.min(Math.max(0, row.length - 1), column + 1) };
	if (direction === "up") {
		if (rowIndex === 0) return undefined;
		const target = normalized[rowIndex - 1] ?? [];
		return { row: rowIndex - 1, column: Math.min(column, Math.max(0, target.length - 1)) };
	}
	if (rowIndex >= normalized.length - 1) return { row: rowIndex, column };
	const target = normalized[rowIndex + 1] ?? [];
	return { row: rowIndex + 1, column: Math.min(column, Math.max(0, target.length - 1)) };
}

export function attachInteractiveFooter(ctx: ExtensionContext, surface: InteractiveFooterSurface): InteractiveFooterController {
	controllerGlobal()[ACTIVE_CONTROLLER_KEY]?.dispose();
	let selection: Selection | undefined;
	let dialogPhase: "idle" | "resolving" | "overlay" = "idle";
	let disposed = false;

	const render = () => surface.requestRender();
	const unsubscribeRegistry = subscribeInteractiveFooter(render);
	const unsubscribeInput = ctx.ui.onTerminalInput((data) => {
		if (disposed) return undefined;
		if (dialogPhase === "overlay") return undefined;
		if (dialogPhase === "resolving") return { consume: true };
		const rows = availableRows(surface.rows());
		if (!selection) {
			if (!matchesKey(data, "alt+down") || rows.length === 0) return undefined;
			selection = { row: 0, column: 0 };
			render();
			return { consume: true };
		}

		if (matchesKey(data, Key.escape)) return { consume: true };
		let direction: "left" | "right" | "up" | "down" | undefined;
		if (matchesKey(data, Key.left)) direction = "left";
		else if (matchesKey(data, Key.right)) direction = "right";
		else if (matchesKey(data, Key.up)) direction = "up";
		else if (matchesKey(data, Key.down)) direction = "down";
		if (direction) {
			selection = moveInteractiveFooterSelection(rows, selection, direction);
			render();
			return { consume: true };
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
			const id = selectedInteractiveFooterId(rows, selection);
			const item = id ? getInteractiveFooterItem(id) : undefined;
			if (item) {
				dialogPhase = "resolving";
				void Promise.resolve(item.dialog(ctx))
					.then((spec) => showInteractiveFooterDialog(ctx, spec, () => { dialogPhase = "overlay"; }))
					.catch((error) => ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"))
					.finally(() => { dialogPhase = "idle"; render(); });
			}
			return { consume: true };
		}
		// Footer mode owns input until Up exits from its first row. Consuming other
		// keys prevents accidental editor edits and agent interrupts.
		return { consume: true };
	});

	const controller: InteractiveFooterController = {
		get selectedId() { return selectedInteractiveFooterId(surface.rows(), selection); },
		get active() { return selection !== undefined; },
		dispose() {
			if (disposed) return;
			disposed = true;
			unsubscribeInput();
			unsubscribeRegistry();
			selection = undefined;
			if (controllerGlobal()[ACTIVE_CONTROLLER_KEY] === controller) delete controllerGlobal()[ACTIVE_CONTROLLER_KEY];
		},
	};
	controllerGlobal()[ACTIVE_CONTROLLER_KEY] = controller;
	return controller;
}
