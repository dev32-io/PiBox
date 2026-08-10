export interface ChatInputConfig {
	boxed: boolean;
	paddingX: number;
	prefix: string;
	borderColor: "border" | "borderAccent" | "borderMuted";
	prefixColor: "accent" | "text" | "muted";
	adaptiveThinkingBorder: boolean;
	narrowMode: "rails" | "native";
	minBoxWidth: number;
}

export const DEFAULT_CHAT_INPUT_CONFIG: Readonly<ChatInputConfig> = {
	boxed: true,
	paddingX: 1,
	prefix: "❯",
	borderColor: "borderMuted",
	prefixColor: "accent",
	adaptiveThinkingBorder: true,
	narrowMode: "rails",
	minBoxWidth: 20,
};

export function normalizeChatInputConfig(input: Partial<ChatInputConfig> = {}): ChatInputConfig {
	return {
		...DEFAULT_CHAT_INPUT_CONFIG,
		...input,
		paddingX: Math.max(0, Math.min(4, Math.floor(input.paddingX ?? DEFAULT_CHAT_INPUT_CONFIG.paddingX))),
		minBoxWidth: Math.max(12, Math.floor(input.minBoxWidth ?? DEFAULT_CHAT_INPUT_CONFIG.minBoxWidth)),
		prefix: input.prefix?.trim() || DEFAULT_CHAT_INPUT_CONFIG.prefix,
	};
}
