import { relative } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Text } from "@earendil-works/pi-tui";

const MAX_EXPANDED_LINES = 40;

type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

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

function summary(name: ToolName, args: any, cwd: string): string {
	switch (name) {
		case "read":
		case "edit":
		case "write": return shortenPath(args.path ?? args.file_path ?? "", cwd);
		case "bash": return String(args.command ?? "").replace(/\s+/g, " ").slice(0, 90);
		case "grep": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "find": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "ls": return shortenPath(args.path ?? ".", cwd);
	}
}

function label(name: ToolName): string {
	return name === "bash" ? "Bash" : name[0]?.toUpperCase() + name.slice(1);
}

function trimLines(lines: string[], strategy: "head" | "tail" | "head-tail"): Array<{ text: string; omitted?: boolean }> {
	if (lines.length <= MAX_EXPANDED_LINES) return lines.map((text) => ({ text }));
	if (strategy === "head") return [
		...lines.slice(0, MAX_EXPANDED_LINES).map((text) => ({ text })),
		{ text: `─── ${lines.length - MAX_EXPANDED_LINES} more lines ───`, omitted: true },
	];
	if (strategy === "tail") return [
		{ text: `─── ${lines.length - MAX_EXPANDED_LINES} lines above ───`, omitted: true },
		...lines.slice(-MAX_EXPANDED_LINES).map((text) => ({ text })),
	];
	const half = Math.floor(MAX_EXPANDED_LINES / 2);
	return [
		...lines.slice(0, half).map((text) => ({ text })),
		{ text: `─── ${lines.length - half * 2} more lines ───`, omitted: true },
		...lines.slice(-half).map((text) => ({ text })),
	];
}

function expandedOutput(lines: string[], strategy: "head" | "tail" | "head-tail", theme: Theme): string {
	return trimLines(lines, strategy)
		.map((line) => `\n   ${theme.fg(line.omitted ? "muted" : "dim", line.text)}`)
		.join("");
}

function countLabel(name: ToolName, args: any, lines: string[]): string | undefined {
	if (name === "edit") {
		const count = Array.isArray(args.edits) ? args.edits.length : 0;
		return count > 0 ? `${count} edit${count === 1 ? "" : "s"}` : undefined;
	}
	if (name === "write") {
		const count = typeof args.content === "string" ? args.content.split("\n").length : 0;
		return count > 0 ? `${count} line${count === 1 ? "" : "s"}` : undefined;
	}
	if (lines.length === 0) return undefined;
	const noun = name === "grep" ? "matches" : name === "find" ? "files" : name === "ls" ? "entries" : "lines";
	return `${lines.length} ${noun}`;
}

export function renderToolCall(name: ToolName, args: any, theme: Theme, ctx: any): Text {
	const isError = ctx.isError;
	const prefix = ctx.isPartial ? theme.fg("muted", "✽") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const header = `${prefix} ${theme.bold(theme.fg("toolTitle", label(name)))} ${theme.fg("dim", summary(name, args, ctx.cwd ?? process.cwd()))}`;
	const detail = ctx.isPartial ? `\n${theme.fg("dim", "└─")} ${theme.fg("muted", "Running…")}` : "";
	const component = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
	component.setText(header + detail);
	return component;
}

export function renderToolResult(name: ToolName, result: any, options: { expanded: boolean }, theme: Theme, ctx: any): Text {
	const raw = firstText(result);
	let lines = nonEmptyLines(raw);
	if (name === "edit" && options.expanded && result.details?.diff) lines = renderDiff(result.details.diff).split("\n");
	const error = !!ctx.isError;
	const status = error ? theme.fg("error", "Error") : theme.fg("success", "Done");
	const count = countLabel(name, ctx.args ?? {}, lines);
	const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
	const hint = !options.expanded && lines.length > 0 ? theme.fg("dim", ` • ${toggle} to expand`) : "";
	const countText = count ? `${theme.fg("dim", " • ")}${theme.fg("muted", count)}` : "";
	let text = `${theme.fg("dim", "└─")} ${status}${countText}${hint}`;
	if (options.expanded && lines.length > 0) {
		const strategy = name === "bash" ? "tail" : name === "read" || name === "edit" ? "head-tail" : "head";
		text += expandedOutput(lines, strategy, theme);
	}
	const component = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}
