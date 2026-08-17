import assert from "node:assert/strict";
import test from "node:test";
import { toPiModels } from "../../shared/openai-compatible.js";
import { retryAfterTimestamp } from "../index.js";
import { OLLAMA_CLOUD_MODEL_METADATA } from "../model-metadata.js";

const options = {
	providerId: "ollama-cloud",
	baseUrl: "https://ollama.com/v1",
	defaultContextWindow: 128_000,
	defaultMaxTokens: 32_768,
	modelMetadata: OLLAMA_CLOUD_MODEL_METADATA,
};

test("maps Ollama Cloud IDs to library context and modality metadata", () => {
	const models = toPiModels({
		data: [
			{ id: "glm-5.2" },
			{ id: "kimi-k2.7-code" },
			{ id: "deepseek-v4-flash:preview" },
			{ id: "unknown-future-model" },
		],
	}, options);

	assert.equal(models[0]?.contextWindow, 1_000_000);
	assert.equal(models[0]?.reasoning, true);
	assert.deepEqual(models[0]?.input, ["text"]);
	assert.equal(models[1]?.contextWindow, 262_144);
	assert.equal(models[1]?.reasoning, true);
	assert.deepEqual(models[1]?.input, ["text", "image"]);
	assert.equal(models[2]?.contextWindow, 1_048_576);
	assert.equal(models[3]?.contextWindow, 128_000);
});

test("normalizes Ollama Cloud Retry-After capacity hints without inventing quota", () => {
	assert.equal(retryAfterTimestamp({ "Retry-After": "30" }, 1_000), 31_000);
	assert.equal(retryAfterTimestamp({}, 1_000), undefined);
});

test("contains metadata for every currently advertised Ollama Cloud model", () => {
	const ids = [
		"kimi-k2.7-code",
		"kimi-k2.6",
		"minimax-m3",
		"glm-5.2",
		"deepseek-v4-flash:preview",
		"nemotron-3-nano:30b",
		"qwen3.5:397b",
		"glm-5.1",
		"mistral-large-3:675b",
		"gpt-oss:20b",
		"nemotron-3-ultra",
		"deepseek-v4-flash:0731",
		"nemotron-3-super",
		"kimi-k3",
		"gpt-oss:120b",
		"minimax-m2.7",
		"gemma4:31b",
		"deepseek-v4-pro",
	];
	for (const id of ids) assert.ok(OLLAMA_CLOUD_MODEL_METADATA[id], `missing metadata for ${id}`);
});
