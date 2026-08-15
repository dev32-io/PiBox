import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI, TuiInputListener } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CHAT_INPUT_CONFIG, normalizeChatInputConfig } from "./config.js";
import { centeredTopLabelRange, frameEditorLines, isEditorRail, plainText, scrollLabel, type LabelRange } from "./layout.js";

const THINKING_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

interface LayoutBoxView {
	component: Component;
	rect: { x: number; y: number; width: number; height: number };
	children: LayoutBoxView[];
	lines?: readonly string[];
}

interface FullscreenTuiInternals extends TUI {
	readonly isFollowingOutput: boolean;
	scrollToBottom(): void;
	inputListeners?: Set<TuiInputListener>;
	currentLayout?: { root: LayoutBoxView };
}

const SCROLL_TO_BOTTOM_LABEL = "↓ Scroll to bottom";

function findLabelPosition(root: LayoutBoxView | undefined, component: Component): { box: LayoutBoxView; line: number } | undefined {
	if (!root) return undefined;
	for (const child of root.children) {
		const match = findLabelPosition(child, component);
		if (match) return match;
	}
	if (root.component === component) return { box: root, line: 0 };
	const line = root.lines?.findIndex((value) => plainText(value).includes(SCROLL_TO_BOTTOM_LABEL)) ?? -1;
	return line >= 0 ? { box: root, line } : undefined;
}

function parsePrimaryMousePress(data: string): { x: number; y: number } | undefined {
	const match = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(data);
	if (!match) return undefined;
	const button = Number.parseInt(match[1] ?? "", 10);
	if ((button & 3) !== 0 || (button & 32) !== 0) return undefined;
	return { x: Number.parseInt(match[2] ?? "", 10) - 1, y: Number.parseInt(match[3] ?? "", 10) - 1 };
}

export function isScrollToBottomClick(data: string, range: LabelRange | undefined, root: LayoutBoxView | undefined, component: Component): boolean {
	const press = parsePrimaryMousePress(data);
	if (!press || !range) return false;
	const position = findLabelPosition(root, component);
	if (!position || press.y !== position.box.rect.y + position.line) return false;
	const localX = press.x - position.box.rect.x;
	return localX >= range.start && localX < range.end;
}

/** Place a click listener before fullscreen viewport selection consumes mouse events. */
function prependInputListener(tui: FullscreenTuiInternals, listener: TuiInputListener): (() => void) | undefined {
	const listeners = tui.inputListeners;
	if (!(listeners instanceof Set)) return undefined;
	const current = [...listeners];
	listeners.clear();
	listeners.add(listener);
	for (const existing of current) listeners.add(existing);
	return () => listeners.delete(listener);
}

export default function chatInput(pi: ExtensionAPI): void {
	const config = normalizeChatInputConfig(DEFAULT_CHAT_INPUT_CONFIG);
	let removeScrollClick: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		class PiBoxEditor extends CustomEditor {
			private labelRange: LabelRange | undefined;
			private readonly fullscreen: FullscreenTuiInternals | undefined;

			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: 0 });
				this.fullscreen = tui.mode === "fullscreen" && "scrollToBottom" in tui ? tui as FullscreenTuiInternals : undefined;
				removeScrollClick?.();
				removeScrollClick = this.fullscreen ? prependInputListener(this.fullscreen, (data) => {
					if (!this.fullscreen || !isScrollToBottomClick(data, this.labelRange, this.fullscreen.currentLayout?.root, this)) return undefined;
					this.fullscreen.scrollToBottom();
					this.fullscreen.requestRender();
					return { consume: true };
				}) : undefined;
			}

			render(width: number): string[] {
				if (!config.boxed || width < config.minBoxWidth) return super.render(width);

				const prefixWidth = visibleWidth(config.prefix);
				const contentWidth = width - 2 - config.paddingX * 2 - prefixWidth - 1;
				if (contentWidth < 4) return super.render(width);

				const stock = super.render(contentWidth);
				const showScrollToBottom = this.fullscreen?.isFollowingOutput === false;
				const firstRail = stock.find(isEditorRail);
				this.labelRange = showScrollToBottom ? centeredTopLabelRange(width, firstRail ? scrollLabel(firstRail) : undefined, SCROLL_TO_BOTTOM_LABEL) : undefined;
				const bashMode = this.getText().trimStart().startsWith("!");
				const thinking = pi.getThinkingLevel();
				const borderToken = bashMode
					? "bashMode"
					: config.adaptiveThinkingBorder
						? THINKING_COLORS[thinking]
						: config.borderColor;
				const prefixToken = bashMode ? "bashMode" : config.prefixColor;

				return (
					frameEditorLines(stock, {
						width,
						contentWidth,
						paddingX: config.paddingX,
						prefix: config.prefix,
						paintBorder: (value) => ctx.ui.theme.fg(borderToken, value),
						paintPrefix: (value) => ctx.ui.theme.fg(prefixToken, value),
						...(this.labelRange ? {
							topCenterLabel: SCROLL_TO_BOTTOM_LABEL,
							paintTopCenterLabel: (value: string) => ctx.ui.theme.bold(ctx.ui.theme.fg("accent", value)),
						} : {}),
					}) ?? super.render(width)
				);
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new PiBoxEditor(tui, editorTheme, keybindings));
	});

	pi.on("session_shutdown", () => {
		removeScrollClick?.();
		removeScrollClick = undefined;
	});
}
