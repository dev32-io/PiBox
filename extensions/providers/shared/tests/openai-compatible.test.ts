import assert from "node:assert/strict";
import test from "node:test";
import { discoverOpenAIModels, inferModelCapabilities, normalizeBaseUrl, toPiModels } from "../openai-compatible.js";

test("normalizes hostnames and endpoint URLs", () => {
	assert.equal(normalizeBaseUrl("localhost:11434/v1/"), "http://localhost:11434/v1");
	assert.equal(normalizeBaseUrl("https://example.test/v1/models"), "https://example.test/v1");
	assert.equal(normalizeBaseUrl("https://example.test/v1/chat/completions"), "https://example.test/v1");
	assert.throws(() => normalizeBaseUrl("file:///tmp/models"), /http or https/);
});

test("maps OpenAI and Ollama model lists with conservative inferred capabilities", () => {
	const models = toPiModels({
		models: [
			{ name: "qwen3-vl:32b", context_length: 262_144, capabilities: ["vision", "thinking"] },
			{ model: "plain-model" },
		],
	}, {
		providerId: "test-provider",
		baseUrl: "https://example.test/v1",
	});
	assert.equal(models.length, 2);
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.input, ["text", "image"]);
	assert.equal(models[0]?.contextWindow, 262_144);
	assert.equal(models[1]?.reasoning, false);
	assert.deepEqual(models[1]?.input, ["text"]);
	assert.deepEqual(inferModelCapabilities("deepseek-r1:70b"), { reasoning: true, images: false });
});

test("applies an opt-in provider thinking map only to reasoning models without a specific map", () => {
	const models = toPiModels({ data: [{ id: "reasoning" }, { id: "specific" }, { id: "plain" }] }, {
		providerId: "test-provider",
		baseUrl: "https://example.test/v1",
		defaultThinkingLevelMap: { minimal: null, low: "low", max: "max" },
		modelMetadata: {
			reasoning: { reasoning: true },
			specific: { reasoning: true, thinkingLevelMap: { high: "fixed" } },
			plain: { reasoning: false },
		},
	});
	assert.deepEqual(models[0]?.thinkingLevelMap, { minimal: null, low: "low", max: "max" });
	assert.deepEqual(models[1]?.thinkingLevelMap, { high: "fixed" });
	assert.equal(models[2]?.thinkingLevelMap, undefined);
});

test("uses curated metadata as a fallback while preferring endpoint token limits", () => {
	const models = toPiModels({
		data: [
			{ id: "curated-model" },
			{ id: "remote-model", context_window: 64_000, max_output_tokens: 8_000 },
		],
	}, {
		providerId: "test-provider",
		baseUrl: "https://example.test/v1",
		defaultContextWindow: 128_000,
		defaultMaxTokens: 16_384,
		modelMetadata: {
			"curated-model": { contextWindow: 262_144, maxTokens: 32_768, reasoning: true, thinkingLevelMap: { max: "max" }, images: true },
			"remote-model": { contextWindow: 1_000_000, maxTokens: 32_768 },
		},
	});
	assert.equal(models[0]?.contextWindow, 262_144);
	assert.equal(models[0]?.maxTokens, 32_768);
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.thinkingLevelMap, { max: "max" });
	assert.deepEqual(models[0]?.input, ["text", "image"]);
	assert.equal(models[1]?.contextWindow, 64_000);
	assert.equal(models[1]?.maxTokens, 8_000);
});

test("discovers /v1/models when the supplied URL is only a host", async () => {
	const originalFetch = globalThis.fetch;
	const requested: string[] = [];
	globalThis.fetch = (async (input: string | URL | Request) => {
		requested.push(String(input));
		if (String(input).endsWith("/models") && !String(input).endsWith("/v1/models")) return new Response("missing", { status: 404 });
		return Response.json({ data: [{ id: "test-model" }] });
	}) as typeof fetch;
	try {
		const models = await discoverOpenAIModels({
			providerId: "test-provider",
			baseUrl: "http://localhost:1234",
			apiKey: "secret",
			signal: new AbortController().signal,
		});
		assert.deepEqual(requested, ["http://localhost:1234/models", "http://localhost:1234/v1/models"]);
		assert.equal(models[0]?.baseUrl, "http://localhost:1234/v1");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
