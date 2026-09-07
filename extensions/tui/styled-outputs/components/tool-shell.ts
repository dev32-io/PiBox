import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/** Prefix a rendered component without depending on the tool's own component type. */
export class LinePrefixedComponent implements Component {
	private mouseLayout: { width: number; height: number; shown: number; firstLineOffset: number } | undefined;
	private mouseRegion: { handleMouse(event: any): any } | undefined;

	// Use the host's actual region constructor, not our pi-tui dependency: the
	// host can support mouse while a locally resolved peer package is older.
	setMouseRegion(Region: new (child: Component, onMouse: () => undefined) => { handleMouse(event: any): any }): void {
		this.mouseRegion = new Region(this.child, () => undefined);
	}

	// Pointer types were added after our minimum supported Pi version.
	handleMouse(event: any): any {
		const layout = this.mouseLayout;
		if (!layout || event.y < 0 || event.y >= layout.shown) return undefined;
		const prefix = event.y === 0 ? this.firstPrefixWidth : this.continuationPrefixWidth;
		const x = event.x - prefix;
		const offset = event.y === 0 ? layout.firstLineOffset : 0;
		if (x < 0 || x + offset >= layout.width) return undefined;
		return this.mouseRegion?.handleMouse({
			...event, x: x + offset, width: layout.width, height: layout.height,
		});
	}

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
		// Tool previews contain source or command output, where leading whitespace is
		// meaningful. Shell wrappers can still remove their Box padding by default.
		private readonly stripFirstLinePadding = true,
	) {}

	render(width: number): string[] {
		const reserved = Math.max(this.firstPrefixWidth + this.firstSuffixWidth, this.continuationPrefixWidth);
		const childWidth = Math.max(1, width - reserved);
		const rendered = this.child.render(childWidth);
		const lines = this.maxLines === undefined ? rendered : rendered.slice(0, this.maxLines);
		this.mouseLayout = { width: childWidth, height: rendered.length, shown: lines.length, firstLineOffset: 0 };
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
				if (this.firstLineStyle || this.stripFirstLinePadding) this.mouseLayout!.firstLineOffset = leadingWidth;
				compact = this.firstLineStyle
					? this.firstLineStyle(trimmed.trimStart())
					: this.stripFirstLinePadding
						? sliceByColumn(compact, leadingWidth, Math.max(0, visibleWidth(trimmed) - leadingWidth), true)
						: compact;
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
		this.mouseLayout = undefined;
		this.child.invalidate?.();
	}
}
