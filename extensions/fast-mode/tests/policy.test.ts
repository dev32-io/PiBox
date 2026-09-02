import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@earendil-works/pi-ai";
import {
	DEFAULT_FAST_MODE_POLICY,
	normalizeFastModePolicy,
	isChatGptFastEligible,
	parseFastModeStatus,
	projectFastModeStatus,
	serializeFastModeStatus,
	subagentFastEnabled,
	withFastServiceTier,
} from "../policy.js";

function model(provider: string, api: string, id: string): Model<any> {
	return { provider, api, id } as Model<any>;
}

const eligible = model("openai-codex", "openai-codex-responses", "gpt-5.6-luna");

test("normalizes only complete session policies", () => {
	assert.deepEqual(normalizeFastModePolicy({ main: true, subagents: "medium" }), { main: true, subagents: "medium" });
	assert.equal(normalizeFastModePolicy({ main: "yes", subagents: "medium" }), undefined);
	assert.equal(normalizeFastModePolicy({ main: true, subagents: "local" }), undefined);
	assert.equal(normalizeFastModePolicy(undefined), undefined);
	assert.deepEqual(DEFAULT_FAST_MODE_POLICY, { main: false, subagents: "off" });
});

test("applies subagent ceilings to capability tiers without treating local as ordered", () => {
	assert.equal(subagentFastEnabled("off", "low"), false);
	assert.equal(subagentFastEnabled("low", "low"), true);
	assert.equal(subagentFastEnabled("low", "medium"), false);
	assert.equal(subagentFastEnabled("medium", "low"), true);
	assert.equal(subagentFastEnabled("medium", "medium"), true);
	assert.equal(subagentFastEnabled("medium", "high"), false);
	assert.equal(subagentFastEnabled("max", "max"), true);
	assert.equal(subagentFastEnabled("max", "local"), false);
	assert.equal(subagentFastEnabled("max", "unknown"), false);
});

test("fast eligibility is restricted to advertised first-party ChatGPT Codex routes", () => {
	for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
		assert.equal(isChatGptFastEligible(model("openai-codex", "openai-codex-responses", id)), true, id);
	}
	assert.equal(isChatGptFastEligible(model("openai-codex", "openai-codex-responses", "gpt-5.3-codex-spark")), false);
	assert.equal(isChatGptFastEligible(model("openai-codex", "openai-codex-responses", "gpt-5.4-mini")), false);
	assert.equal(isChatGptFastEligible(model("openai", "openai-responses", "gpt-5.6-sol")), false);
	assert.equal(isChatGptFastEligible(model("proxy", "openai-codex-responses", "gpt-5.6-sol")), false);
});

test("injects priority service tier by copy only when effective and eligible", () => {
	const payload = { model: "gpt-5.6-luna", input: "hello", service_tier: "default" };
	const rewritten = withFastServiceTier(payload, true, eligible);
	assert.deepEqual(rewritten, { ...payload, service_tier: "priority" });
	assert.notEqual(rewritten, payload);
	assert.equal(withFastServiceTier(payload, false, eligible), undefined);
	assert.equal(withFastServiceTier(payload, true, model("anthropic", "anthropic-messages", "claude")), undefined);
	assert.equal(withFastServiceTier("payload", true, eligible), undefined);
});

test("round-trips bounded footer status and rejects malformed values", () => {
	const status = projectFastModeStatus({ main: true, subagents: "high" }, eligible);
	assert.deepEqual(status, { mainAvailable: true, mainEnabled: true, subagents: "high" });
	assert.deepEqual(parseFastModeStatus(serializeFastModeStatus(status)), status);
	assert.equal(parseFastModeStatus("{}"), undefined);
	assert.equal(parseFastModeStatus("not-json"), undefined);
	assert.deepEqual(projectFastModeStatus({ main: true, subagents: "off" }, model("anthropic", "anthropic-messages", "claude")), {
		mainAvailable: false,
		mainEnabled: false,
		subagents: "off",
	});
});
