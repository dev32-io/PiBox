import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, Type, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toPiModels } from "../../shared/openai-compatible.js";
import localLlmProvider, { LOCAL_LLM_THINKING_LEVEL_MAP, normalizeLocalLlmModels } from "../index.js";

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
	assert.equal(model.thinkingLevelMap?.off, "none");
	assert.equal(model.thinkingLevelMap?.minimal, null);
	assert.equal(model.thinkingLevelMap?.max, null);
});

test("local-llm streams preserve normalized transcript prompt and tools", async () => {
	let provider: Provider | undefined;
	localLlmProvider({ registerProvider(value: Provider) { provider = value; }, on() {} } as unknown as ExtensionAPI);
	assert.ok(provider);
	const model = discovered[0]!;
	const context = normalizeContext({
		systemPrompt: "BASE",
		messages: [{ role: "user", content: "task", timestamp: 0 }],
		tools: [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }],
	});
	for (const method of ["stream", "streamSimple"] as const) {
		let requests = 0;
		const result = await provider[method](model, context, {
			apiKey: "offline-key", maxRetries: 0,
			async fetch(_url, init) {
				requests++;
				const payload = JSON.parse(String(init?.body));
				assert.deepEqual(payload.messages, [{ role: "system", content: "BASE" }, { role: "user", content: "task" }]);
				assert.equal(payload.tools[0].function.name, "echo");
				assert.equal(payload.tools[0].function.parameters.type, "object");
				assert.deepEqual(payload.tools[0].function.parameters.required, ["text"]);
				return new Response("offline capture", { status: 400 });
			},
		}).result();
		assert.equal(requests, 1, method);
		assert.match(result.errorMessage ?? "", /offline capture/, method);
	}
});
