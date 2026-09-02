import { createProvider, openAICompletionsApi, type ApiKeyCredential, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverOpenAIModels } from "../shared/openai-compatible.js";
import { OLLAMA_CLOUD_MODEL_METADATA, OLLAMA_CLOUD_THINKING_LEVEL_MAP } from "./model-metadata.js";
import { clearUsage, publishUsage } from "../shared/usage.js";

const PROVIDER_ID = "ollama-cloud";
const BASE_URL = "https://ollama.com/v1";

export function retryAfterTimestamp(headers: Record<string, string>, now = Date.now()): number | undefined {
	const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (!value) return undefined;
	if (/^\d+(?:\.\d+)?$/.test(value)) return now + Number(value) * 1000;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

export default function ollamaCloudProvider(pi: ExtensionAPI): void {
	const loginModels: Model<"openai-completions">[] = [];
	// Capacity is intentionally separate from quota: Ollama does not expose a
	// reliable account limit, so request-token usage is never rendered as quota.
	pi.on("after_provider_response", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || event.status !== 429) return;
		const retryAfterAt = retryAfterTimestamp(event.headers);
		publishUsage(ctx, { provider: PROVIDER_ID, windows: [], observedAt: Date.now(), capacity: retryAfterAt !== undefined ? { retryAfterAt } : {} });
	});
	pi.on("session_shutdown", (_event, ctx) => clearUsage(ctx, PROVIDER_ID));

	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Ollama Cloud",
			baseUrl: BASE_URL,
			auth: {
				apiKey: {
					name: "Ollama Cloud API key",
					async login(interaction): Promise<ApiKeyCredential> {
						interaction.notify({
							type: "info",
							message: "Create or manage Ollama API keys at ollama.com/settings/keys.",
							links: [{ url: "https://ollama.com/settings/keys", label: "Ollama API keys" }],
						});
						const key = (await interaction.prompt({
							type: "secret",
							message: "Ollama Cloud API key",
							placeholder: "Paste your Ollama API key",
						})).trim();
						if (!key) throw new Error("An Ollama Cloud API key is required");
						interaction.notify({ type: "progress", message: "Discovering Ollama Cloud models…" });
						const models = await discoverOpenAIModels({
							providerId: PROVIDER_ID,
							baseUrl: BASE_URL,
							apiKey: key,
							signal: interaction.signal,
							defaultContextWindow: 128_000,
							defaultMaxTokens: 32_768,
							defaultThinkingLevelMap: OLLAMA_CLOUD_THINKING_LEVEL_MAP,
							modelMetadata: OLLAMA_CLOUD_MODEL_METADATA,
						});
						loginModels.splice(0, loginModels.length, ...models);
						return { type: "api_key", key };
					},
					async check({ ctx, credential }) {
						const key = credential?.key ?? (await ctx.env("OLLAMA_API_KEY"));
						return key ? { type: "api_key", source: credential?.key ? "stored API key" : "OLLAMA_API_KEY" } : undefined;
					},
					async resolve({ ctx, credential }) {
						const key = credential?.key ?? (await ctx.env("OLLAMA_API_KEY"));
						return key
							? { auth: { apiKey: key }, source: credential?.key ? "stored API key" : "OLLAMA_API_KEY" }
							: undefined;
					},
				},
			},
			models: loginModels,
			async fetchModels(context) {
				const credential = context.credential?.type === "api_key" ? context.credential : undefined;
				const apiKey = credential?.key ?? process.env.OLLAMA_API_KEY;
				return discoverOpenAIModels({
					providerId: PROVIDER_ID,
					baseUrl: BASE_URL,
					...(apiKey ? { apiKey } : {}),
					signal: context.signal,
					defaultContextWindow: 128_000,
					defaultMaxTokens: 32_768,
					defaultThinkingLevelMap: OLLAMA_CLOUD_THINKING_LEVEL_MAP,
					modelMetadata: OLLAMA_CLOUD_MODEL_METADATA,
				});
			},
			api: openAICompletionsApi(),
		}),
	);
}
