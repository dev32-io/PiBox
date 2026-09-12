import { stripVTControlCharacters } from "node:util";

export const MAX_SUBAGENT_TITLE_CHARACTERS = 80;

/** Model-authored labels are plain display text, never terminal control sequences. */
export function normalizeSubagentTitle(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	return stripVTControlCharacters(value.replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c)/g, ""))
		.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
		.replace(/\s+/g, " ").trim() || undefined;
}

/** Keep status headings compact without shortening the stored logical label. */
export function shortSubagentTitle(value: string | undefined): string | undefined {
	const normalized = normalizeSubagentTitle(value);
	return normalized ? Array.from(normalized).slice(0, MAX_SUBAGENT_TITLE_CHARACTERS).join("") : undefined;
}
