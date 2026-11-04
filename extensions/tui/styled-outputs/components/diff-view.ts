import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { plural } from "./plural.js";
import { highlightLines } from "./syntax.js";

/** Render widths at or above this show old and new side by side; narrower widths stay unified. */
export const SPLIT_VIEW_MIN_WIDTH = 140;
const BAR_WIDTH = 10;
// Word emphasis is noise on very long lines or on pairs that are mostly rewritten.
const WORD_DIFF_MAX_LINE = 500;
const WORD_DIFF_MAX_CHANGED = 0.6;
// Unequal change runs pair lines by similarity only while the pairwise comparisons stay small.
const SIMILARITY_PAIRING_MAX = 100;
// Above this size, diffs render plain: no syntax highlighting and no word emphasis.
const RICH_DIFF_MAX_CHARS = 80_000;
const INDENT = "   ";
const RESET = "\x1b[0m";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const MODEL_CACHE_LIMIT = 24;
const LAYOUT_CACHE_LIMIT = 8;

type Kind = "add" | "del" | "ctx";
type Span = [number, number];
type Entry = { kind: Kind; old?: number; new?: number; content: string; spans?: Span[]; styled?: string };
/** `fold` is the count of unchanged lines hidden before the hunk (0 when unknown); undefined means nothing is hidden. */
type Hunk = { fold?: number; entries: Entry[] };
type Tint = { open: string; emphasisOn: string; emphasisOff: string };
type Model = {
	key: string;
	hunks: Hunk[];
	additions: number;
	removals: number;
	numberWidth: number;
	tints: Record<"add" | "del", Tint>;
	layouts: Map<string, string[]>;
};

const models = new Map<string, Model>();

function openCode(styled: string): string {
	return styled.slice(0, Math.max(0, styled.indexOf("\0")));
}

function rgb(code: string): number[] | undefined {
	const match = code.match(/\x1b\[(?:38|48);2;(\d+);(\d+);(\d+)m/);
	return match ? match.slice(1, 4).map(Number) : undefined;
}

/** A truecolor tint gets a brighter emphasis background mixed toward its line color; other color modes use reverse video. */
function tint(theme: Theme, bg: "toolSuccessBg" | "toolErrorBg", fg: "toolDiffAdded" | "toolDiffRemoved"): Tint {
	const open = openCode(theme.bg(bg, "\0"));
	const base = rgb(open);
	const accent = rgb(openCode(theme.fg(fg, "\0")));
	if (!base || !accent) return { open, emphasisOn: INVERSE_ON, emphasisOff: INVERSE_OFF };
	const mixed = base.map((value, index) => Math.round(value + (accent[index]! - value) * 0.3));
	return { open, emphasisOn: `\x1b[48;2;${mixed.join(";")}m`, emphasisOff: open };
}

function clean(content: string): string {
	return content.replace(/\t/g, "   ").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Parses Pi's `generateDiffString` output. Context rows carry old numbers; new numbers follow from the running offset. */
function parse(diff: string): Pick<Model, "hunks" | "additions" | "removals" | "numberWidth"> {
	const hunks: Hunk[] = [];
	let current: Hunk | undefined;
	let folded = false;
	let offset = 0;
	let oldCursor = 1;
	let additions = 0;
	let removals = 0;
	let largest = 0;
	for (const raw of diff.split("\n")) {
		const match = raw.match(/^([+\- ])\s*(\d+)(?: (.*))?$/);
		if (!match) {
			// Pi's `...` separator; any other unparsable row also ends the hunk.
			if (raw.trim()) { folded = true; current = undefined; }
			continue;
		}
		const kind: Kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
		const number = Number(match[2]);
		const entry: Entry = { kind, content: clean(match[3] ?? "") };
		if (kind === "add") { entry.new = number; offset++; additions++; } else {
			entry.old = number;
			if (kind === "ctx") entry.new = number + offset; else { offset--; removals++; }
		}
		largest = Math.max(largest, entry.old ?? 0, entry.new ?? 0);
		if (!current) {
			current = { entries: [] };
			if (folded) current.fold = entry.old === undefined ? 0 : Math.max(0, entry.old - oldCursor);
			folded = false;
			hunks.push(current);
		}
		if (entry.old !== undefined) oldCursor = entry.old + 1;
		current.entries.push(entry);
	}
	return { hunks, additions, removals, numberWidth: Math.max(2, String(largest).length) };
}

type Token = { text: string; start: number };

function tokens(value: string): Token[] {
	return [...value.matchAll(/\w+|\s+|./gsu)].map((match) => ({ text: match[0], start: match.index! }));
}

function changedSpans(list: Token[], kept: boolean[]): Span[] {
	const spans: Span[] = [];
	list.forEach((token, index) => {
		if (kept[index] || !token.text.trim()) return;
		const last = spans.at(-1);
		const previous = list[index - 1];
		// Join neighboring changes, bridging the whitespace between two changed words.
		if (last && (last[1] === token.start || (previous && last[1] === previous.start && !previous.text.trim()))) last[1] = token.start + token.text.length;
		else spans.push([token.start, token.start + token.text.length]);
	});
	return spans;
}

const solid = (value: string, spans: Span[]) => spans.reduce((sum, [from, to]) => sum + value.slice(from, to).replace(/\s/g, "").length, 0);

/** Word-level LCS of two lines. Undefined when nothing visible changed, a line is too long, or the pair is too dissimilar. */
export function wordDiff(before: string, after: string): { removed: Span[]; added: Span[]; changed: number } | undefined {
	if (before.length > WORD_DIFF_MAX_LINE || after.length > WORD_DIFF_MAX_LINE) return undefined;
	const a = tokens(before);
	const b = tokens(after);
	const columns = b.length + 1;
	const table = new Uint16Array((a.length + 1) * columns);
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i * columns + j] = a[i]!.text === b[j]!.text
				? table[(i + 1) * columns + j + 1]! + 1
				: Math.max(table[(i + 1) * columns + j]!, table[i * columns + j + 1]!);
		}
	}
	const keptA = a.map(() => false);
	const keptB = b.map(() => false);
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		if (a[i]!.text === b[j]!.text) { keptA[i++] = true; keptB[j++] = true; } else if (table[(i + 1) * columns + j]! >= table[i * columns + j + 1]!) i++; else j++;
	}
	const removed = changedSpans(a, keptA);
	const added = changedSpans(b, keptB);
	const total = before.replace(/\s/g, "").length + after.replace(/\s/g, "").length;
	const changed = total ? (solid(before, removed) + solid(after, added)) / total : 0;
	if (!removed.length && !added.length) return undefined;
	return changed > WORD_DIFF_MAX_CHANGED ? undefined : { removed, added, changed };
}

