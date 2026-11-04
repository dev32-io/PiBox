import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

export type StyledLine = { text: string; bg?: "toolSuccessBg" | "toolErrorBg" };

const INVERSE = "\x1b[7m";
export const INVERSE_OFF = "\x1b[27m";

export function languageForPath(path: unknown): string | undefined {
	return typeof path === "string" && path ? getLanguageFromPath(path) : undefined;
}

/** Output that carries no syntax: Pi's no-language fallback, or the raw text when Pi 1.0.0's highlighter throws. */
export function isUnhighlighted(highlighted: string[], source: string[], fallback: string[]): boolean {
	return highlighted.every((line, index) => line === fallback[index] || line === source[index]);
}

/**
 * Highlights one snippet so multi-line constructs keep their context. Pi's highlighter colors
 * unsupported languages as code-block text and swallows its own failures, so only a result whose
 * visible text matches the input and differs from that no-language output is trusted; anything else
 * falls back to the caller's plain style. `plain` marks a snippet that merely has no tokens to color.
 */
function highlightLines(text: string, language: string | undefined): { lines: string[]; plain: boolean } | undefined {
	if (!language) return undefined;
	try {
		const source = text.split("\n");
		const highlighted = highlightCode(text, language);
		if (highlighted.length !== source.length || highlighted.some((line, index) => stripTerminalSequences(line) !== source[index])) return undefined;
		return { lines: highlighted, plain: isUnhighlighted(highlighted, source, highlightCode(text, undefined)) };
	} catch {
		return undefined;
	}
}

export function highlightSnippet(text: string, language: string | undefined): string[] | undefined {
	const result = highlightLines(text, language);
	return result && !result.plain ? result.lines : undefined;
}

function isWordCharacter(value: string | undefined): boolean {
	return value !== undefined && /\w/.test(value);
}

/** Smallest changed middle of a modified line, widened to whole words and stripped of leading indentation. */
function changedRange(before: string, after: string): { removed: [number, number]; added: [number, number] } | undefined {
	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;
	while (start > 0 && isWordCharacter(before[start - 1]) && (isWordCharacter(before[start]) || isWordCharacter(after[start]))) start--;
	let end = 0;
	while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
	while (end > 0 && isWordCharacter(before[before.length - end]) && isWordCharacter(before[before.length - end - 1])) end--;
	const removed: [number, number] = [start, before.length - end];
	const added: [number, number] = [start, after.length - end];
	const lead = (value: string, range: [number, number]) => { while (range[0] < range[1] && /\s/.test(value[range[0]]!)) range[0]++; };
	lead(before, removed);
	lead(after, added);
	return removed[0] < removed[1] || added[0] < added[1] ? { removed, added } : undefined;
}

/** Wraps visible characters [start, end) of an ANSI-styled line in reverse video. */
function invertRange(line: string, [start, end]: [number, number]): string {
	if (start >= end) return line;
	let visible = 0;
	return line.split(/(\x1b\[[0-9;]*m)/).map((part) => {
		if (part.startsWith("\x1b[")) return part;
		const from = Math.max(start - visible, 0);
		const to = Math.min(end - visible, part.length);
		visible += part.length;
		return from < to ? `${part.slice(0, from)}${INVERSE}${part.slice(from, to)}${INVERSE_OFF}${part.slice(to)}` : part;
	}).join("");
}

type DiffEntry = { kind: "add" | "del" | "ctx"; number: string; content: string; segment: number } | { kind: "other"; raw: string };

/**
 * Renders Pi diff lines (`+NN code`) with syntax-colored code, a colored gutter, a tinted background on
 * changed lines, and reverse-video emphasis on the changed span of single-line modifications. Returns
 * undefined when the language cannot be highlighted so callers keep Pi's own diff rendering.
 */
export function renderSyntaxDiff(diff: string, language: string | undefined, theme: Theme): StyledLine[] | undefined {
	if (!language) return undefined;
	let segment = 0;
	const entries: DiffEntry[] = diff.split("\n").map((raw) => {
		const match = raw.match(/^([+-\s])(\s*\d*)\s(.*)$/);
		if (!match || !match[2]!.trim()) { segment++; return { kind: "other", raw }; }
		const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
		return { kind, number: match[2]!, content: match[3]!.replace(/\t/g, "   "), segment };
	});
	const highlighted = new Map<DiffEntry, string>();
	let colored = false;
	for (let id = 0; id <= segment; id++) {
		for (const side of ["del", "add"] as const) {
			const code = entries.filter((entry): entry is Extract<DiffEntry, { content: string }> => entry.kind !== "other" && entry.segment === id && (entry.kind === "ctx" || entry.kind === side));
			if (code.length === 0) continue;
			const result = highlightLines(code.map((entry) => entry.content).join("\n"), language);
			if (!result) return undefined;
			// A snippet without tokens (blank lines, a lone brace) is fine as long as the diff has some coloring.
			colored ||= !result.plain;
			const lines = result.lines;
			// Context lines take their coloring from the new side.
			code.forEach((entry, index) => { if (side === "add" || entry.kind === "del") highlighted.set(entry, lines[index]!); });
		}
	}
	if (!colored) return undefined;
	const sign = { add: "+", del: "-", ctx: " " } as const;
	const gutterColor = { add: "toolDiffAdded", del: "toolDiffRemoved", ctx: "toolDiffContext" } as const;
	const styled = entries.map((entry): StyledLine => {
		if (entry.kind === "other") return { text: theme.fg("toolDiffContext", entry.raw) };
		return {
			text: `${theme.fg(gutterColor[entry.kind], `${sign[entry.kind]}${entry.number} `)}${highlighted.get(entry)}`,
			...(entry.kind === "add" ? { bg: "toolSuccessBg" as const } : entry.kind === "del" ? { bg: "toolErrorBg" as const } : {}),
		};
	});
	// Pi's rule: emphasize inside a change only when exactly one line was replaced by one line.
	for (let index = 1; index < entries.length; index++) {
		const removed = entries[index - 1]!;
		const added = entries[index]!;
		if (removed.kind !== "del" || added.kind !== "add" || entries[index - 2]?.kind === "del" || entries[index + 1]?.kind === "add") continue;
		const range = changedRange(removed.content, added.content);
		if (!range) continue;
		const gutter = (entry: Extract<DiffEntry, { content: string }>) => theme.fg(gutterColor[entry.kind], `${sign[entry.kind]}${entry.number} `);
		styled[index - 1] = { ...styled[index - 1]!, text: `${gutter(removed)}${invertRange(highlighted.get(removed)!, range.removed)}` };
		styled[index] = { ...styled[index]!, text: `${gutter(added)}${invertRange(highlighted.get(added)!, range.added)}` };
	}
	return styled;
}
