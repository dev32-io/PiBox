import { VERSION, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StartupCounts } from "./discovery.js";

export interface StartupKeys {
	model: string;
	permissions: string;
}

const PI_ART = [
	"██████╗ ██╗",
	"██╔══██╗██║",
	"██████╔╝██║",
	"██╔═══╝ ██║",
	"╚═╝     ╚═╝",
];

function fit(value: string, width: number): string {
	const clipped = truncateToWidth(value, width, "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function center(value: string, width: number): string {
	const remaining = Math.max(0, width - visibleWidth(value));
	const left = Math.floor(remaining / 2);
	return " ".repeat(left) + value + " ".repeat(remaining - left);
}

function plural(value: number, label: string): string {
	return `${value} ${label}${value === 1 ? "" : "s"}`;
}

export function renderStartup(theme: Theme, counts: StartupCounts, keys: StartupKeys, width: number): string[] {
	if (width < 24) return [truncateToWidth(theme.fg("accent", `PiBox · Pi ${VERSION}`), width, "")];
	if (width < 64) {
		const details = `${plural(counts.models, "model")} · ${counts.components} visual components${counts.contextFiles === undefined ? "" : ` · ${plural(counts.contextFiles, "context file")}`}`;
		return [
			`${theme.fg("accent", "PiBox")}${theme.fg("dim", ` · Pi ${VERSION}`)}`,
			truncateToWidth(theme.fg("muted", details), width, ""),
			truncateToWidth(theme.fg("dim", `/ commands · ! bash · ${keys.model} model · ${keys.permissions} permissions`), width, "…"),
			"",
		];
	}

	const boxWidth = Math.min(width, 82);
	const innerWidth = boxWidth - 2;
	const artWidth = 20;
	const countWidth = 27;
	const tipsWidth = innerWidth - artWidth - countWidth;
	const border = (value: string) => theme.fg("borderMuted", value);
	const title = ` PiBox · Pi ${VERSION} `;
	const titleFill = Math.max(1, boxWidth - visibleWidth(title) - 4);
	const countLines = [
		plural(counts.models, "model"),
		plural(counts.components, "visual component"),
		...(counts.contextFiles === undefined ? [] : [plural(counts.contextFiles, "context file")]),
	];
	const tips = [
		`${theme.fg("accent", "/")} for commands`,
		`${theme.fg("warning", "!")} to run bash`,
		`${theme.fg("dim", keys.model)} cycle model`,
		`${theme.fg("dim", keys.permissions)} toggle permissions`,
	];
	const art = ["", ...PI_ART.map((line) => center(theme.bold(theme.fg("accent", line)), artWidth)), ""];
	const countColumn = [
		"",
		...countLines.map((line) => {
			const [number, ...rest] = line.split(" ");
			return `${theme.fg("dim", "•")} ${theme.fg("success", number ?? "0")} ${rest.join(" ")}`;
		}),
		"",
	];
	const tipColumn = ["", ...tips, ""];
	const rows = Math.max(art.length, countColumn.length, tipColumn.length);
	const lines = [
		"",
		`${border("┌──")}${theme.fg("accent", title)}${border(`${"─".repeat(titleFill)}┐`)}`,
	];
	for (let index = 0; index < rows; index++) {
		lines.push(
			border("│") +
				fit(art[index] ?? "", artWidth) +
				fit(` ${countColumn[index] ?? ""}`, countWidth) +
				fit(` ${tipColumn[index] ?? ""}`, tipsWidth) +
				border("│"),
		);
	}
	lines.push(border(`└${"─".repeat(innerWidth)}┘`), "");
	return lines;
}
