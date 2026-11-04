import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { builtinToolIcon, ICON_EXPLORE } from "../../icons.js";
import { plural } from "./plural.js";
import { formatToolDuration, formatToolElapsed, runningGlyph, type ToolTiming } from "./tool-activity.js";
import { actionLabel, classifyLoadedResource, countLabel, firstText, nonEmptyLines, shortenPath } from "./tool-renderers.js";

/*
 * Consecutive read-only exploration calls render as one tree anchored on the first call.
 *
 * Grouping signal: Pi renders an assistant message (`AssistantMessageComponent.updateContent`)
 * and then creates that message's tool rows in content order, both while streaming
 * (`message_update`) and when replaying history (`renderSessionItems`), in Pi 1.0 and 1.5 alike.
 * The observed content is the authority for "same message, nothing in between": its ordered
 * `toolCall` blocks and any visible text between them. A row binds once, on its first display, to
 * the last observed message containing its id, so providers that reuse ids across messages
 * (`call_0`) stay apart. Records live on the transcript's own components and are released with
 * them; only the last observed message is held globally, cleared at session boundaries.
 */

const EXPLORE_TOOLS = new Set(["read", "grep", "find", "ls"]);
// Pi detects images by content; a path check catches the common case before any result exists.
const IMAGE_PATH = /\.(png|jpe?g|gif|webp|bmp)$/i;
const KINDS: Array<[string, string, string]> = [
	["read", "file", "files"],
	["grep", "search", "searches"],
	["find", "glob", "globs"],
	["ls", "directory", "directories"],
];

const MESSAGE_RECORD = Symbol.for("pibox:styled-outputs:explore-message");
const ROW_RECORD = Symbol.for("pibox:styled-outputs:explore-record");
const ROW_ROLE = Symbol.for("pibox:styled-outputs:explore-role");
const ROW_OPEN = Symbol.for("pibox:styled-outputs:explore-open");
const ROW_GLOBAL = Symbol.for("pibox:styled-outputs:explore-global");
const LATEST_KEY = Symbol.for("pibox:styled-outputs:explore-latest");

export type ExploreRole = "solo" | "anchor" | "member";

/** The ToolExecutionComponent fields a group reads. */
export interface ExploreRow {
	toolCallId: string;
	toolName: string;
	args: any;
	cwd?: string;
	expanded: boolean;
	isPartial: boolean;
	result?: { isError?: boolean; content?: any[] };
	rendererState?: { piboxTiming?: ToolTiming };
	resultRendererComponent?: Component;
	ui?: { requestRender?(): void };
	updateDisplay(): void;
}

interface ExploreRecord {
	ids: Set<string>;
	runs: Map<string, string[]>;
	rows: Map<string, ExploreRow>;
}

type Slot = { latest?: ExploreRecord | undefined };

function slot(): Slot {
	const root = globalThis as typeof globalThis & { [LATEST_KEY]?: Slot };
	return (root[LATEST_KEY] ??= {});
}

export function isExploreCall(name: string, args: any): boolean {
	if (!EXPLORE_TOOLS.has(name)) return false;
	if (name !== "read") return true;
	// Skill and rule reads already collapse to a one-line `Loaded skill X`.
	const path = String(args?.path ?? args?.file_path ?? "");
	return !classifyLoadedResource(path) && !IMAGE_PATH.test(path);
}

/** Runs of consecutive exploration calls; any other tool call or visible text ends a run. Thinking is never shown between rows. */
export function exploreRuns(content: readonly any[]): Pick<ExploreRecord, "ids" | "runs"> {
	const ids = new Set<string>();
	const runs = new Map<string, string[]>();
	let run: string[] | undefined;
	for (const block of content) {
		if (block?.type === "toolCall") {
			ids.add(block.id);
			if (!isExploreCall(block.name, block.arguments)) {
				run = undefined;
				continue;
			}
			run ??= [];
			run.push(block.id);
			runs.set(block.id, run);
		} else if (block?.type === "text" && block.text?.trim()) run = undefined;
	}
	return { ids, runs };
}

export function observeAssistantContent(owner: object, content: readonly any[]): void {
	const host = owner as { [MESSAGE_RECORD]?: ExploreRecord };
	const record = (host[MESSAGE_RECORD] ??= { ids: new Set(), runs: new Map(), rows: new Map() });
	Object.assign(record, exploreRuns(content));
	slot().latest = record;
	// A shown row changes role when a sibling call streams in or its args turn it into a skill read.
	refreshExploreRoles(record);
}

