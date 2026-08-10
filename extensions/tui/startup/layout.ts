import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StartupCounts } from "./discovery.js";

export interface StartupKeys {
	model: string;
	thinking: string;
}

function fit(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function titledRule(theme: Theme, width: number): string {
	const title = ` PiBox · Pi ${VERSION} `;
	if (width <= visibleWidth(title) + 2) return theme.fg("borderMuted", "─".repeat(width));
	return theme.fg("borderMuted", "┌─") + theme.fg("accent", title) + theme.fg("borderMuted", `${"─".repeat(width - visibleWidth(title) - 3)}┐`);
}

export function renderStartup(theme: Theme, counts: StartupCounts, keys: StartupKeys, width: number): string[] {
	if (width < 24) return [truncateToWidth(theme.fg("accent", `PiBox · Pi ${VERSION}`), width, "")];
	if (width < 52) {
		const details = `${counts.models} models · ${counts.components} TUI${counts.contextFiles === undefined ? "" : ` · ${counts.contextFiles} context`}`;
		return [
			theme.fg("accent", `PiBox`) + theme.fg("dim", ` · Pi ${VERSION}`),
			truncateToWidth(theme.fg("muted", details), width, ""),
			truncateToWidth(theme.fg("dim", `/ commands · ! bash · ${keys.model} model · ${keys.thinking} thinking`), width, "…"),
			"",
		];
	}

	const boxWidth = Math.min(width, 96);
	const inner = boxWidth - 2;
	const leftWidth = Math.min(30, Math.floor(inner * 0.38));
	const rightWidth = inner - leftWidth;
	const countLines = [
		`${theme.fg("success", String(counts.models))} model${counts.models === 1 ? "" : "s"}`,
		`${theme.fg("success", String(counts.components))} visual components`,
		...(counts.contextFiles === undefined
			? []
			: [`${theme.fg(counts.contextFiles > 0 ? "success" : "dim", String(counts.contextFiles))} context file${counts.contextFiles === 1 ? "" : "s"}`]),
	];
	const tips = [
		`${theme.fg("accent", "/")} commands`,
		`${theme.fg("warning", "!")} bash`,
		`${theme.fg("muted", keys.model)} model`,
		`${theme.fg("muted", keys.thinking)} thinking`,
	];
	const rows = Math.max(countLines.length, tips.length, 4);
	const lines = ["", titledRule(theme, boxWidth)];
	for (let index = 0; index < rows; index++) {
		const left = index === 0 ? theme.bold(theme.fg("text", "  PI / BOX")) : `  ${countLines[index - 1] ?? ""}`;
		const right = `  ${tips[index] ?? ""}`;
		lines.push(theme.fg("borderMuted", "│") + fit(left, leftWidth) + fit(right, rightWidth) + theme.fg("borderMuted", "│"));
	}
	lines.push(theme.fg("borderMuted", `└${"─".repeat(inner)}┘`), "");
	return lines;
}
