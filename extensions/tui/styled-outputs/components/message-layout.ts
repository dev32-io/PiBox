import type { Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

interface PrefixOptions {
	prefix: string;
	prefixColor: "accent" | "text" | "thinkingText";
	bodyColor?: "text" | "thinkingText";
	italic?: boolean;
}

export function createPrefixedMarkdown(
	text: string,
	markdownTheme: ConstructorParameters<typeof Markdown>[3],
	theme: Theme,
	options: PrefixOptions,
): { render(width: number): string[]; invalidate(): void } {
	const markdown = new Markdown(text, 0, 0, markdownTheme, {
		...(options.bodyColor ? { color: (value: string) => theme.fg(options.bodyColor!, value) } : {}),
		...(options.italic ? { italic: true } : {}),
	});
	const prefixWidth = visibleWidth(options.prefix) + 2;
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;

	return {
		invalidate(): void {
			cachedWidth = undefined;
			cachedLines = undefined;
			markdown.invalidate();
		},
		render(width: number): string[] {
			if (cachedWidth === width && cachedLines) return cachedLines;
			const prefix = theme.fg(options.prefixColor, options.prefix);
			if (width <= prefixWidth) return [` ${prefix}`];
			const lines = markdown.render(width - prefixWidth);
			let placed = false;
			cachedLines = lines.map((line) => {
				if (!placed && visibleWidth(line.trim()) > 0) {
					placed = true;
					return ` ${prefix} ${line}`;
				}
				return `${" ".repeat(prefixWidth)}${line}`;
			});
			cachedWidth = width;
			return cachedLines;
		},
	};
}
