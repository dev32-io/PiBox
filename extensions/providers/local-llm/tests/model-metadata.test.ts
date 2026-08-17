import assert from "node:assert/strict";
import test from "node:test";
import { toPiModels } from "../../shared/openai-compatible.js";
import { LOCAL_LLM_THINKING_LEVEL_MAP, normalizeLocalLlmModels } from "../index.js";

const discovered = toPiModels({ data: [{ id: "local-model" }] }, {
	providerId: "local-llm",
	baseUrl: "http://localhost:1234/v1",
	defaultContextWindow: 128_000,
	defaultMaxTokens: 16_384,
});

test("local-llm discovery normalizes every model to its supported effort levels", () => {
	const model = normalizeLocalLlmModels(discovered)[0]!;
	assert.equal(model.reasoning, true);
	assert.equal(model.compat?.supportsReasoningEffort, true);
	assert.deepEqual(model.thinkingLevelMap, LOCAL_LLM_THINKING_LEVEL_MAP);
	assert.deepEqual(Object.keys(model.thinkingLevelMap ?? {}).sort(), ["high", "low", "medium", "minimal", "off", "xhigh", "max"].sort());
	assert.equal(model.thinkingLevelMap?.minimal, null);
	assert.equal(model.thinkingLevelMap?.max, null);
});
