import type { DiscoveredModelMetadata } from "../shared/openai-compatible.js";

/**
 * Ollama's OpenAI-compatible /models response currently contains model IDs but
 * not the capability metadata shown in the Ollama library. Keep these defaults
 * aligned with the cloud tags on https://ollama.com/library.
 *
 * Context values normalize Ollama's rounded labels such as 128K, 256K, 512K,
 * 976K, or 1M to token counts suitable for Pi's model metadata.
 */
const MAX_EFFORT = { max: "max" } satisfies NonNullable<DiscoveredModelMetadata["thinkingLevelMap"]>;

export const OLLAMA_CLOUD_MODEL_METADATA: Readonly<Record<string, DiscoveredModelMetadata>> = {
	"kimi-k2.7-code": { contextWindow: 262_144, reasoning: true, images: true },
	"kimi-k2.6": { contextWindow: 262_144, reasoning: true, images: true },
	"minimax-m3": { contextWindow: 524_288, reasoning: true, images: true },
	"glm-5.2": { contextWindow: 1_000_000, reasoning: true, thinkingLevelMap: MAX_EFFORT, images: false },
	"deepseek-v4-flash:preview": { contextWindow: 1_048_576, reasoning: true, thinkingLevelMap: MAX_EFFORT, images: false },
	"deepseek-v4-flash:0731": { contextWindow: 1_048_576, reasoning: true, thinkingLevelMap: MAX_EFFORT, images: false },
	"nemotron-3-nano:30b": { contextWindow: 1_048_576, reasoning: true, images: false },
	"qwen3.5:397b": { contextWindow: 262_144, reasoning: true, images: true },
	"glm-5.1": { contextWindow: 202_752, reasoning: true, thinkingLevelMap: MAX_EFFORT, images: false },
	"mistral-large-3:675b": { contextWindow: 262_144, reasoning: false, images: true },
	"gpt-oss:20b": { contextWindow: 131_072, reasoning: true, images: false },
	"gpt-oss:120b": { contextWindow: 131_072, reasoning: true, images: false },
	"nemotron-3-ultra": { contextWindow: 262_144, reasoning: true, images: false },
	"nemotron-3-super": { contextWindow: 262_144, reasoning: true, images: false },
	"kimi-k3": { contextWindow: 1_048_576, reasoning: true, images: true },
	"minimax-m2.7": { contextWindow: 204_800, reasoning: true, images: false },
	"gemma4:31b": { contextWindow: 262_144, reasoning: true, images: true },
	"deepseek-v4-pro": { contextWindow: 1_048_576, reasoning: true, thinkingLevelMap: MAX_EFFORT, images: false },
};
