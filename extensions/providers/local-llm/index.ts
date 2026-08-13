import {
	createProvider,
	openAICompletionsApi,
	type Api,
	type ApiKeyCredential,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverOpenAIModels, normalizeBaseUrl } from "../shared/openai-compatible.js";
import { normalizeStrictToolSchemas } from "../shared/strict-tool-schema.js";

const PROVIDER_ID = "local-llm";
const URL_FIELD = "LOCAL_LLM_BASE_URL";

function strictToolSchemaCompatibleApi() {
	const api = openAICompletionsApi();
	const withNormalizedPayload = async (
		payload: unknown,
		model: Model<Api>,
		onPayload: StreamOptions["onPayload"],
	): Promise<unknown> => normalizeStrictToolSchemas((await onPayload?.(payload, model)) ?? payload);

	return {
		stream(model: Model<"openai-completions">, context: Context, options?: StreamOptions) {
			return api.stream(model, context, {
				...options,
				onPayload: (payload, payloadModel) => withNormalizedPayload(payload, payloadModel, options?.onPayload),
			});
		},
		streamSimple(model: Model<"openai-completions">, context: Context, options?: SimpleStreamOptions) {
			return api.streamSimple(model, context, {
				...options,
				onPayload: (payload, payloadModel) => withNormalizedPayload(payload, payloadModel, options?.onPayload),
			});
		},
	};
}

export default function localLlmProvider(pi: ExtensionAPI): void {
	const loginModels: Model<"openai-completions">[] = [];
	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Local LLM",
			baseUrl: "http://localhost:11434/v1",
			auth: {
				apiKey: {
					name: "Custom endpoint API key",
					async login(interaction): Promise<ApiKeyCredential> {
						const baseUrl = normalizeBaseUrl(
							await interaction.prompt({
								type: "text",
								message: "OpenAI-compatible base URL",
								placeholder: "http://localhost:1234/v1",
							}),
						);
						const key = (await interaction.prompt({
							type: "secret",
							message: "API key",
							placeholder: "Paste the endpoint API key",
						})).trim();
						if (!key) throw new Error("An API key is required");
						interaction.notify({ type: "progress", message: "Discovering endpoint models…" });
						const models = await discoverOpenAIModels({
							providerId: PROVIDER_ID,
							baseUrl,
							apiKey: key,
							signal: interaction.signal,
							defaultContextWindow: 128_000,
							defaultMaxTokens: 16_384,
						});
						loginModels.splice(0, loginModels.length, ...models);
						return { type: "api_key", key, env: { [URL_FIELD]: baseUrl } };
					},
					async check({ ctx, credential }) {
						const key = credential?.key ?? (await ctx.env("LOCAL_LLM_API_KEY"));
						const baseUrl = credential?.env?.[URL_FIELD] ?? (await ctx.env(URL_FIELD));
						return key && baseUrl
							? { type: "api_key", source: credential?.key ? "stored endpoint credentials" : "LOCAL_LLM_API_KEY" }
							: undefined;
					},
					async resolve({ ctx, credential }) {
						const key = credential?.key ?? (await ctx.env("LOCAL_LLM_API_KEY"));
						const baseUrl = credential?.env?.[URL_FIELD] ?? (await ctx.env(URL_FIELD));
						if (!key || !baseUrl) return undefined;
						return {
							auth: { apiKey: key },
							env: { [URL_FIELD]: normalizeBaseUrl(baseUrl) },
							source: credential?.key ? "stored endpoint credentials" : "LOCAL_LLM_API_KEY",
						};
					},
				},
			},
			models: loginModels,
			async fetchModels(context) {
				const credential = context.credential?.type === "api_key" ? context.credential : undefined;
				const baseUrl = credential?.env?.[URL_FIELD] ?? process.env[URL_FIELD];
				if (!baseUrl) return [];
				const apiKey = credential?.key ?? process.env.LOCAL_LLM_API_KEY;
				return discoverOpenAIModels({
					providerId: PROVIDER_ID,
					baseUrl,
					...(apiKey ? { apiKey } : {}),
					signal: context.signal,
					defaultContextWindow: 128_000,
					defaultMaxTokens: 16_384,
				});
			},
			api: strictToolSchemaCompatibleApi(),
		}),
	);
}