/** Equal runs pair 1:1; unequal runs pair each removed line with its most similar later added line. Unpaired lines get no emphasis. */
function emphasizeRun(removed: Entry[], added: Entry[]): void {
	const apply = (left: Entry, right: Entry, result: NonNullable<ReturnType<typeof wordDiff>>) => { left.spans = result.removed; right.spans = result.added; };
	if (removed.length === added.length || removed.length * added.length > SIMILARITY_PAIRING_MAX) {
		for (let index = 0; index < Math.min(removed.length, added.length); index++) {
			const result = wordDiff(removed[index]!.content, added[index]!.content);
			if (result) apply(removed[index]!, added[index]!, result);
		}
		return;
	}
	let next = 0;
	for (const left of removed) {
		let best: { index: number; result: NonNullable<ReturnType<typeof wordDiff>> } | undefined;
		for (let index = next; index < added.length; index++) {
			const result = wordDiff(left.content, added[index]!.content);
			if (result && (!best || result.changed < best.result.changed)) best = { index, result };
		}
		if (!best) continue;
		apply(left, added[best.index]!, best.result);
		next = best.index + 1;
	}
}

/** Changed runs are the maximal stretches of removed and added rows between context rows. */
function changeRuns(entries: Entry[]): { removed: Entry[]; added: Entry[] }[] {
	const runs: { removed: Entry[]; added: Entry[] }[] = [];
	let run: { removed: Entry[]; added: Entry[] } | undefined;
	for (const entry of entries) {
		if (entry.kind === "ctx") { run = undefined; continue; }
		if (!run) runs.push(run = { removed: [], added: [] });
		(entry.kind === "del" ? run.removed : run.added).push(entry);
	}
	return runs;
}

