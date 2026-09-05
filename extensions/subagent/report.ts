import type { TerminalResult } from "./api.js";

export const DEFAULT_REPORT_CHARACTERS = 8_000;
export const MAX_REPORT_CHARACTERS = 12_000;

export function terminalReportText(terminal: TerminalResult): string {
	return terminal.text || terminal.stderr || `Subagent ${terminal.status}.`;
}

/** Code-point offsets avoid splitting Unicode characters; at most 48KB of report text. */
export function readReportPage(text: string, offset = 0, limit = DEFAULT_REPORT_CHARACTERS) {
	if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Report offset must be a non-negative safe integer");
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_CHARACTERS) throw new Error(`Report limit must be between 1 and ${MAX_REPORT_CHARACTERS}`);
	const characters = Array.from(text);
	if (offset > characters.length) throw new Error(`Report offset exceeds ${characters.length} characters`);
	const count = Math.min(limit, characters.length - offset);
	const end = offset + count;
	return {
		text: characters.slice(offset, end).join(""),
		offset,
		count,
		totalCharacters: characters.length,
		...(end < characters.length ? { nextOffset: end } : {}),
	};
}
