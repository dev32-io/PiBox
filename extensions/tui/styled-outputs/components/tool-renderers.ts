import { relative } from "node:path";
import { DEFAULT_MAX_LINES, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, sliceByColumn, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { builtinToolIcon } from "../../icons.js";
import { formatToolDuration, runningGlyph, runningStatus, type ToolTiming } from "./tool-activity.js";
import { plural } from "./plural.js";
import { DiffView, diffStatus } from "./diff-view.js";
import { highlightSnippet, languageForPath } from "./syntax.js";
import { LinePrefixedComponent } from "./tool-shell.js";

type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type PreviewLine = { text: string; omitted?: boolean; diff?: boolean };
type LoadedResource = { kind: "skill" | "rule"; label: string };

export function classifyLoadedResource(path: string): LoadedResource | undefined {
	const normalized = path.replaceAll("\\", "/");
	const skill = normalized.match(/(?:^|\/)skills\/(.+?)\/SKILL\.md$/i);
	if (skill?.[1]) return { kind: "skill", label: skill[1] };
	const rule = normalized.match(/(?:^|\/)\.(?:claude|pi)\/(?:agent\/)?rules\/(.+?)\.md$/i);
	if (rule?.[1]) return { kind: "rule", label: rule[1] };
	return undefined;
}

// A small number of machine-generated lines (for example, source maps) can wrap
// into a full screen. Keep collapsed tool output scannable by limiting that case
// by characters as well as by logical lines.
const COLLAPSED_PREVIEW_CHARACTER_LIMIT = 1_200;
// Collapsed multi-line commands (heredocs, scripts) show this many real lines, each wrapped in full.
const COLLAPSED_COMMAND_LINES = 3;

/** Pi >=1.5 formats the host's configured keys; older hosts fall back to our keybinding registry. */
export function expandKeyLabel(ctx?: any): string {
	const hosted = typeof ctx?.keyText === "function" ? String(ctx.keyText("app.tools.expand") ?? "").split("/")[0] : "";
	return hosted || getKeybindings().getKeys("app.tools.expand")[0] || "ctrl+o";
}

function shortenPath(value: string, cwd: string): string {
	if (!value) return ".";
	const home = process.env.HOME;
	if (home && (value === home || value.startsWith(`${home}/`))) return `~${value.slice(home.length)}`;
	const result = relative(cwd, value);
	return result && !result.startsWith("..") ? result : value;
}

function firstText(result: any): string {
	return result?.content?.find((part: any) => part?.type === "text")?.text ?? "";
}

function nonEmptyLines(value: string): string[] {
	if (!value || value === "(no output)") return [];
	return value.split("\n").filter((line) => line.trim().length > 0);
}

function writeMetadata(result: any): { action?: "create" | "rewrite"; diff?: string } | undefined {
	return result?.details?.piboxWrite;
}

function actionLabel(name: ToolName, ctx: any): string {
	if (name === "edit") return "Update";
	if (name === "write") {
		const action = ctx.state?.piboxWrite?.action;
		if (action === "create") return "Create";
		if (action === "rewrite") return "Rewrite";
		return "Write";
	}
	return name === "bash" ? "Bash" : name[0]?.toUpperCase() + name.slice(1);
}

function summary(name: ToolName, args: any, cwd: string): string {
	switch (name) {
		case "read":
		case "edit":
		case "write": return shortenPath(args.path ?? args.file_path ?? "", cwd);
		case "bash": return String(args.command ?? "");
		case "grep": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "find": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "ls": return shortenPath(args.path ?? ".", cwd);
	}
}

function countLabel(name: ToolName, lines: string[]): string | undefined {
	if (lines.length === 0) return undefined;
	switch (name) {
		case "grep": return plural(lines.length, "match", "matches");
		case "find": return plural(lines.length, "file");
		case "ls": return plural(lines.length, "entry", "entries");
		default: return plural(lines.length, "line");
	}
}

function previewLimit(name: ToolName): number {
	return name === "read" ? 10 : 3;
}

function previewLines(name: ToolName, lines: string[], expanded: boolean): PreviewLine[] {
	if (expanded) return lines.map((text) => ({ text, diff: name === "edit" || name === "write" }));
	if (name === "edit") {
		const shown: PreviewLine[] = lines.slice(0, DEFAULT_MAX_LINES).map((text) => ({ text, diff: true }));
		if (lines.length > DEFAULT_MAX_LINES) shown.push({ text: `+${plural(lines.length - DEFAULT_MAX_LINES, "more line")}`, omitted: true });
		return shown;
	}
	const limit = previewLimit(name);
	const selected = name === "bash" ? lines.slice(-limit) : lines.slice(0, limit);
	const selectedText = selected.join("\n");
	const hiddenLineCharacters = lines.slice(name === "bash" ? 0 : selected.length, name === "bash" ? -selected.length : undefined).join("\n").length;
	if (selectedText.length > COLLAPSED_PREVIEW_CHARACTER_LIMIT) {
		const omitted = selectedText.length - COLLAPSED_PREVIEW_CHARACTER_LIMIT + hiddenLineCharacters;
		return [
			{ text: selectedText.slice(0, COLLAPSED_PREVIEW_CHARACTER_LIMIT), diff: name === "write" },
			{ text: `+${omitted} more characters`, omitted: true },
		];
	}
	const shown: PreviewLine[] = selected.map((text) => ({ text, diff: name === "write" }));
	if (lines.length > selected.length) shown.push({ text: `+${plural(lines.length - selected.length, "more line")}`, omitted: true });
	return shown;
}

function previewBody(name: ToolName, body: PreviewLine[], theme: Theme, language: string | undefined): string[] {
	const highlighted = name === "read" ? highlightSnippet(body.map((line) => line.text).join("\n"), language) : undefined;
	return highlighted ?? body.map((line) => line.diff ? line.text : theme.fg("dim", line.text));
}

function appendPreview(container: Container, name: ToolName, lines: PreviewLine[], theme: Theme, toggle: string, language: string | undefined): void {
	const rows = previewBody(name, lines.filter((line) => !line.omitted), theme, language);
	for (const line of lines) {
		if (line.omitted) rows.push(theme.fg(name === "edit" ? "warning" : "dim", `… ${line.text} (${toggle} to expand)`));
	}
	for (const row of rows) container.addChild(new LinePrefixedComponent(new Text(row, 0, 0), "   ", "   ", 3, 3, "", 0, undefined, undefined, undefined, false));
}

/**
 * Greedy fill that prefers a word break, but hard-breaks rather than orphaning a short word before a long path.
 * Each row measures only a window of the remaining text, so cost grows with row count rather than with row count x length.
 */
function wrapPlain(text: string, width: number): string[] {
	const lines: string[] = [];
	let position = 0;
	let window = Math.max(64, width * 2 + 8);
	for (;;) {
		let end = Math.min(text.length, position + window);
		// Zero-width characters can make a window narrower than it is long; widen until it overflows or the text ends.
		while (end < text.length && visibleWidth(text.slice(position, end)) <= width) end = Math.min(text.length, position + (window *= 2));
		const rest = text.slice(position, end);
		if (end >= text.length && visibleWidth(rest) <= width) {
			lines.push(rest);
			return lines;
		}
		const slice = sliceByColumn(rest, 0, width);
		const space = slice.lastIndexOf(" ");
		// A wide character that cannot fit still advances, so narrow widths cannot loop forever.
		const cut = space >= Math.ceil(slice.length / 2) ? space : Math.max(slice.length, String.fromCodePoint(rest.codePointAt(0)!).length);
		lines.push(rest.slice(0, cut).trimEnd());
		position += cut;
		if (text[position] === " ") position++;
	}
}

class ToolCallHeader implements Component {
	private cache: { width: number; lines: string[] } | undefined;

	constructor(
		private readonly theme: Theme,
		private readonly icon: string,
		private readonly action: string,
		private readonly target: string,
		private readonly status: "running" | "done" | "error",
		private readonly collapseMultiline: boolean,
		private readonly toggle: string,
		private readonly timing: ToolTiming | undefined,
	) {}

	render(width: number): string[] {
		const theme = this.theme;
		const glyph = this.status === "running"
			? theme.fg("muted", runningGlyph())
			: this.status === "error" ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const lines = [...this.body(width)];
		lines[0] = `${glyph}${lines[0]}`;
		if (this.status === "running") lines.push(truncateToWidth(`${theme.fg("dim", "└─")} ${theme.fg("muted", runningStatus(this.timing))}`, width, "…"));
		return lines;
	}

	// Everything after the one-column lifecycle glyph is stable per width; only the glyph and elapsed time change per frame.
	private body(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const theme = this.theme;
		const lead = ` ${theme.fg("toolTitle", this.icon)} ${theme.bold(theme.fg("toolTitle", this.action))}`;
		const indent = 1 + visibleWidth(lead) + 1;
		const available = Math.max(1, width - indent);
		// A rail under the lifecycle glyph joins wrapped header rows to the `└─` status branch below.
		const continuation = `${theme.fg("dim", "│")}${" ".repeat(indent - 1)}`;
		const targetLines = this.target ? this.target.split("\n") : [];
		// Only a command with real extra lines collapses; a long single line always wraps in full.
		const collapsed = this.collapseMultiline && targetLines.length > COLLAPSED_COMMAND_LINES;
		const shown = (collapsed ? targetLines.slice(0, COLLAPSED_COMMAND_LINES) : targetLines).flatMap((line) => wrapPlain(line, available));
		const lines = shown.length === 0
			? [lead]
			: shown.map((row, index) => index === 0 ? `${lead} ${theme.fg("dim", row)}` : `${continuation}${theme.fg("dim", row)}`);
		if (collapsed) lines.push(`${continuation}${theme.fg("dim", `… +${plural(targetLines.length - COLLAPSED_COMMAND_LINES, "line")} (${this.toggle} to expand)`)}`);
		const bounded = lines.map((line, index) => truncateToWidth(line, Math.max(1, width - (index === 0 ? 1 : 0)), ""));
		this.cache = { width, lines: bounded };
		return bounded;
	}

	invalidate(): void {
		this.cache = undefined;
	}
}

function displayTarget(name: ToolName, target: string): string {
	// Commands keep their own newlines; every other target is a single display line.
	if (name !== "bash") return target.replace(/\s+/g, " ").trim();
	return target
		.replace(/\r\n?/g, "\n")
		.replace(/\t/g, "   ")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
		.replace(/^\n+|\s+$/g, "");
}

export function renderToolCall(name: ToolName, args: any, theme: Theme, ctx: any): Component {
	const isError = ctx.isError;
	const loadedResource = name === "read" ? classifyLoadedResource(args.path ?? args.file_path ?? "") : undefined;
	const action = loadedResource ? ctx.isPartial ? "Loading" : isError ? "Load" : "Loaded" : actionLabel(name, ctx);
	const target = displayTarget(name, loadedResource ? `${loadedResource.kind} ${loadedResource.label}` : summary(name, args, ctx.cwd ?? process.cwd()));
	const status = ctx.isPartial ? "running" : isError ? "error" : "done";
	return new ToolCallHeader(theme, builtinToolIcon(name), action, target, status, !ctx.expanded, expandKeyLabel(ctx), ctx.state?.piboxTiming);
}

export function renderToolResult(name: ToolName, result: any, options: { expanded: boolean }, theme: Theme, ctx: any): Container {
	const loadedResource = name === "read" ? classifyLoadedResource(ctx.args?.path ?? ctx.args?.file_path ?? "") : undefined;
	if (loadedResource && !ctx.isError && !options.expanded) return new Container();
	const metadata = name === "write" ? writeMetadata(result) : undefined;
	if (metadata && ctx.state && ctx.state.piboxWrite !== metadata) {
		ctx.state.piboxWrite = metadata;
		queueMicrotask(() => ctx.invalidate?.());
	}

	const rawLines = nonEmptyLines(firstText(result));
	const diff: unknown = name === "edit" ? result.details?.diff : metadata?.diff;
	const language = loadedResource || ctx.isError ? undefined : languageForPath(ctx.args?.path ?? ctx.args?.file_path);
	const component = new Container();
	// The header owns the live `Running…` line; partial results contribute only their streaming preview.
	if (!ctx.isPartial) {
		const status = ctx.isError ? theme.fg("error", "Error") : theme.fg("success", "Done");
		const durationMs = typeof ctx.durationMs === "number" ? ctx.durationMs : ctx.state?.piboxTiming?.durationMs;
		const counts = typeof diff === "string" && diff ? diffStatus(diff, language, theme) : [countLabel(name, rawLines)].filter(Boolean).map((text) => theme.fg("muted", text!));
		const metadata = [...counts, ...(durationMs === undefined ? [] : [theme.fg("muted", formatToolDuration(durationMs))])]
			.map((text) => `${theme.fg("dim", " • ")}${text}`).join("");
		component.addChild(new Text(`${theme.fg("dim", "└─")} ${status}${metadata}`, 0, 0));
	}
	if (typeof diff === "string" && diff) {
		component.addChild(new DiffView(diff, language, theme, {
			expanded: options.expanded,
			toggle: expandKeyLabel(ctx),
			...(name === "edit"
				? { limit: DEFAULT_MAX_LINES, hintColor: "warning" as const }
				: { limit: previewLimit(name), characterLimit: COLLAPSED_PREVIEW_CHARACTER_LIMIT, hintColor: "dim" as const }),
		}));
	} else if (rawLines.length > 0) {
		appendPreview(component, name, previewLines(name, rawLines, options.expanded), theme, expandKeyLabel(ctx), language);
	}
	return component;
}
