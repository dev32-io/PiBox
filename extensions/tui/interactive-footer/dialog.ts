import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type {
	InteractiveFooterActionRow,
	InteractiveFooterChoiceDialogSpec,
	InteractiveFooterDialogRow,
	InteractiveFooterDialogSpec,
	InteractiveFooterRowsDialogSpec,
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

function columns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	const fittedRight = truncateToWidth(right, Math.max(0, width - 3), "");
	const fittedLeft = truncateToWidth(left, Math.max(0, width - visibleWidth(fittedRight) - 2), "");
	const gap = " ".repeat(Math.max(2, width - visibleWidth(fittedLeft) - visibleWidth(fittedRight)));
	return truncateToWidth(`${fittedLeft}${gap}${fittedRight}`, width, "");
}

function selectableRows(rows: InteractiveFooterDialogRow[]): Array<InteractiveFooterSettingRow | InteractiveFooterActionRow> {
	return rows.filter((row): row is InteractiveFooterSettingRow | InteractiveFooterActionRow => row.kind === "setting" || row.kind === "action");
}

function isChoiceSpec(spec: InteractiveFooterDialogSpec): spec is InteractiveFooterChoiceDialogSpec {
	return spec.kind === "choice";
}

class InteractiveFooterDialog implements Component {
	private selected = 0;
	private readonly draftSettings = new Map<string, string>();
	private busy = false;
	private actionAbort: AbortController | undefined;
	private message: { text: string; tone: InteractiveFooterTone } | undefined;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly spec: InteractiveFooterDialogSpec,
		private readonly done: () => void,
	) {
		if (isChoiceSpec(spec)) {
			const active = spec.choices.findIndex((choice) => choice.value === spec.value());
			this.selected = Math.max(0, active);
		}
	}

	private settingValue(row: InteractiveFooterSettingRow): string {
		return this.draftSettings.get(row.id) ?? row.value();
	}

	private previewSetting(row: InteractiveFooterSettingRow, direction: -1 | 1): void {
		if (row.values.length === 0) return;
		const current = row.values.indexOf(this.settingValue(row));
		const start = current < 0 ? 0 : current;
		const next = Math.max(0, Math.min(row.values.length - 1, start + direction));
		const value = row.values[next];
		if (value === undefined || value === this.settingValue(row)) return;
		this.draftSettings.set(row.id, value);
		this.message = undefined;
		this.tui.requestRender();
	}

	private moveChoice(direction: -1 | 1): void {
		if (!isChoiceSpec(this.spec) || this.spec.choices.length === 0) return;
		const next = Math.max(0, Math.min(this.spec.choices.length - 1, this.selected + direction));
		if (next === this.selected) return;
		this.selected = next;
		this.message = undefined;
		this.tui.requestRender();
	}

	private async runOperation(operation: (signal: AbortSignal) => void | Promise<void>, closeOnSuccess = true): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.actionAbort = new AbortController();
		this.message = undefined;
		this.tui.requestRender();
		try {
			await operation(this.actionAbort.signal);
			if (!this.actionAbort.signal.aborted && closeOnSuccess) {
				this.done();
				return;
			}
		} catch (error) {
			if (!this.actionAbort.signal.aborted) this.message = { text: error instanceof Error ? error.message : String(error), tone: "error" };
		} finally {
			this.busy = false;
			this.actionAbort = undefined;
			this.tui.requestRender();
		}
	}

	private confirmRows(spec: InteractiveFooterRowsDialogSpec): void {
		const rows = selectableRows(spec.rows);
		const selected = rows[this.selected];
		if (!selected) return;
		if (selected.kind === "action") {
			if (selected.disabled?.()) return;
			void this.runOperation(selected.run, selected.closeOnSuccess !== false);
			return;
		}
		void this.runOperation(async () => {
			for (const row of rows) {
				if (row.kind !== "setting") continue;
				const next = this.settingValue(row);
				if (next !== row.value()) await row.setValue(next);
			}
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			this.actionAbort?.abort();
			this.done();
			return;
		}
		if (this.busy) return;

		if (isChoiceSpec(this.spec)) {
			const spec = this.spec;
			if (matchesKey(data, Key.up) || matchesKey(data, Key.left)) this.moveChoice(-1);
			else if (matchesKey(data, Key.down) || matchesKey(data, Key.right)) this.moveChoice(1);
			else if (matchesKey(data, Key.enter)) {
				const choice = spec.choices[this.selected];
				if (choice && !choice.disabled?.()) void this.runOperation((signal) => spec.confirm(choice.value, signal));
			}
			return;
		}

		const rows = selectableRows(this.spec.rows);
		if (rows.length === 0) return;
		if (matchesKey(data, Key.up)) {
			const selected = Math.max(0, this.selected - 1);
			if (selected !== this.selected) { this.selected = selected; this.tui.requestRender(); }
			return;
		}
		if (matchesKey(data, Key.down)) {
			const selected = Math.min(rows.length - 1, this.selected + 1);
			if (selected !== this.selected) { this.selected = selected; this.tui.requestRender(); }
			return;
		}
		const row = rows[this.selected];
		if (row?.kind === "setting") {
			if (matchesKey(data, Key.left)) this.previewSetting(row, -1);
			else if (matchesKey(data, Key.right)) this.previewSetting(row, 1);
			else if (matchesKey(data, Key.enter)) this.confirmRows(this.spec);
			return;
		}
		if (matchesKey(data, Key.enter)) this.confirmRows(this.spec);
	}

	private renderChoiceBody(spec: InteractiveFooterChoiceDialogSpec, line: (text?: string) => string, innerWidth: number): { lines: string[]; selectedRange: { start: number; end: number } } {
		const lines: string[] = [];
		if (spec.description) {
			for (const text of wrapTextWithAnsi(spec.description, Math.max(1, innerWidth - 4))) lines.push(line(`  ${this.theme.fg("muted", text)}`));
			lines.push(line());
		}
		let selectedRange = { start: 0, end: 0 };
		for (const [index, choice] of spec.choices.entries()) {
			const selected = index === this.selected;
			const disabled = choice.disabled?.() ?? false;
			const active = choice.value === spec.value();
			const prefix = selected ? this.theme.fg("accent", "›") : " ";
			const marker = choice.marker ? `${choice.marker} ` : "";
			const label = disabled ? this.theme.fg("dim", choice.label) : selected ? this.theme.bold(this.theme.fg("accent", choice.label)) : this.theme.fg("text", choice.label);
			const activeLabel = active ? this.theme.fg("success", "✓ active") : "";
			const start = lines.length;
			lines.push(line(columns(` ${prefix} ${marker}${label}`, activeLabel, innerWidth)));
			if (selected && choice.description) {
				for (const text of wrapTextWithAnsi(choice.description, Math.max(1, innerWidth - 8))) lines.push(line(`     ${this.theme.fg("muted", text)}`));
			}
			if (selected) {
				const notice = spec.notice?.(choice.value);
				if (notice) {
					lines.push(line());
					for (const text of wrapTextWithAnsi(notice.text, Math.max(1, innerWidth - 8))) lines.push(line(`     ${tone(this.theme, notice.tone, text)}`));
				}
				selectedRange = { start, end: Math.max(start, lines.length - 1) };
			}
		}
		return { lines, selectedRange };
	}

	private renderRowsBody(spec: InteractiveFooterRowsDialogSpec, line: (text?: string) => string, innerWidth: number): { lines: string[]; selectedRange: { start: number; end: number } } {
		const lines: string[] = [];
		if (spec.description) {
			for (const text of wrapTextWithAnsi(spec.description, Math.max(1, innerWidth - 4))) lines.push(line(`  ${this.theme.fg("muted", text)}`));
			lines.push(line());
		}
		const selectable = selectableRows(spec.rows);
		const detailLabelWidth = Math.max(0, ...spec.rows.filter((row) => row.kind === "detail").map((row) => visibleWidth(row.label)));
		let selectableIndex = 0;
		let selectedRange = { start: 0, end: 0 };
		let reachedSelectable = false;
		for (const row of spec.rows) {
			if (row.kind === "detail") {
				const label = `${row.label}${" ".repeat(Math.max(0, detailLabelWidth - visibleWidth(row.label)))}`;
				const value = this.theme.fg("muted", row.value());
				for (const text of wrapTextWithAnsi(`${this.theme.fg("dim", label)}  ${value}`, Math.max(1, innerWidth - 6))) lines.push(line(`   ${text}`));
				continue;
			}
			if (row.kind === "notice") {
				const rowTone = typeof row.tone === "function" ? row.tone() : row.tone;
				if (!row.hidden?.()) for (const text of wrapTextWithAnsi(row.text(), Math.max(1, innerWidth - 8))) lines.push(line(`     ${tone(this.theme, rowTone, text)}`));
				continue;
			}
			if (!reachedSelectable && lines.length > 0) lines.push(line());
			reachedSelectable = true;
			const selected = selectableIndex === this.selected;
			const start = lines.length;
			const prefix = selected ? this.theme.fg("accent", "›") : " ";
			if (row.kind === "setting") {
				const value = this.settingValue(row);
				const label = selected ? this.theme.bold(this.theme.fg("accent", row.label)) : this.theme.fg("text", row.label);
				lines.push(line(columns(` ${prefix} ${label}`, this.theme.fg(selected ? "accent" : "muted", `[ ${value} ]`), innerWidth)));
			} else {
				const disabled = row.disabled?.() ?? false;
				const label = this.busy && selected ? "Working…" : row.label();
				const rowTone = typeof row.tone === "function" ? row.tone() : row.tone;
				lines.push(line(` ${prefix} ${tone(this.theme, disabled ? "dim" : selected ? "accent" : rowTone, label)}`));
			}
			const description = typeof row.description === "function" ? row.description() : row.description;
			if (selected && description) for (const text of wrapTextWithAnsi(description, Math.max(1, innerWidth - 8))) lines.push(line(`     ${this.theme.fg("dim", text)}`));
			if (selected) selectedRange = { start, end: Math.max(start, lines.length - 1) };
			selectableIndex += 1;
		}
		if (selectable.length === 0) lines.push(line(`   ${this.theme.fg("dim", "No actions available")}`));
		return { lines, selectedRange };
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const line = (text = "") => `${border("│")}${padLine(text, innerWidth)}${border("│")}`;
		const header = [
			border(`╭${"─".repeat(innerWidth)}╮`),
			line(`  ${this.theme.bold(this.theme.fg("accent", this.spec.title))}`),
			border(`├${"─".repeat(innerWidth)}┤`),
		];
		const rendered = isChoiceSpec(this.spec)
			? this.renderChoiceBody(this.spec, line, innerWidth)
			: this.renderRowsBody(this.spec, line, innerWidth);
		if (this.message) {
			const messageStart = rendered.lines.length;
			rendered.lines.push(line());
			for (const text of wrapTextWithAnsi(this.message.text, Math.max(1, innerWidth - 8))) rendered.lines.push(line(`     ${tone(this.theme, this.message.tone, text)}`));
			rendered.selectedRange = { start: messageStart, end: Math.max(messageStart, rendered.lines.length - 1) };
		}
		const hasSettings = !isChoiceSpec(this.spec) && this.spec.rows.some((row) => row.kind === "setting");
		const fullHint = isChoiceSpec(this.spec)
			? "Arrow keys select · Enter confirm · Esc cancel"
			: hasSettings
				? "↑↓ navigate · ←→ select · Enter confirm · Esc cancel"
				: "↑↓ select · Enter confirm · Esc close";
		const compactHint = "Arrows select · Enter confirm · Esc";
		const hint = visibleWidth(fullHint) <= innerWidth - 1 ? fullHint : compactHint;
		const footer = [border(`├${"─".repeat(innerWidth)}┤`), line(` ${this.theme.fg("dim", hint)}`), border(`╰${"─".repeat(innerWidth)}╯`)];
		const terminalRows = this.tui.terminal?.rows;
		const maxLines = terminalRows && Number.isFinite(terminalRows) ? Math.max(1, Math.floor(terminalRows * 0.9)) : Number.POSITIVE_INFINITY;
		if (maxLines < header.length + footer.length + 1) {
			const selectedLine = rendered.lines[rendered.selectedRange.start] ?? rendered.lines[0] ?? header[1]!;
			const compact = maxLines >= 3 ? [header[0]!, selectedLine, footer.at(-1)!] : [selectedLine];
			return compact.slice(0, maxLines).map((value) => truncateToWidth(value, width, ""));
		}
		const availableBody = maxLines - header.length - footer.length;
		let body = rendered.lines;
		if (body.length > availableBody) {
			const latestStart = Math.max(0, body.length - availableBody);
			const start = Math.max(0, Math.min(latestStart, rendered.selectedRange.end - availableBody + 1, rendered.selectedRange.start));
			body = body.slice(start, start + availableBody);
		}
		return [...header, ...body, ...footer].map((value) => truncateToWidth(value, width, ""));
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
			overlayOptions: { width: 76, minWidth: 44, maxHeight: "90%", anchor: "center", margin: 1 },
		},
	);
}