/** Re-renders every shown row whose role no longer matches what it displays. */
export function refreshExploreRoles(record: ExploreRecord): void {
	for (const row of record.rows.values()) if (exploreRole(row) !== (row as any)[ROW_ROLE]) row.updateDisplay();
}

/** Pi attaches images outside the row's own container, so a row that returned one cannot sit inside a group tree. */
function hasImage(row: ExploreRow | undefined): boolean {
	return !!row?.result?.content?.some?.((item: any) => item?.type === "image");
}

/** The stretch of the run around `id` that can show inside one tree: a read that returned an image stands alone and splits the run. */
function groupedRun(record: ExploreRecord | null, id: string): string[] | undefined {
	const run = record?.runs.get(id);
	if (!run || hasImage(record!.rows.get(id))) return undefined;
	let start = run.indexOf(id);
	let end = start;
	while (start > 0 && !hasImage(record!.rows.get(run[start - 1]!))) start--;
	while (end < run.length - 1 && !hasImage(record!.rows.get(run[end + 1]!))) end++;
	return run.slice(start, end + 1);
}

export function resetExploreGroups(): void {
	slot().latest = undefined;
}

export function exploreRole(row: ExploreRow): ExploreRole {
	const host = row as any;
	if (host[ROW_RECORD] === undefined) {
		const latest = slot().latest;
		host[ROW_RECORD] = latest?.ids.has(row.toolCallId) ? latest : null;
		host[ROW_RECORD]?.rows.set(row.toolCallId, row);
	}
	const record: ExploreRecord | null = host[ROW_RECORD];
	const run = groupedRun(record, row.toolCallId);
	// Members hide only behind a live anchor row.
	if (!record || !run || run.length < 2 || !run.includes(row.toolCallId) || record.rows.get(run[0]!) === undefined) return "solo";
	return run[0] === row.toolCallId ? "anchor" : "member";
}

/** Records the role a row was last displayed with; the global expand toggle resets a group's click state. */
export function applyExploreRole(row: ExploreRow): ExploreRole {
	const host = row as any;
	const role = exploreRole(row);
	host[ROW_ROLE] = role;
	if (role === "anchor" && host[ROW_GLOBAL] !== row.expanded) {
		host[ROW_GLOBAL] = row.expanded;
		host[ROW_OPEN] = undefined;
	}
	// A result carrying an image can split the group around this row.
	if (hasImage(row) && host[ROW_RECORD]) refreshExploreRoles(host[ROW_RECORD]);
	return role;
}

function isOpen(anchor: ExploreRow): boolean {
	return (anchor as any)[ROW_OPEN] ?? anchor.expanded;
}

/** `3 files, 1 search, 2 globs, 1 directory` in a fixed kind order. */
export function exploreCounts(names: readonly string[]): string {
	return KINDS.flatMap(([name, one, many]) => {
		const count = names.filter((candidate) => candidate === name).length;
		return count ? [plural(count, one, many)] : [];
	}).join(", ");
}

/** A member row's target: `AGENTS.md:1-12`, `pane=true in src`, `**\/*.ts`, `docs`. */
export function exploreTarget(name: string, args: any, cwd: string): string {
	const path = (value: unknown) => shortenPath(String(value ?? "."), cwd);
	let target: string;
	if (name === "read") {
		target = path(args.path ?? args.file_path);
		const start = Number(args.offset) || 1;
		const limit = Number(args.limit);
		if (args.offset !== undefined || args.limit !== undefined) target += limit > 0 ? `:${start}-${start + limit - 1}` : `:${start}`;
	} else if (name === "ls") {
		target = path(args.path);
	} else {
		target = String(args.pattern ?? "");
		if (args.path && args.path !== ".") target += ` in ${path(args.path)}`;
	}
	return target.replace(/\s+/g, " ").trim();
}

function timingOf(row: ExploreRow): ToolTiming | undefined {
	return row.rendererState?.piboxTiming;
}

/** Wall time from the first start to the last end; unknown when any member lacks either (restored history). */
function wallTime(rows: readonly ExploreRow[]): number | undefined {
	let start = Infinity;
	let end = -Infinity;
	for (const row of rows) {
		const timing = timingOf(row);
		if (timing?.startedAt === undefined || timing.durationMs === undefined) return undefined;
		start = Math.min(start, timing.startedAt);
		end = Math.max(end, timing.startedAt + timing.durationMs);
	}
	return rows.length ? end - start : undefined;
}