/** Highlights each hunk side as one snippet; context rows take the new side's colors. False when the language cannot be highlighted. */
function highlight(hunks: Hunk[], language: string | undefined): boolean {
	if (!language) return false;
	const styled = new Map<Entry, string>();
	let colored = false;
	for (const hunk of hunks) {
		for (const side of ["del", "add"] as const) {
			const code = hunk.entries.filter((entry) => entry.kind === "ctx" || entry.kind === side);
			if (code.length === 0) continue;
			const result = highlightLines(code.map((entry) => entry.content).join("\n"), language);
			if (!result) return false;
			colored ||= !result.plain;
			code.forEach((entry, index) => { if (side === "add" || entry.kind === "del") styled.set(entry, result.lines[index]!); });
		}
	}
	if (!colored) return false;
	for (const [entry, line] of styled) entry.styled = line;
	return true;
}

function fingerprint(theme: Theme, language: string | undefined): string {
	return [language ?? "", theme.fg("toolDiffAdded", ""), theme.fg("toolDiffRemoved", ""), theme.fg("syntaxKeyword", ""), theme.bg("toolSuccessBg", ""), theme.bg("toolErrorBg", "")].join("\0");
}

function model(diff: string, language: string | undefined, theme: Theme): Model {
	const key = fingerprint(theme, language);
	const cached = models.get(diff);
	if (cached?.key === key) {
		models.delete(diff);
		models.set(diff, cached);
		return cached;
	}
	const parsed = parse(diff);
	const rich = diff.length <= RICH_DIFF_MAX_CHARS;
	const highlighted = rich && highlight(parsed.hunks, language);
	for (const hunk of parsed.hunks) {
		if (rich) for (const run of changeRuns(hunk.entries)) emphasizeRun(run.removed, run.added);
		if (!highlighted) for (const entry of hunk.entries) entry.styled = theme.fg(entry.kind === "add" ? "toolDiffAdded" : entry.kind === "del" ? "toolDiffRemoved" : "toolDiffContext", entry.content);
	}
	const result: Model = {
		key,
		...parsed,
		tints: { add: tint(theme, "toolSuccessBg", "toolDiffAdded"), del: tint(theme, "toolErrorBg", "toolDiffRemoved") },
		layouts: new Map(),
	};
	models.delete(diff);
	models.set(diff, result);
	if (models.size > MODEL_CACHE_LIMIT) models.delete(models.keys().next().value!);
	return result;
}

function proportionBar(additions: number, removals: number, theme: Theme): string {
	let added = Math.round(BAR_WIDTH * additions / (additions + removals));
	// Any nonzero side keeps at least one cell.
	if (additions && !added) added = 1;
	if (removals && added === BAR_WIDTH) added = BAR_WIDTH - 1;
	return `${theme.fg("dim", "▕")}${theme.fg("success", "━".repeat(added))}${theme.fg("error", "━".repeat(BAR_WIDTH - added))}${theme.fg("dim", "▏")}`;
}

/** Styled status-line items: `+a −r ▕bar▏` and the hunk count; empty when the diff changes nothing. */
export function diffStatus(diff: string, language: string | undefined, theme: Theme): string[] {
	const { additions, removals, hunks } = model(diff, language, theme);
	if (!additions && !removals) return [];
	const changed = hunks.filter((hunk) => hunk.entries.some((entry) => entry.kind !== "ctx")).length;
	return [`${theme.fg("muted", `+${additions} −${removals}`)} ${proportionBar(additions, removals, theme)}`, theme.fg("muted", plural(changed, "hunk"))];
}

