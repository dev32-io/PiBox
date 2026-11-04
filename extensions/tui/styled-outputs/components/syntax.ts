import { getLanguageFromPath, highlightCode } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

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
export function highlightLines(text: string, language: string | undefined): { lines: string[]; plain: boolean } | undefined {
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
