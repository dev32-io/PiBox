import { relative } from "node:path";
import { DEFAULT_MAX_LINES, renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Text } from "@earendil-works/pi-tui";
import { LinePrefixedComponent } from "./tool-shell.js";

type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
type PreviewLine = { text: string; omitted?: boolean; diff?: boolean };

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
		case "bash": return String(args.command ?? "").replace(/\s+/g, " ").slice(0, 90);
		case "grep": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "find": return `${args.pattern ?? ""} in ${shortenPath(args.path ?? ".", cwd)}`;
		case "ls": return shortenPath(args.path ?? ".", cwd);
	}
}

function countLabel(name: ToolName, args: any, lines: string[]): string | undefined {
	if (name === "edit" || name === "write") {
		let additions = 0;
		let removals = 0;
		for (const line of lines) {
			if (line.startsWith("+") && !line.startsWith("+++")) additions++;
			if (line.startsWith("-") && !line.startsWith("---")) removals++;
		}
		if (additions || removals) return `+${additions} −${removals}`;
	}
	if (lines.length === 0) return undefined;
	const noun = name === "grep" ? "matches" : name === "find" ? "files" : name === "ls" ? "entries" : "lines";
	return `${lines.length} ${noun}`;
}

function previewLimit(name: ToolName): number {
	return name === "read" ? 10 : 3;
}

function previewLines(name: ToolName, lines: string[], expanded: boolean): PreviewLine[] {
	if (expanded) return lines.map((text) => ({ text, diff: name === "edit" || name === "write" }));
	if (name === "edit") {
		const shown: PreviewLine[] = lines.slice(0, DEFAULT_MAX_LINES).map((text) => ({ text, diff: true }));
		if (lines.length > DEFAULT_MAX_LINES) shown.push({ text: `+${lines.length - DEFAULT_MAX_LINES} more lines`, omitted: true });
		return shown;
	}
	const limit = previewLimit(name);
	const selected = name === "bash" ? lines.slice(-limit) : lines.slice(0, limit);
	const shown: PreviewLine[] = selected.map((text) => ({ text, diff: name === "write" }));
	if (lines.length > selected.length) shown.push({ text: `+${lines.length - selected.length} more lines`, omitted: true });
	return shown;
}

function appendPreview(container: Container, name: ToolName, lines: PreviewLine[], theme: Theme): void {
	const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
	for (const line of lines) {
		let content: string;
		if (line.omitted) {
			const color = name === "edit" ? "warning" : "dim";
			content = theme.fg(color, `… ${line.text} (${toggle} to expand)`);
		} else {
			content = line.diff ? line.text : theme.fg("dim", line.text);
		}
		container.addChild(new LinePrefixedComponent(new Text(content, 0, 0), "   ", "   ", 3, 3));
	}
}

export function renderToolCall(name: ToolName, args: any, theme: Theme, ctx: any): Text {
	const isError = ctx.isError;
	const prefix = ctx.isPartial ? theme.fg("muted", "✽") : isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const header = `${prefix} ${theme.bold(theme.fg("toolTitle", actionLabel(name, ctx)))} ${theme.fg("dim", summary(name, args, ctx.cwd ?? process.cwd()))}`;
	const detail = ctx.isPartial ? `\n${theme.fg("dim", "└─")} ${theme.fg("muted", "Running…")}` : "";
	const component = ctx.lastComponent instanceof Text ? ctx.lastComponent : new Text("", 0, 0);
	component.setText(header + detail);
	return component;
}

export function renderToolResult(name: ToolName, result: any, options: { expanded: boolean }, theme: Theme, ctx: any): Container {
	const metadata = name === "write" ? writeMetadata(result) : undefined;
	if (metadata && ctx.state && ctx.state.piboxWrite !== metadata) {
		ctx.state.piboxWrite = metadata;
		ctx.invalidate?.();
	}

	const raw = firstText(result);
	let rawLines = nonEmptyLines(raw);
	const diff = name === "edit" ? result.details?.diff : metadata?.diff;
	if (diff) rawLines = diff.split("\n");
	const renderedLines = diff ? renderDiff(diff).split("\n") : rawLines;
	const error = !!ctx.isError;
	const status = error ? theme.fg("error", "Error") : theme.fg("success", "Done");
	const count = countLabel(name, ctx.args ?? {}, rawLines);
	const countText = count ? `${theme.fg("dim", " • ")}${theme.fg("muted", count)}` : "";
	const component = new Container();
	component.addChild(new Text(`${theme.fg("dim", "└─")} ${status}${countText}`, 0, 0));
	if (renderedLines.length > 0) appendPreview(component, name, previewLines(name, renderedLines, options.expanded), theme);
	return component;
}
