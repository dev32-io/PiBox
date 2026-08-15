import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const ANSI_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g;
const SCROLL_PATTERN = /((?:↑|↓)\s*\d+\s*more)/;

export function plainText(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

export function scrollLabel(value: string): string | undefined {
	return plainText(value).match(SCROLL_PATTERN)?.[1];
}

export function isEditorRail(value: string): boolean {
	const plain = plainText(value);
	return plain.length > 0 && (plain.replace(/─/g, "").length === 0 || (plain.startsWith("─") && SCROLL_PATTERN.test(plain)));
}

export interface LabelRange {
	start: number;
	end: number;
}

export function centeredTopLabelRange(width: number, leftLabel: string | undefined, centerLabel: string | undefined): LabelRange | undefined {
	if (!centerLabel || width < 2) return undefined;
	const inner = width - 2;
	const leftDecoration = leftLabel ? truncateToWidth(`── ${leftLabel} `, inner, "") : "";
	const decoration = truncateToWidth(` ${centerLabel} `, inner, "");
	const decorationWidth = visibleWidth(decoration);
	const start = 1 + Math.max(0, Math.floor((inner - decorationWidth) / 2));
	if (start < 1 + visibleWidth(leftDecoration)) return undefined;
	return { start, end: start + decorationWidth };
}

function borderLine(
	width: number,
	position: "top" | "bottom",
	label: string | undefined,
	paint: (value: string) => string,
	centerLabel?: string,
	paintCenter: (value: string) => string = paint,
): string {
	if (width < 2) return paint("─".repeat(Math.max(0, width)));
	const left = position === "top" ? "┌" : "└";
	const right = position === "top" ? "┐" : "┘";
	const inner = width - 2;
	const decoration = label ? truncateToWidth(`── ${label} `, inner, "") : "";
	const centerRange = position === "top" ? centeredTopLabelRange(width, label, centerLabel) : undefined;
	if (!centerRange || !centerLabel) {
		const fill = "─".repeat(Math.max(0, inner - visibleWidth(decoration)));
		return paint(`${left}${decoration}${fill}${right}`);
	}
	const centerDecoration = truncateToWidth(` ${centerLabel} `, centerRange.end - centerRange.start, "");
	const beforeWidth = centerRange.start - 1;
	const before = decoration + "─".repeat(Math.max(0, beforeWidth - visibleWidth(decoration)));
	const after = "─".repeat(Math.max(0, inner - beforeWidth - visibleWidth(centerDecoration)));
	return paint(`${left}${before}`) + paintCenter(centerDecoration) + paint(`${after}${right}`);
}

export interface BoxRenderOptions {
	width: number;
	contentWidth: number;
	paddingX: number;
	prefix: string;
	paintBorder: (value: string) => string;
	paintPrefix: (value: string) => string;
	topCenterLabel?: string;
	paintTopCenterLabel?: (value: string) => string;
}

/** Convert the native editor rails/body/menu into a framed editor. */
export function frameEditorLines(stock: string[], options: BoxRenderOptions): string[] | undefined {
	const firstRail = stock.findIndex(isEditorRail);
	let lastRail = -1;
	for (let index = stock.length - 1; index >= 0; index--) {
		if (isEditorRail(stock[index] ?? "")) {
			lastRail = index;
			break;
		}
	}
	if (firstRail < 0 || lastRail <= firstRail) return undefined;

	const top = borderLine(options.width, "top", scrollLabel(stock[firstRail] ?? ""), options.paintBorder, options.topCenterLabel, options.paintTopCenterLabel);
	const bottom = borderLine(options.width, "bottom", scrollLabel(stock[lastRail] ?? ""), options.paintBorder);
	const horizontalPadding = " ".repeat(options.paddingX);
	const prefixWidth = visibleWidth(options.prefix);
	const blankPrefix = " ".repeat(prefixWidth);
	const body: string[] = [];

	for (let index = firstRail + 1; index < lastRail; index++) {
		const source = truncateToWidth(stock[index] ?? "", options.contentWidth, "");
		const fill = " ".repeat(Math.max(0, options.contentWidth - visibleWidth(source)));
		const prompt = index === firstRail + 1 ? options.paintPrefix(options.prefix) : blankPrefix;
		body.push(
			options.paintBorder("│") +
				horizontalPadding +
				prompt +
				" " +
				source +
				fill +
				horizontalPadding +
				options.paintBorder("│"),
		);
	}

	// Native autocomplete and hint rows occur after the lower editor rail.
	const menu = stock.slice(lastRail + 1).map((line) => truncateToWidth(` ${line}`, options.width, ""));
	return [top, ...body, bottom, ...menu];
}
