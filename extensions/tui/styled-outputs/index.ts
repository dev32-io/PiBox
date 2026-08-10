import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { decorateHexColors } from "./color-preview.js";
import { DEFAULT_STYLED_OUTPUTS_CONFIG } from "./config.js";
import { prefixMarkdown } from "./components/prefixes.js";

export default function styledOutputs(pi: ExtensionAPI): void {
	const config = DEFAULT_STYLED_OUTPUTS_CONFIG;
	let theme: Theme | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") theme = ctx.ui.theme;
	});
	pi.on("session_shutdown", () => {
		theme = undefined;
	});

	pi.registerMarkdownTransformer((markdown, context) => {
		let transformed = prefixMarkdown(markdown, context, theme, config);
		if (
			!context.isStreaming &&
			config.colorPreviews.enabled &&
			config.colorPreviews.messageTypes.includes(context.messageType)
		) {
			transformed = decorateHexColors(transformed, config.colorPreviews);
		}
		return transformed;
	});
}
