export interface ColorPreviewConfig {
	enabled: boolean;
	messageTypes: Array<"user" | "assistant" | "assistant-thinking">;
	includeInlineCode: boolean;
	includeFencedCode: boolean;
	formats: Array<"rgb3" | "rgb6">;
}

export interface StyledOutputsConfig {
	prefixes: boolean;
	assistantPrefix: string;
	userPrefix: string;
	thinkingPrefix: string;
	colorPreviews: ColorPreviewConfig;
}

export const DEFAULT_STYLED_OUTPUTS_CONFIG: Readonly<StyledOutputsConfig> = {
	prefixes: true,
	assistantPrefix: "●",
	userPrefix: "❯",
	thinkingPrefix: "✽",
	colorPreviews: {
		enabled: true,
		messageTypes: ["user", "assistant"],
		includeInlineCode: true,
		includeFencedCode: false,
		formats: ["rgb3", "rgb6"],
	},
};
