import { createProvider, openAICompletionsApi, type ApiKeyCredential, type Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverOpenAIModels } from "../shared/openai-compatible.js";
import { OLLAMA_CLOUD_MODEL_METADATA } from "./model-metadata.js";

const PROVIDER_ID = "ollama-cloud";
const BASE_URL = "https://ollama.com/v1";

export default function ollamaCloudProvider(pi: ExtensionAPI): void {
	const loginModels: Model<"openai-completions">[] = [];
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
					modelMetadata: OLLAMA_CLOUD_MODEL_METADATA,
				});
			},
			api: openAICompletionsApi(),
		}),
	);
}
