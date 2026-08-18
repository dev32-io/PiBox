import {
	createProvider,
	openAICompletionsApi,
	type Api,
	type ApiKeyCredential,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevelMap,
	type StreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverOpenAIModels, normalizeBaseUrl } from "../shared/openai-compatible.js";
import { normalizeStrictToolSchemas } from "../shared/strict-tool-schema.js";

const PROVIDER_ID = "local-llm";
const URL_FIELD = "LOCAL_LLM_BASE_URL";
const CONTEXT_OVERFLOW_PATTERN = /context size has been exceeded/i;

/** Local OpenAI-compatible servers accept Pi's complete effort vocabulary except minimal/max. */
export const LOCAL_LLM_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	// OpenAI-compatible reasoning APIs spell Pi's canonical `off` as `none`.
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: null,
};

export function normalizeLocalLlmModels(models: Model<"openai-completions">[]): Model<"openai-completions">[] {
	return models.map((model) => ({
		...model,
		reasoning: true,
		thinkingLevelMap: { ...LOCAL_LLM_THINKING_LEVEL_MAP },
		compat: { ...model.compat, supportsReasoningEffort: true },
	}));
}

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
						loginModels.splice(0, loginModels.length, ...normalizeLocalLlmModels(models));
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
				const models = await discoverOpenAIModels({
					providerId: PROVIDER_ID,
					baseUrl,
					...(apiKey ? { apiKey } : {}),
					signal: context.signal,
					defaultContextWindow: 128_000,
					defaultMaxTokens: 16_384,
				});
				return normalizeLocalLlmModels(models);
			},
			api: strictToolSchemaCompatibleApi(),
		}),
	);

	// LM Studio reports this overflow as a generic HTTP 500 whose wording is not
	// recognized by Pi. Normalize only local-llm failures so Pi compacts and
	// performs its single bounded overflow retry instead of treating it as a
	// transient server failure.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || message.stopReason !== "error") return;
		if (message.provider !== PROVIDER_ID && ctx.model?.provider !== PROVIDER_ID) return;
		const errorMessage = message.errorMessage ?? "";
		if (/context[_ ]length[_ ]exceeded/i.test(errorMessage)) return;
		if (!CONTEXT_OVERFLOW_PATTERN.test(errorMessage)) return;
		return {
			message: {
				...message,
				errorMessage: `context_length_exceeded: ${errorMessage}`,
			},
		};
	});
}
