import assert from "node:assert/strict";
import test from "node:test";
import { classifyProviderFailure, ProviderCooldowns } from "../index.js";

test("classifies provider capacity without treating context or implementation failures as fallback", () => {
	assert.equal(classifyProviderFailure({ exitCode: 1, stderr: "HTTP 429 usage limit reached" }).kind, "rate_limit");
	assert.equal(classifyProviderFailure({ exitCode: 1, stderr: "503 service unavailable" }).kind, "server");
	assert.equal(classifyProviderFailure({ exitCode: 1, stderr: "context_length_exceeded" }).kind, "non_recoverable");
	assert.equal(classifyProviderFailure({ exitCode: 1, stderr: "tests failed in implementation" }).kind, "non_recoverable");
});

test("extracts only assistant provider errors rather than ordinary task text", () => {
	const ordinary = { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Updated authentication tests" }] } };
	assert.equal(classifyProviderFailure({ exitCode: 1, events: [ordinary] }).kind, "non_recoverable");
	const providerError = { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" } };
	assert.equal(classifyProviderFailure({ exitCode: 1, events: [providerError] }).kind, "rate_limit");
});

test("provider cooldowns expire deterministically", () => {
	const cooldowns = new ProviderCooldowns();
	cooldowns.mark("limited", 1_000, 10_000);
	assert.equal(cooldowns.available("limited", 10_999), false);
	assert.equal(cooldowns.available("limited", 11_000), true);
	assert.equal(cooldowns.available("other", 10_000), true);
});
