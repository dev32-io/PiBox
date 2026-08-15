import assert from "node:assert/strict";
import test from "node:test";
import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import localLlmProvider from "../../local-llm/index.js";
import ollamaCloudProvider from "../../ollama-cloud/index.js";

function captureProvider(register: (pi: ExtensionAPI) => void): Provider {
	let captured: Provider | undefined;
	register({ registerProvider: (provider: Provider) => { captured = provider; }, on: () => {} } as unknown as ExtensionAPI);
	assert.ok(captured);
	return captured;
}

function captureLocalLlmMessageEnd(): (event: any, ctx: any) => any {
	let handler: ((event: any, ctx: any) => any) | undefined;
	localLlmProvider({
		registerProvider: () => {},
		on: (event: string, candidate: (event: any, ctx: any) => any) => {
			if (event === "message_end") handler = candidate;
		},
	} as unknown as ExtensionAPI);
	assert.ok(handler);
	return handler;
}

test("Ollama Cloud registers an API-key login", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ data: [{ id: "cloud-model" }] })) as typeof fetch;
	const provider = captureProvider(ollamaCloudProvider);
	assert.equal(provider.id, "ollama-cloud");
	assert.equal(provider.name, "Ollama Cloud");
	const login = provider.auth.apiKey?.login;
	assert.ok(login);
	const credential = await login({
		signal: new AbortController().signal,
		notify: () => {},
		prompt: async () => "ollama-secret",
	});
	assert.deepEqual(credential, { type: "api_key", key: "ollama-secret" });
	assert.equal(provider.getModels()[0]?.id, "cloud-model");
	globalThis.fetch = originalFetch;
});

test("Local LLM login stores both endpoint URL and API key", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => Response.json({ data: [{ id: "local-model" }] })) as typeof fetch;
	const provider = captureProvider(localLlmProvider);
	assert.equal(provider.id, "local-llm");
	const login = provider.auth.apiKey?.login;
	assert.ok(login);
	const answers = ["localhost:1234/v1/", "local-secret"];
	const credential = await login({
		signal: new AbortController().signal,
		notify: () => {},
		prompt: async () => answers.shift() ?? "",
	});
	assert.deepEqual(credential, {
		type: "api_key",
		key: "local-secret",
		env: { LOCAL_LLM_BASE_URL: "http://localhost:1234/v1" },
	});
	assert.equal(provider.getModels()[0]?.id, "local-model");
	globalThis.fetch = originalFetch;
});

test("Local LLM normalizes LM Studio context overflow errors for Pi compaction", () => {
	const handler = captureLocalLlmMessageEnd();
	const message = {
		role: "assistant",
		provider: "local-llm",
		stopReason: "error",
		errorMessage: 'Engine protocol returned {"message":"Context size has been exceeded."}',
	};
	const result = handler({ message }, { model: { provider: "local-llm" } });
	assert.equal(
		result?.message.errorMessage,
		`context_length_exceeded: ${message.errorMessage}`,
	);
});

test("Local LLM overflow normalization stays provider- and error-scoped", () => {
	const handler = captureLocalLlmMessageEnd();
	const overflow = {
		role: "assistant",
		provider: "another-provider",
		stopReason: "error",
		errorMessage: "Context size has been exceeded.",
	};
	assert.equal(handler({ message: overflow }, { model: { provider: "another-provider" } }), undefined);
	assert.equal(handler({ message: { ...overflow, provider: "local-llm", errorMessage: "Internal server error" } }, { model: { provider: "local-llm" } }), undefined);
});
