import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type {
	InteractiveFooterActionRow,
	InteractiveFooterDialogRow,
	InteractiveFooterDialogSpec,
	InteractiveFooterSettingRow,
	InteractiveFooterTone,
} from "./types.js";

function tone(theme: Theme, name: InteractiveFooterTone | undefined, text: string): string {
	return theme.fg(name ?? "text", text);
}

function padLine(text: string, width: number): string {
	const fitted = truncateToWidth(text, width, "");
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

function selectableRows(rows: InteractiveFooterDialogRow[]): Array<InteractiveFooterSettingRow | InteractiveFooterActionRow> {
	return rows.filter((row): row is InteractiveFooterSettingRow | InteractiveFooterActionRow => row.kind !== "detail");
}

class InteractiveFooterDialog implements Component {
	private selected = 0;
	private busy = false;
	private actionAbort: AbortController | undefined;
	private message: { text: string; tone: InteractiveFooterTone } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly spec: InteractiveFooterDialogSpec,
		private readonly done: () => void,
	) {}

	private changeSetting(row: InteractiveFooterSettingRow, direction: -1 | 1): void {
		if (this.busy || row.values.length === 0) return;
		const current = row.values.indexOf(row.value());
		const start = current < 0 ? 0 : current;
		const next = (start + direction + row.values.length) % row.values.length;
		const value = row.values[next];
		if (value === undefined) return;
		this.message = undefined;
		try {
			const result = row.setValue(value);
			if (result && typeof (result as Promise<void>).then === "function") {
				this.busy = true;
				this.tui.requestRender();
				void Promise.resolve(result)
					.catch((error) => { this.message = { text: error instanceof Error ? error.message : String(error), tone: "error" }; })
					.finally(() => { this.busy = false; this.tui.requestRender(); });
				return;
			}
		} catch (error) {
			this.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
		}
		this.tui.requestRender();
	}

	private async runAction(row: InteractiveFooterActionRow): Promise<void> {
		if (this.busy || row.disabled?.()) return;
		this.busy = true;
		this.actionAbort = new AbortController();
		this.message = undefined;
		this.tui.requestRender();
		try {
			await row.run(this.actionAbort.signal);
			if (!this.actionAbort.signal.aborted) this.message = { text: "Done", tone: "success" };
		} catch (error) {
			if (!this.actionAbort.signal.aborted) this.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.busy = false;
			this.actionAbort = undefined;
			this.tui.requestRender();
		}
	}

	handleInput(data: string): void {
		// Escape is intentionally swallowed. It must never leak through to Pi's
		// agent interrupt while the footer or one of its dialogs owns interaction.
		if (matchesKey(data, Key.escape)) return;
		const rows = selectableRows(this.spec.rows);
		if (this.busy) {
			if (matchesKey(data, Key.up)) {
				this.actionAbort?.abort();
				this.done();
			}
			return;
		}
		if (rows.length === 0) {
			if (matchesKey(data, Key.up)) this.done();
			return;
		}
		if (matchesKey(data, Key.up)) {
			if (this.selected === 0) this.done();
			else this.selected -= 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selected = Math.min(rows.length - 1, this.selected + 1);
			return;
		}
		const row = rows[this.selected];
		if (!row) return;
		if (row.kind === "setting") {
			if (matchesKey(data, Key.left)) this.changeSetting(row, -1);
			else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter) || matchesKey(data, Key.space)) this.changeSetting(row, 1);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) void this.runAction(row);
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const line = (text = "") => `${border("│")}${padLine(text, innerWidth)}${border("│")}`;
		const lines = [border(`╭${"─".repeat(innerWidth)}╮`)];
		lines.push(line(` ${this.theme.bold(this.theme.fg("accent", this.spec.title))}`));
		if (this.spec.description) {
			for (const text of wrapTextWithAnsi(this.spec.description, Math.max(1, innerWidth - 2))) lines.push(line(` ${this.theme.fg("muted", text)}`));
		}
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));

		const selectable = selectableRows(this.spec.rows);
		let selectableIndex = 0;
		for (const row of this.spec.rows) {
			if (row.kind === "detail") {
				const label = this.theme.fg("dim", `${row.label}:`);
				lines.push(line(`  ${label} ${this.theme.fg("muted", row.value())}`));
				continue;
			}
			const selected = selectableIndex === this.selected;
			const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
			if (row.kind === "setting") {
				const value = this.busy && selected ? "Working…" : row.value();
				lines.push(line(`${prefix}${this.theme.fg(selected ? "accent" : "text", row.label)}  ${this.theme.fg("muted", `‹ ${value} ›`)}`));
			} else {
				const disabled = row.disabled?.() ?? false;
				const label = this.busy && selected ? "Working…" : row.label();
				lines.push(line(`${prefix}${tone(this.theme, disabled ? "dim" : row.tone, label)}`));
			}
			if (selected && row.description) {
				for (const text of wrapTextWithAnsi(row.description, Math.max(1, innerWidth - 4))) lines.push(line(`    ${this.theme.fg("dim", text)}`));
			}
			selectableIndex += 1;
		}
		if (selectable.length === 0) lines.push(line(`  ${this.theme.fg("dim", "No actions available")}`));
		if (this.message) lines.push(line(`  ${tone(this.theme, this.message.tone, this.message.text)}`));
		lines.push(border(`├${"─".repeat(innerWidth)}┤`));
		lines.push(line(` ${this.theme.fg("dim", "↑ on first item closes · ↑↓ navigate · ←→ change · Enter activate")}`));
		lines.push(border(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
}

export async function showInteractiveFooterDialog(ctx: ExtensionContext, spec: InteractiveFooterDialogSpec, onOpen?: () => void): Promise<void> {
	if (ctx.mode !== "tui") return;
	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			onOpen?.();
			return new InteractiveFooterDialog(tui, theme, spec, () => done(undefined));
		},
		{
			overlay: true,
			overlayOptions: { width: "55%", minWidth: 52, maxHeight: "75%", anchor: "center", margin: 1 },
		},
	);
}
