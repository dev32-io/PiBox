import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const MAX_PROMPT_LINES = 5;
const MAX_PROMPT_CHARACTERS = 500;

/** Display-only preview: never truncate the assignment sent to the child. */
export function renderSubagentPrompt(task: unknown, expanded: boolean, width: number, theme: Theme): string[] {
	if (typeof task !== "string" || width < 1) return [];
	const text = stripTerminalSequences(task.replace(/\r\n?/g, "\n"))
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.replace(/\t/g, "   ");
	if (!text.trim()) return [];

	let preview = text;
	let truncated = false;
	if (!expanded) {
		let end = 0;
		let count = 0;
		for (const character of text) {
			if (count === MAX_PROMPT_CHARACTERS) break;
			end += character.length;
			count++;
		}
		preview = text.slice(0, end);
		truncated = end < text.length;
	}
	const indent = " ".repeat(Math.min(6, Math.max(0, width - 1)));
	const rows = wrapTextWithAnsi(preview, Math.max(1, width - indent.length));
	const shown = expanded ? rows : rows.slice(0, MAX_PROMPT_LINES);
	truncated ||= shown.length < rows.length;
	const lines = [truncateToWidth(theme.fg("dim", "   Prompt:"), width, "…")];
	for (const row of shown) {
		lines.push(truncateToWidth(indent + theme.fg("muted", row), width, "…"));
	}
	if (truncated) {
		const toggle = getKeybindings().getKeys("app.tools.expand")[0] ?? "ctrl+o";
		lines.push(truncateToWidth(indent + theme.fg("dim", `… (${toggle} to expand)`), width, "…"));
	}
	return lines;
}