/** Live elapsed time; it stops where the host ended the run (`frozenAt`) for members that never finished. */
function elapsed(rows: readonly ExploreRow[], now = Date.now()): string | undefined {
	const timings = rows.map(timingOf);
	const starts = timings.flatMap((timing) => timing?.startedAt === undefined ? [] : [timing.startedAt]);
	if (!starts.length) return undefined;
	const live = rows.some((row, index) => row.isPartial && timings[index]?.startedAt !== undefined && timings[index]?.frozenAt === undefined);
	const end = live ? now : Math.max(...timings.map((timing) => timing?.frozenAt ?? (timing?.startedAt ?? -Infinity) + (timing?.durationMs ?? 0)));
	return formatToolElapsed(end - Math.min(...starts));
}

// Groups re-render every animation frame; split each (possibly large) output once.
const outcomes = new WeakMap<object, { count?: string | undefined; first?: string | undefined }>();

function outcome(name: string, result: object): { count?: string | undefined; first?: string | undefined } {
	let cached = outcomes.get(result);
	if (!cached) {
		const lines = nonEmptyLines(firstText(result));
		outcomes.set(result, cached = { count: countLabel(name as any, lines), first: lines[0] });
	}
	return cached;
}

function memberLabel(row: ExploreRow, theme: Theme): string {
	const name = row.toolName;
	const head = `${theme.fg("toolTitle", builtinToolIcon(name))} ${theme.fg("toolTitle", actionLabel(name as any, {}))} ${theme.fg("dim", exploreTarget(name, row.args ?? {}, row.cwd ?? process.cwd()))}`;
	const result = row.result && outcome(name, row.result);
	const status = row.isPartial
		? theme.fg("muted", "Running…")
		: row.result?.isError
			? theme.fg("error", `✗ ${result?.first ?? "Error"}`)
			: theme.fg("muted", result?.count ?? "");
	return `${head}${status ? `${theme.fg("dim", " • ")}${status}` : ""}`;
}

/**
 * The anchor row's whole display. The tree starts in the lifecycle-glyph column so the glyph, `├─`,
 * and `└─` form one line. Opening (click, or the global expand key) shows each member's own collapsed
 * preview, or its full output when the global key is on.
 */
class ExploreGroupView implements Component {
	constructor(private readonly anchor: ExploreRow, private readonly theme: Theme) {}

	render(width: number): string[] {
		const theme = this.theme;
		const record: ExploreRecord | null = (this.anchor as any)[ROW_RECORD];
		const run = groupedRun(record, this.anchor.toolCallId) ?? [this.anchor.toolCallId];
		const rows = run.flatMap((id) => record?.rows.get(id) ?? []);
		const running = rows.some((row) => row.isPartial);
		const glyph = running
			? theme.fg("muted", runningGlyph())
			: rows.some((row) => row.result?.isError) ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const time = running ? elapsed(rows) : (() => {
			const wall = wallTime(rows);
			return wall === undefined ? undefined : formatToolDuration(wall);
		})();
		const header = `${glyph} ${theme.fg("toolTitle", ICON_EXPLORE)} ${theme.bold(theme.fg("toolTitle", running ? "Exploring…" : "Explored"))} ${theme.fg("dim", exploreCounts(rows.map((row) => row.toolName)))}${time ? `${theme.fg("dim", " • ")}${theme.fg("muted", time)}` : ""}`;
		const lines = [truncateToWidth(header, width, "…")];
		const open = isOpen(this.anchor);
		const inner = Math.max(1, width - 3);
		rows.forEach((row, index) => {
			const last = index === rows.length - 1;
			const branch = `${theme.fg("dim", last ? "└─" : "├─")} `;
			const rail = last ? "   " : `${theme.fg("dim", "│")}  `;
			const label = memberLabel(row, theme);
			if (!open) {
				lines.push(truncateToWidth(`${branch}${label}`, width, "…"));
				return;
			}
			wrapTextWithAnsi(label, inner).forEach((segment, line) => lines.push(`${line === 0 ? branch : rail}${truncateToWidth(segment, inner, "")}`));
			if (row.result) for (const preview of row.resultRendererComponent?.render(inner) ?? []) lines.push(`${rail}${preview}`);
		});
		return lines;
	}

	handleMouse(event: any): any {
		if (event.type !== "click" || event.button !== "left") return undefined;
		(this.anchor as any)[ROW_OPEN] = !isOpen(this.anchor);
		this.anchor.ui?.requestRender?.();
		return { handled: true };
	}

	invalidate(): void {}
}

export function exploreGroupView(anchor: ExploreRow, theme: Theme): Component {
	return new ExploreGroupView(anchor, theme);
}
