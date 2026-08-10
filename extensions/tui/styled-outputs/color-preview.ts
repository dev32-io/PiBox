import type { ColorPreviewConfig } from "./config.js";

const RESET = "\x1b[0m";
const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const URL_PATTERN = /https?:\/\/[^\s<>)]+/g;
const LINK_DESTINATION_PATTERN = /\]\([^\n)]*\)/g;
const INLINE_CODE_PATTERN = /(`+)([^\n]*?)\1/g;

interface Range {
	start: number;
	end: number;
}

function rangesFor(pattern: RegExp, value: string): Range[] {
	pattern.lastIndex = 0;
	return [...value.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

function isProtected(index: number, ranges: Range[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

export function expandHex(value: string): [number, number, number] {
	const hex = value.slice(1);
	if (hex.length === 3) return [...hex].map((digit) => Number.parseInt(digit + digit, 16)) as [number, number, number];
	return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

function linearize(channel: number): number {
	const normalized = channel / 255;
	return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(red: number, green: number, blue: number): number {
	return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

export function colorChip(value: string): string {
	const [red, green, blue] = expandHex(value);
	const foreground = relativeLuminance(red, green, blue) > 0.179 ? "0;0;0" : "255;255;255";
	return `\x1b[48;2;${red};${green};${blue}m\x1b[38;2;${foreground}m${value}${RESET}`;
}

function decorateLine(line: string, config: ColorPreviewConfig): string {
	const protectedRanges = [
		...rangesFor(ANSI_PATTERN, line),
		...rangesFor(URL_PATTERN, line),
		...rangesFor(LINK_DESTINATION_PATTERN, line),
		...(config.includeInlineCode ? [] : rangesFor(INLINE_CODE_PATTERN, line)),
	];
	const alternatives = [config.formats.includes("rgb6") ? "[0-9a-fA-F]{6}" : "", config.formats.includes("rgb3") ? "[0-9a-fA-F]{3}" : ""]
		.filter(Boolean)
		.join("|");
	if (!alternatives) return line;
	const pattern = new RegExp(`#(?:${alternatives})(?![0-9a-fA-F])`, "g");
	let output = "";
	let cursor = 0;
	for (const match of line.matchAll(pattern)) {
		const index = match.index;
		const previous = line[index - 1];
		if (isProtected(index, protectedRanges) || (previous !== undefined && /[0-9A-Za-z_]/.test(previous))) continue;
		output += line.slice(cursor, index) + colorChip(match[0]);
		cursor = index + match[0].length;
	}
	return output + line.slice(cursor);
}

export function decorateHexColors(markdown: string, config: ColorPreviewConfig): string {
	if (!config.enabled) return markdown;
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				const wasInFence = inFence;
				inFence = !inFence;
				return !config.includeFencedCode || !wasInFence ? line : decorateLine(line, config);
			}
			return inFence && !config.includeFencedCode ? line : decorateLine(line, config);
		})
		.join("\n");
}
