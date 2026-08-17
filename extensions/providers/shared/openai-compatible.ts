import type { Model, OpenAICompletionsCompat, ThinkingLevelMap } from "@earendil-works/pi-ai";

export interface DiscoveredModelMetadata {
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	images?: boolean;
}

export interface DiscoveryOptions {
	providerId: string;
	baseUrl: string;
	apiKey?: string;
	signal: AbortSignal;
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	modelMetadata?: Readonly<Record<string, DiscoveredModelMetadata>>;
}

interface RemoteModel {
	id?: unknown;
	name?: unknown;
	model?: unknown;
	context_window?: unknown;
	context_length?: unknown;
	max_model_len?: unknown;
	max_tokens?: unknown;
	max_output_tokens?: unknown;
	capabilities?: unknown;
}

export function normalizeBaseUrl(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) throw new Error("A provider URL is required");
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
		throw new Error("Provider URL must use http or https");
	}
	const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
	const url = new URL(withProtocol);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Provider URL must use http or https");
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname
		.replace(/\/(?:chat\/completions|models)$/i, "")
		.replace(/\/$/, "");
	return url.toString().replace(/\/$/, "");
}

function discoveryCandidates(baseUrl: string): Array<{ modelsUrl: string; apiBaseUrl: string }> {
	const normalized = normalizeBaseUrl(baseUrl);
	const url = new URL(normalized);
	const candidates = [{ modelsUrl: `${normalized}/models`, apiBaseUrl: normalized }];
	if (url.pathname === "" || url.pathname === "/") {
		candidates.push({ modelsUrl: `${normalized}/v1/models`, apiBaseUrl: `${normalized}/v1` });
	}
	return candidates;
}

function positiveInteger(...values: unknown[]): number | undefined {
	for (const value of values) {
		const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
	return undefined;
}

export function inferModelCapabilities(id: string, capabilities?: unknown): { reasoning: boolean; images: boolean } {
	const normalized = id.toLowerCase();
	const listed = Array.isArray(capabilities) ? capabilities.map(String).map((item) => item.toLowerCase()) : [];
	return {
		reasoning: listed.includes("thinking") || /(^|[-/:])(gpt-oss|deepseek-r1|qwq|reasoning|qwen3)([-/:]|$)/.test(normalized),
		images: listed.some((item) => /vision|image/.test(item)) || /(^|[-/:])(llava|vision|vl|qwen\d*(?:\.\d+)?-vl|minicpm-v)([-/:]|$)/.test(normalized),
	};
}

function parseModels(payload: unknown): RemoteModel[] {
	if (Array.isArray(payload)) return payload as RemoteModel[];
	if (!payload || typeof payload !== "object") return [];
	const record = payload as { data?: unknown; models?: unknown };
	if (Array.isArray(record.data)) return record.data as RemoteModel[];
	if (Array.isArray(record.models)) return record.models as RemoteModel[];
	return [];
}

function compatibility(reasoning: boolean): OpenAICompletionsCompat {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		supportsOpenAIGrammarTools: false,
	};
}

export function toPiModels(
	payload: unknown,
	options: Omit<DiscoveryOptions, "signal" | "apiKey">,
): Model<"openai-completions">[] {
	const seen = new Set<string>();
	const models: Model<"openai-completions">[] = [];
	for (const remote of parseModels(payload)) {
		const idValue = remote.id ?? remote.model ?? remote.name;
		if (typeof idValue !== "string" || !idValue.trim() || seen.has(idValue)) continue;
		const id = idValue.trim();
		seen.add(id);
		const inferred = inferModelCapabilities(id, remote.capabilities);
		const metadata = options.modelMetadata?.[id];
		const listedCapabilities = Array.isArray(remote.capabilities)
			? remote.capabilities.map(String).map((item) => item.toLowerCase())
			: [];
		const reasoning = listedCapabilities.includes("thinking") || listedCapabilities.includes("reasoning")
			? true
			: metadata?.reasoning ?? inferred.reasoning;
		const images = listedCapabilities.some((item) => /vision|image/.test(item))
			? true
			: metadata?.images ?? inferred.images;
		const contextWindow = positiveInteger(remote.context_window, remote.context_length, remote.max_model_len)
			?? metadata?.contextWindow
			?? options.defaultContextWindow
			?? 128_000;
		const maxTokens = Math.min(
			positiveInteger(remote.max_output_tokens, remote.max_tokens)
				?? metadata?.maxTokens
				?? options.defaultMaxTokens
				?? 16_384,
			contextWindow,
		);
		models.push({
			id,
			name: typeof remote.name === "string" && remote.name.trim() ? remote.name.trim() : id,
			api: "openai-completions",
			provider: options.providerId,
			baseUrl: options.baseUrl,
			reasoning,
			...(metadata?.thinkingLevelMap ? { thinkingLevelMap: { ...metadata.thinkingLevelMap } } : {}),
			input: images ? ["text", "image"] : ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow,
			maxTokens,
			compat: compatibility(reasoning),
		});
	}
	return models;
}

export async function discoverOpenAIModels(options: DiscoveryOptions): Promise<Model<"openai-completions">[]> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
	let lastError: Error | undefined;

	for (const candidate of discoveryCandidates(options.baseUrl)) {
		try {
			const timeout = AbortSignal.timeout(10_000);
			const signal = AbortSignal.any([options.signal, timeout]);
			const response = await fetch(candidate.modelsUrl, { headers, signal });
			if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
			const payload: unknown = await response.json();
			const models = toPiModels(payload, {
				providerId: options.providerId,
				baseUrl: candidate.apiBaseUrl,
				...(options.defaultContextWindow ? { defaultContextWindow: options.defaultContextWindow } : {}),
				...(options.defaultMaxTokens ? { defaultMaxTokens: options.defaultMaxTokens } : {}),
				...(options.modelMetadata ? { modelMetadata: options.modelMetadata } : {}),
			});
			if (models.length === 0) throw new Error("the endpoint returned no model IDs");
			return models;
		} catch (error) {
			if (options.signal.aborted) throw error;
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}
	throw new Error(`Model discovery failed for ${options.baseUrl}: ${lastError?.message ?? "unknown error"}`);
}
