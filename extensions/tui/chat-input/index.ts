import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CHAT_INPUT_CONFIG, normalizeChatInputConfig } from "./config.js";
import { frameEditorLines, isEditorRail } from "./layout.js";

const THINKING_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
} as const;

export default function chatInput(pi: ExtensionAPI): void {
	const config = normalizeChatInputConfig(DEFAULT_CHAT_INPUT_CONFIG);

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		class PiBoxEditor extends CustomEditor {
			/** Set only while the last render used the boxed frame; stock Editor mouse math assumes unframed rows. */
			private boxed: { gutter: number; contentWidth: number; bodyRows: number } | undefined;

			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: 0 });
			}

			handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const boxed = this.boxed;
				if (!boxed) return super.handleMouse(event);
				// Body rows sit behind padding + prefix + space; menu rows behind one space. Gutter clicks clamp to column 0.
				const gutter = event.y >= 1 && event.y <= boxed.bodyRows ? boxed.gutter : 1;
				return super.handleMouse({ ...event, x: Math.max(0, event.x - gutter), width: boxed.contentWidth });
			}

			render(width: number): string[] {
				this.boxed = undefined;
				if (!config.boxed || width < config.minBoxWidth) return super.render(width);

				const prefixWidth = visibleWidth(config.prefix);
				const contentWidth = width - 2 - config.paddingX * 2 - prefixWidth - 1;
				if (contentWidth < 4) return super.render(width);

				const stock = super.render(contentWidth);
				const bashMode = this.getText().trimStart().startsWith("!");
				const thinking = pi.getThinkingLevel();
				const borderToken = bashMode
					? "bashMode"
					: config.adaptiveThinkingBorder
						? THINKING_COLORS[thinking]
						: config.borderColor;
				const prefixToken = bashMode ? "bashMode" : config.prefixColor;

				const framed = frameEditorLines(stock, {
					width,
					contentWidth,
					paddingX: config.paddingX,
					prefix: config.prefix,
					paintBorder: (value) => ctx.ui.theme.fg(borderToken, value),
					paintPrefix: (value) => ctx.ui.theme.fg(prefixToken, value),
				});
				if (!framed) return super.render(width);
				const menuRows = stock.length - 1 - stock.map(isEditorRail).lastIndexOf(true);
				this.boxed = {
					gutter: config.paddingX + prefixWidth + 1,
					contentWidth,
					bodyRows: framed.length - 2 - menuRows,
				};
				return framed;
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new PiBoxEditor(tui, editorTheme, keybindings));
	});
}
