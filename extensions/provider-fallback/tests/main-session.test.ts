import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import providerFallback, { defaultProviderCooldowns } from "../index.js";

const model: Model<"anthropic-messages"> = { id: "claude-sonnet-4-5", name: "offline", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://offline.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
function harness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	providerFallback({ on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); } } as ExtensionAPI);
	const fire = (name: string, event: unknown = {}, ctx: unknown = { model }) => handlers.get(name)?.(event, ctx);
	fire("session_start");
	return fire;
}
const error = (errorMessage = "429 rate limit exceeded", provider = "anthropic") => ({ type: "message_end", message: { role: "assistant", provider, stopReason: "error", errorMessage } });

test("bare Anthropic exhausted 429 has no response callback but terminal lifecycle marks cooldown", async () => {
	const fire = harness();
	let responses = 0;
	let requests = 0;
	fire("before_provider_request");
	const message = await streamSimple(model, normalizeContext({ messages: [{ role: "user", content: "offline", timestamp: 0 }] }), {
		apiKey: "sk-ant-api03-OFFLINE-FAKE", maxRetries: 0, cacheRetention: "none",
		onResponse(response) { responses++; fire("after_provider_response", response); },
		async fetch() { requests++; return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "rate limit exceeded" } }), { status: 429, headers: { "content-type": "application/json" } }); },
	}).result();
	assert.equal(requests, 1);
	assert.equal(responses, 0);
	assert.equal(message.stopReason, "error");
	fire("message_end", { type: "message_end", message });
	assert.equal(defaultProviderCooldowns.available("anthropic"), true, "automatic retries have not settled");
	fire("agent_settled");
	assert.equal(defaultProviderCooldowns.available("anthropic"), false);
});

test("settlement ignores ordinary content, non-rate provider failures, aborted output, and successful retries", () => {
	const fire = harness();
	for (const message of [
		{ role: "user", content: "429 rate limit" },
		{ role: "toolResult", errorMessage: "429 rate limit", isError: true },
		{ role: "assistant", provider: "anthropic", stopReason: "stop", content: [{ type: "text", text: "429 rate limit" }] },
		{ role: "assistant", provider: "anthropic", stopReason: "aborted", errorMessage: "429" },
	]) {
		fire("message_end", { type: "message_end", message }); fire("agent_settled");
		assert.equal(defaultProviderCooldowns.available("anthropic"), true);
	}
	for (const text of ["401 unauthorized", "503 overloaded", "context_length_exceeded", "tests failed"]) {
		fire("message_end", error(text)); fire("agent_settled");
		assert.equal(defaultProviderCooldowns.available("anthropic"), true);
	}
	fire("after_provider_response", { status: 429, headers: { "Retry-After": "60" } });
	fire("message_end", error());
	fire("before_provider_request");
	fire("message_end", { type: "message_end", message: { role: "assistant", provider: "anthropic", stopReason: "stop" } });
	fire("agent_settled");
	assert.equal(defaultProviderCooldowns.available("anthropic"), true);
});

test("HTTP and terminal observations count once, retain Retry-After, and use message provider", (t) => {
	t.mock.method(Date, "now", () => 1000);
	const fire = harness();
	fire("after_provider_response", { status: 429, headers: { "Retry-After": "60" } });
	fire("message_end", error(), { model: { provider: "changed-model" } });
	fire("agent_settled");
	assert.equal(defaultProviderCooldowns.available("anthropic", 60999), false);
	assert.equal(defaultProviderCooldowns.available("anthropic", 61000), true);
	t.mock.method(Date, "now", () => 5000);
	fire("agent_settled");
	assert.equal(defaultProviderCooldowns.available("anthropic", 61000), true, "duplicate settlement does not extend cooldown");
	assert.equal(defaultProviderCooldowns.available("changed-model"), true);
});
