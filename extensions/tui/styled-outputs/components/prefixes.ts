import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import type { StyledOutputsConfig } from "../config.js";

export function prefixMarkdown(
	markdown: string,
	context: MarkdownTransformContext,
	theme: Theme | undefined,
	config: StyledOutputsConfig,
): string {
	if (!config.prefixes || markdown.trim().length === 0) return markdown;
	const [symbol, token] =
		context.messageType === "user"
			? [config.userPrefix, "accent" as const]
			: context.messageType === "assistant-thinking"
				? [config.thinkingPrefix, "thinkingText" as const]
				: [config.assistantPrefix, "accent" as const];
	const prefix = theme ? theme.fg(token, symbol) : symbol;
	return `${prefix} ${markdown}`;
}
