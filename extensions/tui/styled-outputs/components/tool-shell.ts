import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** Prefix a rendered component without depending on the tool's own component type. */
export class LinePrefixedComponent implements Component {
	constructor(
		private readonly child: Component,
		private readonly firstPrefix: string,
		private readonly continuationPrefix: string,
		private readonly firstPrefixWidth: number,
		private readonly continuationPrefixWidth: number,
		private readonly firstSuffix = "",
		private readonly firstSuffixWidth = 0,
		private readonly maxLines?: number,
		private readonly firstLineStyle?: (text: string) => string,
		private readonly overflowLine?: (omitted: number) => string,
	) {}

	render(width: number): string[] {
		const reserved = Math.max(this.firstPrefixWidth + this.firstSuffixWidth, this.continuationPrefixWidth);
		const rendered = this.child.render(Math.max(1, width - reserved));
		const lines = this.maxLines === undefined ? rendered : rendered.slice(0, this.maxLines);
		const output = lines.map((line, index) => {
			// Box renderers pad every line to their full width. Remove that visual tail
			// so lifecycle hints sit beside the status instead of at the far edge.
			const plain = stripTerminalSequences(line);
			const trimmed = plain.trimEnd();
			let compact = truncateToWidth(line, visibleWidth(trimmed), "");
			if (index === 0) {
				// The lifecycle prefix replaces a Box's cosmetic left padding on its
				// status line; nested output keeps its renderer-provided indentation.
				const leadingWidth = visibleWidth(trimmed.match(/^\s*/)?.[0] ?? "");
				compact = this.firstLineStyle
					? this.firstLineStyle(trimmed.trimStart())
					: sliceByColumn(compact, leadingWidth, Math.max(0, visibleWidth(trimmed) - leadingWidth), true);
				return `${this.firstPrefix}${compact}${this.firstSuffix}`;
			}
			return `${this.continuationPrefix}${compact}`;
		});
		const omitted = rendered.length - lines.length;
		if (omitted > 0 && this.overflowLine) {
			const overflow = truncateToWidth(this.overflowLine(omitted), Math.max(1, width - this.continuationPrefixWidth));
			output.push(`${this.continuationPrefix}${overflow}`);
		}
		return output;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}
