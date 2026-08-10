import {
	CustomEditor,
	type ExtensionAPI,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CHAT_INPUT_CONFIG, normalizeChatInputConfig } from "./config.js";
import { frameEditorLines } from "./layout.js";

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
			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings, { paddingX: 0 });
			}

			render(width: number): string[] {
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

				return (
					frameEditorLines(stock, {
						width,
						contentWidth,
						paddingX: config.paddingX,
						prefix: config.prefix,
						paintBorder: (value) => ctx.ui.theme.fg(borderToken, value),
						paintPrefix: (value) => ctx.ui.theme.fg(prefixToken, value),
					}) ?? super.render(width)
				);
			}
		}

		ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => new PiBoxEditor(tui, editorTheme, keybindings));
	});
}