function emphasize(line: string, spans: Span[], on: string, off: string): string {
	let visible = 0;
	return line.split(/(\x1b\[[0-9;]*m)/).map((part) => {
		if (part.startsWith("\x1b[")) return part;
		const base = visible;
		visible += part.length;
		let output = "";
		let cursor = 0;
		for (const [start, end] of spans) {
			const from = Math.max(start - base, cursor);
			const to = Math.min(end - base, part.length);
			if (from >= to) continue;
			output += `${part.slice(cursor, from)}${on}${part.slice(from, to)}${off}`;
			cursor = to;
		}
		return output + part.slice(cursor);
	}).join("");
}

type Layout = { model: Model; theme: Theme };

/** One diff line wrapped to `width` columns, continuation rows aligned to the code column; tinted rows fill their width. */
function lineRows({ model, theme }: Layout, entry: Entry, side: "old" | "new" | "unified", width: number, fill: boolean, clip?: number): string[] {
	const number = side === "old" ? entry.old : side === "new" ? entry.new : entry.kind === "add" ? entry.new : entry.old;
	const gutter = `${entry.kind === "add" ? "+" : entry.kind === "del" ? "-" : " "}${String(number).padStart(model.numberWidth)} `;
	const codeWidth = Math.max(1, width - gutter.length);
	const tinted = entry.kind === "ctx" ? undefined : model.tints[entry.kind];
	let code = entry.styled ?? entry.content;
	if (tinted && entry.spans?.length) code = emphasize(code, entry.spans, tinted.emphasisOn, tinted.emphasisOff);
	if (clip !== undefined) code = truncateToWidth(code, clip, "…");
	// A reset inside highlighted code would drop the row tint.
	if (tinted) code = code.replace(/\x1b\[(?:0|49)?m/g, `$&${tinted.open}`);
	const open = tinted?.open ?? "";
	const color = entry.kind === "add" ? "toolDiffAdded" : entry.kind === "del" ? "toolDiffRemoved" : "toolDiffContext";
	return wrapTextWithAnsi(code, codeWidth).map((segment, index) => {
		const bounded = truncateToWidth(segment, codeWidth, "");
		const head = index === 0 ? theme.fg(color, gutter) : " ".repeat(gutter.length);
		const pad = tinted || fill ? " ".repeat(Math.max(0, width - gutter.length - visibleWidth(bounded))) : "";
		// Emphasis that crosses a wrap is closed before the padding, which keeps only the row tint.
		return `${open}${head}${bounded}${INVERSE_OFF}${open}${pad}${RESET}`;
	});
}

function foldRow({ model, theme }: Layout, hunk: Hunk, width: number, fill: boolean): string {
	const text = `… ${hunk.fold ? `${plural(hunk.fold, "unchanged line")} ` : "unchanged lines "}…`;
	const gutter = model.numberWidth + 2;
	const row = truncateToWidth(`${" ".repeat(gutter)}${theme.fg("dim", text)}`, width, "");
	return `${row}${fill ? " ".repeat(Math.max(0, width - visibleWidth(row))) : ""}${RESET}`;
}

function unified(layout: Layout, hunks: Shown[], width: number): string[] {
	const inner = Math.max(1, width - INDENT.length);
	return hunks.flatMap(({ hunk, entries }) => [
		...(hunk.fold === undefined ? [] : [foldRow(layout, hunk, inner, false)]),
		...entries.flatMap(({ entry, clip }) => lineRows(layout, entry, "unified", inner, false, clip)),
	]).map((row) => `${INDENT}${row}`);
}

function split(layout: Layout, hunks: Shown[], width: number): string[] {
	const border = (value: string) => layout.theme.fg("borderMuted", value);
	const leftWidth = Math.floor((width - INDENT.length - 7) / 2);
	const rightWidth = width - INDENT.length - 7 - leftWidth;
	const rows = [`${INDENT}${border(`┌${"─".repeat(leftWidth + 2)}┬${"─".repeat(rightWidth + 2)}┐`)}`];
	const join = (left: string, right: string) => `${INDENT}${border("│")} ${left} ${border("│")} ${right} ${border("│")}`;
	const pair = (left: Shown["entries"][number] | undefined, right: Shown["entries"][number] | undefined) => {
		const cell = (item: typeof left, side: "old" | "new", cellWidth: number) => item ? lineRows(layout, item.entry, side, cellWidth, true, item.clip) : [];
		const leftRows = cell(left, "old", leftWidth);
		const rightRows = cell(right, "new", rightWidth);
		const blank = (item: typeof left, cellWidth: number) => item && item.entry.kind !== "ctx"
			? `${layout.model.tints[item.entry.kind].open}${" ".repeat(cellWidth)}${RESET}`
			: " ".repeat(cellWidth);
		for (let index = 0; index < Math.max(leftRows.length, rightRows.length); index++) {
			rows.push(join(leftRows[index] ?? blank(left, leftWidth), rightRows[index] ?? blank(right, rightWidth)));
		}
	};
	for (const { hunk, entries } of hunks) {
		if (hunk.fold !== undefined) rows.push(join(foldRow(layout, hunk, leftWidth, true), foldRow(layout, hunk, rightWidth, true)));
		let removed: Shown["entries"] = [];
		let added: Shown["entries"] = [];
		const flush = () => {
			for (let index = 0; index < Math.max(removed.length, added.length); index++) pair(removed[index], added[index]);
			removed = [];
			added = [];
		};
		for (const item of entries) {
			if (item.entry.kind === "ctx") { flush(); pair(item, item); } else (item.entry.kind === "del" ? removed : added).push(item);
		}
		flush();
	}
	rows.push(`${INDENT}${border(`└${"─".repeat(leftWidth + 2)}┴${"─".repeat(rightWidth + 2)}┘`)}`);
	return rows;
}

type Shown = { hunk: Hunk; entries: { entry: Entry; clip?: number }[] };

/** Leading context before the first change folds away, so a collapsed preview opens on the change itself. */
function fromFirstChange(hunks: Hunk[]): Hunk[] {
	const [first, ...rest] = hunks;
	const skip = first?.entries.findIndex((entry) => entry.kind !== "ctx") ?? -1;
	if (!first || skip <= 0) return hunks;
	// A fold of 0 means the hidden count is unknown; it stays unknown.
	const fold = first.fold === 0 ? 0 : (first.fold ?? 0) + skip;
	return [{ fold, entries: first.entries.slice(skip) }, ...rest];
}

/** The collapsed preview keeps the first `limit` diff lines within an optional character budget; a line crossing the budget is clipped. */
function visible(hunks: Hunk[], limit: number | undefined, characterLimit = Infinity): { shown: Shown[]; hiddenLines: number; hiddenHunks: number; clipped: boolean } {
	if (limit === undefined) return { shown: hunks.map((hunk) => ({ hunk, entries: hunk.entries.map((entry) => ({ entry })) })), hiddenLines: 0, hiddenHunks: 0, clipped: false };
	hunks = fromFirstChange(hunks);
	const shown: Shown[] = [];
	let lines = limit;
	let characters = characterLimit;
	let hiddenLines = 0;
	let hiddenHunks = 0;
	let clipped = false;
	for (const hunk of hunks) {
		const entries: Shown["entries"] = [];
		for (const entry of hunk.entries) {
			if (lines <= 0 || characters <= 0) { hiddenLines++; continue; }
			lines--;
			const clip = entry.content.length > characters ? characters : undefined;
			clipped ||= clip !== undefined;
			characters -= entry.content.length;
			entries.push(clip === undefined ? { entry } : { entry, clip });
		}
		if (entries.length) shown.push({ hunk, entries }); else hiddenHunks++;
	}
	return { shown, hiddenLines, hiddenHunks, clipped };
}

export type DiffViewOptions = { expanded: boolean; limit: number; characterLimit?: number; toggle: string; hintColor: "warning" | "dim" };

/** Unified below SPLIT_VIEW_MIN_WIDTH columns, framed side by side at or above it; output is cached per diff, width, and options. */
export class DiffView implements Component {
	private readonly model: Model;

	constructor(diff: string, language: string | undefined, private readonly theme: Theme, private readonly options: DiffViewOptions) {
		this.model = model(diff, language, theme);
	}

	render(width: number): string[] {
		const { expanded, limit, characterLimit, toggle, hintColor } = this.options;
		const key = `${width}\0${expanded}\0${limit}\0${characterLimit}\0${toggle}\0${hintColor}`;
		const cached = this.model.layouts.get(key);
		if (cached) return cached;
		const { shown, hiddenLines, hiddenHunks, clipped } = visible(this.model.hunks, expanded ? undefined : limit, characterLimit);
		const layout = { model: this.model, theme: this.theme };
		const rows = width >= SPLIT_VIEW_MIN_WIDTH ? split(layout, shown, width) : unified(layout, shown, width);
		if (hiddenLines || clipped) {
			const parts = [hiddenLines ? plural(hiddenLines, "more diff line") : "", hiddenHunks ? plural(hiddenHunks, "more hunk") : "", `${toggle} to expand`].filter(Boolean);
			rows.push(truncateToWidth(`${INDENT}${this.theme.fg(hintColor, `… ${parts.join(" • ")}`)}`, width, ""));
		}
		// Every row ends with a full reset so no style reaches the host's own padding.
		const bounded = rows.map((row) => row.endsWith(RESET) ? row : `${row}${RESET}`);
		if (this.model.layouts.size >= LAYOUT_CACHE_LIMIT) this.model.layouts.clear();
		this.model.layouts.set(key, bounded);
		return bounded;
	}

	invalidate(): void {}
}
